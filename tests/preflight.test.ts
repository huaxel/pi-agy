import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, mock } from "node:test";

import { resetPreflightCache, runPreflight } from "../extensions/lib/preflight.js";
import { readFakeAgyArgs, withFakeAgy } from "./helpers.js";
import { awaitNativeTurn, awaitWithWatchdog, withTimingFakeAgy, type FakeChild } from "./timing-helpers.js";

/**
 * Fake agy with a stateful `models` probe: sleeps past the 10s preflight
 * cap `slowCalls` times, then answers instantly. Models the cold-start
 * OAuth stampede (first parallel probes time out, retry lands warm).
 */
async function withSlowModelsFake<T>(
  slowCalls: number,
  fn: () => Promise<T>,
): Promise<T> {
  const bin = await mkdtemp(path.join(os.tmpdir(), "pi-agy-preflight-bin-"));
  await writeFile(
    path.join(bin, "agy"),
    `#!/usr/bin/env bash
set -eu
dir="$(cd "$(dirname "$0")" && pwd)"
case "$1" in
  --version) echo "agy 1.2.0" ;;
  models)\n    n=$(cat "$dir/models-count" 2>/dev/null || echo 0)\n    echo $((n + 1)) > "$dir/models-count"\n    if [ "$n" -lt ${slowCalls} ]; then sleep 12; fi\n    printf 'gemini-3.8-flash-medium\\tGemini 3.8 Flash (Medium)\\n'\n    ;;\n  --output-format)\n    echo '{}'\n    echo\n    ;;\n  *)\n    printf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}'\n    ;;\nesac\n`,
  );
  await chmod(path.join(bin, "agy"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  try {
    return await fn();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
}

describe("preflight cold-start retry", () => {
  it("retries timed-out health probes once and succeeds warm", async () => {
    await withSlowModelsFake(1, async () => {
      resetPreflightCache();
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-preflight-"));
      const started = Date.now();
      const quota = await runPreflight(dir, undefined, 60_000);
      // First models attempt burns the ~10s probe cap; the retry is fast.
      assert.ok(Date.now() - started >= 9_000, "expected the first attempt to time out");
      assert.ok(quota, "expected a quota snapshot");
    });
  });

  it("fails after one retry when probes stay slow", async () => {
    await withSlowModelsFake(10, async () => {
      resetPreflightCache();
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-preflight-"));
      await assert.rejects(
        runPreflight(dir, undefined, 60_000),
        /timed out/,
      );
    });
  });

  it("caches per directory: warm repeats skip probes, new dirs probe fresh", async () => {
    const modelsOutput = "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n";
    await withFakeAgy(
      "{}",
      async (bin) => {
        resetPreflightCache();
        const dirA = await mkdtemp(path.join(os.tmpdir(), "pi-agy-preflight-a-"));
        const dirB = await mkdtemp(path.join(os.tmpdir(), "pi-agy-preflight-b-"));
        const invocations = async () => (await readFakeAgyArgs(bin)).length;
        await runPreflight(dirA, undefined, 60_000);
        const cold = await invocations();
        assert.ok(cold > 0, "expected cold preflight to spawn probes");
        await runPreflight(dirA, undefined, 60_000);
        assert.equal(await invocations(), cold, "same directory should hit the cache");
        await runPreflight(dirB, undefined, 60_000);
        assert.ok(
          (await invocations()) > cold,
          "a new directory must not reuse another directory's snapshot",
        );
      },
      0,
      0,
      "",
      "",
      "{}",
      0,
      modelsOutput,
    );
  });

  it("keeps the health retry inside the remaining timeout budget", async () => {
    resetPreflightCache();
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-preflight-"));
    let modelAttempts = 0;
    let firstAttempt!: () => void;
    let secondAttempt!: () => void;
    let firstClosed!: () => void;
    let firstChild: FakeChild | undefined;
    let secondChild: FakeChild | undefined;
    const first = new Promise<void>((resolve) => { firstAttempt = resolve; });
    const second = new Promise<void>((resolve) => { secondAttempt = resolve; });
    const closed = new Promise<void>((resolve) => { firstClosed = resolve; });
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
    try {
      await withTimingFakeAgy({
        hangModels: true,
        onSpawn: (args, child) => {
          if (args[0] !== "models") return;
          modelAttempts++;
          if (modelAttempts === 1) firstChild = child;
          if (modelAttempts === 2) secondChild = child;
          if (modelAttempts === 1) firstAttempt();
          if (modelAttempts === 2) secondAttempt();
        },
        onClose: (args) => {
          if (args[0] === "models" && modelAttempts === 1) firstClosed();
        },
      }, async (_children, signal, track) => {
        const pending = track(runPreflight(dir, signal, 12_000));
        let settled = false;
        const outcome = pending.then(
          () => { settled = true; return { status: "fulfilled" as const }; },
          (error: unknown) => { settled = true; return { status: "rejected" as const, error }; },
        );
        await awaitWithWatchdog(first, "first preflight attempt");
        assert.equal(firstChild?.killRequested, false);
        mock.timers.tick(10_000);
        assert.equal(firstChild?.killRequested, true);
        await awaitWithWatchdog(closed, "first preflight close");
        await awaitWithWatchdog(second, "retry preflight attempt");
        mock.timers.tick(1_999);
        await awaitNativeTurn("preflight pending-state turn");
        assert.equal(Date.now(), 12_999);
        assert.equal(secondChild?.killRequested, false);
        assert.equal(settled, false, "runPreflight must still be pending at 11,999ms");
        mock.timers.tick(1);
        assert.equal(secondChild?.killRequested, true);
        const final = await awaitWithWatchdog(outcome, "preflight completion");
        assert.equal(final.status, "rejected");
        if (final.status === "rejected") assert.match(String(final.error), /timed out/i);
        assert.equal(modelAttempts, 2, "the remaining 1ms expires the one retry without a third attempt");
      });
    } finally {
      mock.timers.reset();
      resetPreflightCache();
    }
  });

  it("does not spawn a retry after deadline-timeout cleanup consumes the remainder", async () => {
    resetPreflightCache();
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-preflight-exhausted-"));
    let modelAttempts = 0;
    let firstAttempt!: () => void;
    let firstChild: FakeChild | undefined;
    const first = new Promise<void>((resolve) => { firstAttempt = resolve; });
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
    try {
      await withTimingFakeAgy({
        hangModels: true,
        killCloseDelayMs: 2_000,
        onSpawn: (args, child) => {
          if (args[0] === "models") {
            firstChild = child;
            modelAttempts++;
            firstAttempt();
          }
        },
      }, async (_children, signal, track) => {
        const pending = track(runPreflight(dir, signal, 12_000));
        let settled = false;
        const outcome = pending.then(
          () => { settled = true; return { status: "fulfilled" as const }; },
          (error: unknown) => { settled = true; return { status: "rejected" as const, error }; },
        );
        await awaitWithWatchdog(first, "first exhausted attempt");
        assert.equal(firstChild?.killRequested, false);
        mock.timers.tick(10_000);
        assert.equal(firstChild?.killRequested, true);
        mock.timers.tick(1_999);
        await awaitNativeTurn("exhausted preflight pending turn");
        assert.equal(modelAttempts, 1, "delayed close must not create a retry before deadline");
        assert.equal(settled, false, "cleanup delay must leave the preflight pending before deadline");
        mock.timers.tick(1);
        const final = await awaitWithWatchdog(outcome, "exhausted preflight");
        assert.equal(final.status, "rejected");
        if (final.status === "rejected") assert.match(String(final.error), /timed out/i);
        assert.equal(modelAttempts, 1, "an exhausted deadline must spawn no second probe");
      });
    } finally {
      mock.timers.reset();
      resetPreflightCache();
    }
  });
});
