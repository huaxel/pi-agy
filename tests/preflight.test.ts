import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { resetPreflightCache, runPreflight } from "../extensions/lib/preflight.js";
import { readFakeAgyArgs, withFakeAgy } from "./helpers.js";

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
    await withSlowModelsFake(10, async () => {
      resetPreflightCache();
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-preflight-"));
      const started = Date.now();
      await assert.rejects(
        runPreflight(dir, undefined, 12_000),
        /timed out/,
      );
      assert.ok(
        Date.now() - started < 15_000,
        "health retry exceeded the overall preflight timeout",
      );
    });
  });
});
