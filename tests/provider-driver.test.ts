import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import { awaitWithWatchdog, nativeSetTimeout } from "./timing-helpers.js";
import {
  AgyProviderDriver,
  type DriverTurnEnd,
  type ProviderDriverOutcome,
  type ProviderDriverProfile,
} from "../extensions/lib/provider-driver.js";

const profile: ProviderDriverProfile = {
  dir: "",
  fullModel: "gemini-3.8-flash",
  effort: "medium",
  skipPermissions: false,
};

function turnOptions(overrides: Record<string, unknown> = {}) {
  return {
    prompt: "hello",
    signal: new AbortController().signal,
    timeoutMs: 15_000,
    ...overrides,
  };
}

interface FakeControls {
  bin: string;
  setMode: (mode: string) => Promise<void>;
  setResponse: (text: string) => Promise<void>;
  setStatus: (status: string) => Promise<void>;
  setStartupDelay: (seconds: string) => Promise<void>;
  spawnCount: () => Promise<number>;
}

/**
 * Persistent fake agy: stays alive across stdin lines, answering every turn
 * with a result envelope. Behavior scripts via control files:
 * mode=normal|hang|crash|ready-empty|ready-text, response=text, status=SUCCESS|FAILED.
 */
async function withPersistentFakeAgy<T>(fn: (controls: FakeControls) => Promise<T>): Promise<T> {
  const bin = await mkdtemp(path.join(os.tmpdir(), "pi-agy-driver-bin-"));
  await writeFile(
    path.join(bin, "agy"),
    `#!/usr/bin/env bash
set -eu
dir="$(cd "$(dirname "$0")" && pwd)"
printf '%s\\n' "$@" > "$dir/args-$(date +%s%N)-$$"
resume=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--conversation" ]; then resume="$a"; fi
  prev="$a"
done
startup_delay=$(cat "$dir/startup-delay" 2>/dev/null || echo 0)
if [ "$startup_delay" != 0 ]; then sleep "$startup_delay"; fi
count=$(cat "$dir/spawns" 2>/dev/null || echo 0)
echo $((count + 1)) > "$dir/spawns"
mode=$(cat "$dir/mode" 2>/dev/null || echo normal)
if [ "$mode" = "crash" ]; then echo "fake agy crashed" >&2; exit 3; fi
n=0
while IFS= read -r _line; do
  n=$((n + 1))
  printf '%s\\n' '{"event":"init","init":{"model":"fake"}}'
  if [ "$mode" = "hang" ] || [ "$mode" = "ready-empty" ]; then continue; fi
  if [ "$mode" = "ready-text" ]; then
    printf '%s\\n' "{\\"event\\":\\"step_update\\",\\"step_update\\":{\\"step_type\\":\\"agent_response\\",\\"text_delta\\":\\"live-$n \\"}}"
    continue
  fi
  if [ "$mode" = "slow" ]; then sleep 2; fi
  printf '%s\\n' "{\\"event\\":\\"step_update\\",\\"step_update\\":{\\"step_type\\":\\"agent_response\\",\\"text_delta\\":\\"live-$n \\"}}"
  text=$(cat "$dir/response" 2>/dev/null || echo "turn-response")
  status=$(cat "$dir/status" 2>/dev/null || echo SUCCESS)
  if [ -n "$resume" ]; then cid="$resume"; else cid="conv-$n"; fi
  printf '%s\\n' "{\\"event\\":\\"result\\",\\"result\\":{\\"status\\":\\"$status\\",\\"response\\":\\"$text\\",\\"conversation_id\\":\\"$cid\\"}}"
done
`,
  );
  await chmod(path.join(bin, "agy"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  const controls: FakeControls = {
    bin,
    setMode: (mode) => writeFile(path.join(bin, "mode"), mode),
    setResponse: (text) => writeFile(path.join(bin, "response"), text),
    setStatus: (status) => writeFile(path.join(bin, "status"), status),
    setStartupDelay: (seconds) => writeFile(path.join(bin, "startup-delay"), seconds),
    spawnCount: async () => Number(await readFile(path.join(bin, "spawns"), "utf8").catch(() => "0")),
  };
  try {
    return await fn(controls);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
}

const drivers: AgyProviderDriver[] = [];
afterEach(async () => {
  while (drivers.length > 0) await drivers.pop()!.close();
});

function track(driver: AgyProviderDriver): AgyProviderDriver {
  drivers.push(driver);
  return driver;
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "pi-agy-driver-dir-"));
}

function expectDone(end: DriverTurnEnd): ProviderDriverOutcome {
  assert.equal(end.kind, "done");
  if (end.kind !== "done") throw new Error("expected done");
  return end.outcome;
}

describe("provider cancelled resume settlement", () => {
  it("rejects an empty pre-aborted resume promptly", async () => {
    await withPersistentFakeAgy(async (controls) => {
      await controls.setMode("ready-empty");
      const driver = track(new AgyProviderDriver());
      const dir = await tempDir();
      let ready!: () => void;
      const readySignal = new Promise<void>((resolve) => { ready = resolve; });
      const pending = driver.turn(
        { ...profile, dir },
        turnOptions({ onActivity: (label: string) => label === "agy: session started (fake)" && ready() }),
      );
      void pending.catch(() => undefined);
      await awaitWithWatchdog(readySignal, "empty resume readiness");
      assert.equal(driver.notifyPark({ callId: "empty", toolName: "read", args: {} }), true);
      const parked = await pending;
      assert.equal(parked.kind, "parked");
      const resumed = driver.continueTurn({ signal: AbortSignal.abort(), timeoutMs: 100 });
      await assert.rejects(awaitWithWatchdog(resumed, "empty pre-aborted resume"), /cancelled/);
    });
  });

  it("ignores an obsolete previous-phase signal after rebinding", async () => {
    await withPersistentFakeAgy(async (controls) => {
      await controls.setMode("ready-text");
      const driver = track(new AgyProviderDriver());
      const dir = await tempDir();
      const oldSignal = new AbortController();
      let firstText!: () => void;
      const firstReady = new Promise<void>((resolve) => { firstText = resolve; });
      const pending = driver.turn(
        { ...profile, dir },
        turnOptions({ signal: oldSignal.signal, onText: () => firstText() }),
      );
      void pending.catch(() => undefined);
      await awaitWithWatchdog(firstReady, "initial text readiness");
      assert.equal(driver.notifyPark({ callId: "stale", toolName: "read", args: {} }), true);
      await pending;
      const newSignal = new AbortController();
      const resumed = driver.continueTurn({ signal: newSignal.signal });
      oldSignal.abort();
      assert.equal(driver.snapshot().state, "running");
      newSignal.abort();
      const end = await awaitWithWatchdog(resumed, "rebinding cancellation");
      assert.equal(expectDone(end).aborted, true);
    });
  });

  it("settles partial text for a pre-aborted resume and keeps later turns usable", async () => {
    await withPersistentFakeAgy(async (controls) => {
      await controls.setMode("ready-text");
      const driver = track(new AgyProviderDriver());
      const dir = await tempDir();
      let textReady!: () => void;
      const text = new Promise<void>((resolve) => { textReady = resolve; });
      const pending = driver.turn(
        { ...profile, dir },
        turnOptions({ onText: () => textReady() }),
      );
      void pending.catch(() => undefined);
      await awaitWithWatchdog(text, "partial resume text readiness");
      assert.equal(driver.notifyPark({ callId: "partial", toolName: "read", args: {} }), true);
      await pending;
      const resumed = driver.continueTurn({ signal: AbortSignal.abort(), timeoutMs: 100 });
      const partial = await awaitWithWatchdog(resumed, "partial pre-aborted resume");
      assert.equal(partial.kind, "done");
      if (partial.kind !== "done") throw new Error("expected partial completion");
      assert.equal(partial.outcome.aborted, true);
      assert.equal(partial.outcome.text, "live-1 ");
      await controls.setMode("normal");
      const next = await awaitWithWatchdog(driver.turn({ ...profile, dir }, turnOptions()), "post-cancel fresh turn");
      const nextOutcome = expectDone(next);
      assert.equal(nextOutcome.text, "turn-response");
      const nextConversationId = nextOutcome.conversationId;
      const nextPid = driver.snapshot().pid;
      assert.equal(driver.snapshot().state, "idle");
      assert.ok(nextPid !== undefined);
      assert.equal(await controls.spawnCount(), 2);
      await awaitWithWatchdog(new Promise<void>((resolve) => nativeSetTimeout(resolve, 150)), "cancelled resume late-timeout observation", 500);
      assert.equal(driver.snapshot().state, "idle");
      assert.equal(driver.snapshot().pid, nextPid);
      const reused = await awaitWithWatchdog(
        driver.turn({ ...profile, dir }, turnOptions({ resumeConversationId: nextConversationId })),
        "bound conversation reuse after late timeout",
      );
      assert.equal(expectDone(reused).text, "turn-response");
      assert.equal(await controls.spawnCount(), 2);
    });
  });
});

describe("persistent provider driver", () => {
  it("reuses one process when resuming the bound conversation", async () => {
    await withPersistentFakeAgy(async (controls) => {
      const driver = track(new AgyProviderDriver());
      const dir = await tempDir();
      const first = await driver.turn({ ...profile, dir }, turnOptions({ prompt: "one" }));
      assert.deepEqual([expectDone(first).text, expectDone(first).conversationId], ["turn-response", "conv-1"]);
      assert.equal(driver.snapshot().boundConversationId, "conv-1");
      const second = await driver.turn(
        { ...profile, dir },
        turnOptions({ prompt: "two", resumeConversationId: "conv-1" }),
      );
      assert.equal(expectDone(second).text, "turn-response");
      // Same process continues natively; the script fake numbers the
      // continuation conv-2 (a real agy would keep conv-1).
      assert.equal(expectDone(second).conversationId, "conv-2");
      assert.equal(await controls.spawnCount(), 1);
      const snapshot = driver.snapshot();
      assert.equal(snapshot.stats.spawns, 1);
      assert.equal(snapshot.stats.turns, 2);
      assert.equal(snapshot.stats.reuses, 1);
    });
  });

  it("starts a new process for a fresh turn after a bound conversation", async () => {
    await withPersistentFakeAgy(async (controls) => {
      const driver = track(new AgyProviderDriver());
      const dir = await tempDir();
      await driver.turn({ ...profile, dir }, turnOptions({ prompt: "one" }));
      // A fresh turn must not inherit the previous agy-side conversation.
      await driver.turn({ ...profile, dir }, turnOptions({ prompt: "two" }));
      assert.equal(await controls.spawnCount(), 2);
      assert.equal(driver.snapshot().stats.lastRecycleReason, "conversation-changed");
    });
  });

  it("recycles when the model changes", async () => {
    await withPersistentFakeAgy(async (controls) => {
      const driver = track(new AgyProviderDriver());
      const dir = await tempDir();
      await driver.turn({ ...profile, dir }, turnOptions());
      await driver.turn({ ...profile, dir, fullModel: "claude-sonnet-4-6", effort: undefined }, turnOptions());
      assert.equal(await controls.spawnCount(), 2);
      assert.equal(driver.snapshot().stats.lastRecycleReason, "model-changed");
    });
  });

  it("recycles when the requested conversation changes, reuses when it matches", async () => {
    await withPersistentFakeAgy(async (controls) => {
      const driver = track(new AgyProviderDriver());
      const dir = await tempDir();
      await driver.turn({ ...profile, dir }, turnOptions({ resumeConversationId: "conv-9" }));
      assert.equal(driver.snapshot().boundConversationId, "conv-9");
      await driver.turn({ ...profile, dir }, turnOptions({ resumeConversationId: "conv-9" }));
      assert.equal(await controls.spawnCount(), 1);
      await driver.turn({ ...profile, dir }, turnOptions({ resumeConversationId: "conv-other" }));
      assert.equal(await controls.spawnCount(), 2);
      assert.equal(driver.snapshot().stats.lastRecycleReason, "conversation-changed");
    });
  });

  it("serializes concurrent turns in order", async () => {
    await withPersistentFakeAgy(async (controls) => {
      const driver = track(new AgyProviderDriver());
      const dir = await tempDir();
      const [first, second] = await Promise.all([
        driver.turn({ ...profile, dir }, turnOptions({ prompt: "first" })),
        driver.turn({ ...profile, dir }, turnOptions({ prompt: "second", resumeConversationId: "conv-1" })),
      ]);
      assert.equal(expectDone(first).conversationId, "conv-1");
      assert.equal(expectDone(second).conversationId, "conv-2");
      assert.equal(await controls.spawnCount(), 1);
    });
  });

  it("close() rejects the active turn and queued turns", async () => {
    await withPersistentFakeAgy(async (controls) => {
      await controls.setMode("hang");
      const driver = track(new AgyProviderDriver());
      const dir = await tempDir();
      const hanging = driver.turn({ ...profile, dir }, turnOptions({ prompt: "stuck" }));
      const queued = driver.turn({ ...profile, dir }, turnOptions({ prompt: "queued" }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      await driver.close();
      await assert.rejects(hanging, /driver was closed/);
      await assert.rejects(queued, /driver was closed/);
      assert.equal(driver.snapshot().state, "dead");
    });
  });

  it("streams live text deltas during the turn", async () => {
    await withPersistentFakeAgy(async () => {
      const driver = track(new AgyProviderDriver());
      const dir = await tempDir();
      const seen: string[] = [];
      const outcome = await driver.turn(
        { ...profile, dir },
        turnOptions({ onText: (delta: string) => seen.push(delta) }),
      );
      // Live agent_response deltas stream first; the terminal response stays
      // authoritative for the final text.
      assert.deepEqual(seen, ["live-1 "]);
      assert.equal(expectDone(outcome).text, "turn-response");
    });
  });

  it("caps an oversized authoritative terminal response", async () => {
    await withPersistentFakeAgy(async (controls) => {
      await controls.setResponse("x".repeat(512_001));
      const driver = track(new AgyProviderDriver());
      const outcome = expectDone(await driver.turn({ ...profile, dir: await tempDir() }, turnOptions()));
      assert.equal(outcome.text.length, 512_000);
      assert.equal(outcome.truncated, true);
    });
  });

  it("abort kills the child and the next turn respawns", async () => {
    await withPersistentFakeAgy(async (controls) => {
      await controls.setMode("hang");
      // Delay launch enough to prove a wall-clock abort can precede the fake's
      // spawn counter; cancellation is gated on the driver's init activity.
      await controls.setStartupDelay("0.6");
      const driver = track(new AgyProviderDriver());
      const dir = await tempDir();
      const controller = new AbortController();
      let initReady!: () => void;
      const init = new Promise<void>((resolve) => { initReady = resolve; });
      try {
        const pending = driver.turn(
          { ...profile, dir },
          turnOptions({
            signal: controller.signal,
            onActivity: (label: string) => {
              if (label === "agy: session started (fake)") initReady();
            },
          }),
        );
        // Attach rejection handling before waiting for readiness so an early
        // driver failure cannot become an unhandled rejection.
        const cancelled = assert.rejects(pending, /cancelled/);
        await awaitWithWatchdog(init, "driver init readiness", 5_000);
        controller.abort();
        await cancelled;
        await controls.setMode("normal");
        const next = await driver.turn({ ...profile, dir }, turnOptions());
        assert.equal(expectDone(next).text, "turn-response");
        assert.equal(await controls.spawnCount(), 2);
      } finally {
        controller.abort();
        await driver.close();
      }
    });
  });

  it("timeout kills a hung turn with a clear error", async () => {
    await withPersistentFakeAgy(async (controls) => {
      await controls.setMode("hang");
      const driver = track(new AgyProviderDriver({ idleMs: 60_000 }));
      const dir = await tempDir();
      await assert.rejects(
        driver.turn({ ...profile, dir }, turnOptions({ timeoutMs: 400 })),
        /timed out/,
      );
      assert.equal(driver.snapshot().state, "dead");
    });
  });

  it("a crashing child fails the turn instead of hanging", async () => {
    await withPersistentFakeAgy(async (controls) => {
      await controls.setMode("crash");
      const driver = track(new AgyProviderDriver());
      const dir = await tempDir();
      await assert.rejects(driver.turn({ ...profile, dir }, turnOptions()), /crashed|exited mid-turn/);
      assert.equal(driver.snapshot().state, "dead");
    });
  });

  it("rejects terminal failure envelopes", async () => {
    await withPersistentFakeAgy(async (controls) => {
      await controls.setStatus("FAILED");
      const driver = track(new AgyProviderDriver());
      const dir = await tempDir();
      await assert.rejects(driver.turn({ ...profile, dir }, turnOptions()), /FAILED/);
    });
  });

  it("suspends on park and resumes with rebound callbacks", async () => {
    await withPersistentFakeAgy(async (controls) => {
      await controls.setMode("slow");
      const driver = track(new AgyProviderDriver());
      const dir = await tempDir();
      const seen: string[] = [];
      const pending = driver.turn(
        { ...profile, dir },
        turnOptions({ onText: (delta: string) => seen.push(`a:${delta}`) }),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(driver.notifyPark({ callId: "c1", toolName: "read", args: {} }), true);
      const parked = await pending;
      assert.equal(parked.kind, "parked");
      if (parked.kind !== "parked") throw new Error("expected parked");
      assert.equal(parked.park.callId, "c1");
      // Second park while suspended is refused.
      assert.equal(driver.notifyPark({ callId: "c2", toolName: "read", args: {} }), false);
      // Resume rebinds callbacks to the new turn: deltas after the park
      // reach the new consumer, not the dead stream.
      const resumed = driver.continueTurn({ onText: (delta: string) => seen.push(`b:${delta}`) });
      const end = await resumed;
      assert.equal(end.kind, "done");
      assert.deepEqual(seen, ["b:live-1 "]);
      if (end.kind !== "done") throw new Error("expected done");
      assert.equal(end.outcome.text, "turn-response");
    });
  });

  it("refuses fresh turns while suspended", async () => {
    await withPersistentFakeAgy(async (controls) => {
      await controls.setMode("hang");
      const driver = track(new AgyProviderDriver());
      const dir = await tempDir();
      const pending = driver.turn({ ...profile, dir }, turnOptions());
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(driver.notifyPark({ callId: "c1", toolName: "read", args: {} }), true);
      await pending;
      await assert.rejects(
        driver.turn({ ...profile, dir }, turnOptions()),
        /suspended awaiting Pi tools/,
      );
      driver.cancelSuspended("test over");
      await controls.setMode("normal");
    });
  });

  it("recycles when the bridged tool catalog changes", async () => {
    await withPersistentFakeAgy(async (controls) => {
      const driver = track(new AgyProviderDriver());
      const dir = await tempDir();
      await driver.turn({ ...profile, dir, bridgeDir: "/tmp/bridge-a" }, turnOptions());
      await driver.turn({ ...profile, dir, bridgeDir: "/tmp/bridge-a", bridgeTools: "n2-h9" }, turnOptions());
      assert.equal(await controls.spawnCount(), 2);
      assert.equal(driver.snapshot().stats.lastRecycleReason, "tools-changed");
    });
  });

  it("reaps idle processes", async () => {
    await withPersistentFakeAgy(async (controls) => {
      const driver = track(new AgyProviderDriver({ idleMs: 150 }));
      const dir = await tempDir();
      await driver.turn({ ...profile, dir }, turnOptions());
      assert.equal(driver.snapshot().state, "idle");
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(driver.snapshot().state, "dead");
      await driver.turn({ ...profile, dir }, turnOptions());
      assert.equal(await controls.spawnCount(), 2);
    });
  });
});
