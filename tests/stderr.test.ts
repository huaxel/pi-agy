import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
  MAX_STDERR_WARNING_CHARS,
  MAX_STDERR_WARNINGS,
  collectAgyWarnings,
} from "../extensions/lib/stderr.js";
import { isAgyAuthFailure, withAuthRecovery } from "../extensions/lib/auth.js";
import { spawnAgyStream } from "../extensions/lib/spawn.js";
import { resetModelCatalog, updateModelCatalog } from "../extensions/lib/cli.js";
import { AgyProviderDriver } from "../extensions/lib/provider-driver.js";
import { awaitWithWatchdog, withTimingFakeAgy } from "./timing-helpers.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "pi-agy-stderr-"));
}

let spawnedArgs: string[] | undefined;

describe("agy stderr warnings", () => {
  it("collects only warning lines, waiting for the rest of a partial one", () => {
    const seen = new Set<string>();
    const first = collectAgyWarnings("jetski: noise\nwarning: --mode plan has no eff", seen);
    assert.deepEqual(first.warnings, []);
    // Complete non-warning lines are dropped; only the partial line is kept.
    assert.equal(first.buffer, "warning: --mode plan has no eff");

    const nextBuffer = `${first.buffer}ect while expansion is disabled\nok\n`;
    const second = collectAgyWarnings(nextBuffer, seen);
    assert.deepEqual(second.warnings, [
      "warning: --mode plan has no effect while expansion is disabled",
    ]);
    assert.equal(second.buffer, "");
  });

  it("dedupes repeats, bounds length, and stops after the cap", () => {
    const seen = new Set<string>();
    const repeated = collectAgyWarnings("warning: same\nwarning: same\n", seen);
    assert.deepEqual(repeated.warnings, ["warning: same"]);

    const long = collectAgyWarnings(`warning: ${"x".repeat(1_000)}\n`, seen);
    assert.equal(long.warnings[0]?.length, MAX_STDERR_WARNING_CHARS);
    assert.ok(long.warnings[0]?.endsWith("…"));

    const many = collectAgyWarnings(
      Array.from({ length: 20 }, (_, index) => `warning: distinct ${index}`).join("\n") + "\n",
      new Set<string>(),
    );
    assert.equal(many.warnings.length, MAX_STDERR_WARNINGS);
  });

  it("keeps the cap for warnings, not for the one-shot sign-in marker", () => {
    const seen = new Set<string>();
    const signIn = collectAgyWarnings("Error: authentication required. Run 'agy' to log in, then retry.\n", seen, 2);
    assert.equal(signIn.authRequired, true);
    // Two warnings still fit under a limit of two: the marker is not a warning.
    const both = collectAgyWarnings("warning: first\nwarning: second\n", seen, 2);
    assert.deepEqual(both.warnings, ["warning: first", "warning: second"]);
    const over = collectAgyWarnings("warning: third\n", seen, 2);
    assert.deepEqual(over.warnings, []);
  });

  it("reports a warning from a delegated run as status, not activity", async () => {
    await withTimingFakeAgy(
      { onSpawn: (_args, child) => { Object.assign(child, { stdin: new PassThrough() }); } },
      async (children) => {
        const dir = await tempDir();
        const progress: Array<{ message: string; kind?: string }> = [];
        // Alias resolution needs a catalog; no model id is hardcoded in prod.
        updateModelCatalog({ "flash-medium": "gemini-3.8-flash-medium" });
        const run = spawnAgyStream(
          { prompt: "do the thing", mode: "plan", dir, timeout_ms: 30_000 },
          new AbortController().signal,
          (message, kind) => progress.push({ message, kind }),
        ).finally(() => resetModelCatalog());
        await Promise.resolve();
        const child = [...children][0]!;
        child.stderr.write("warning: --mode plan has no effect while expansion is disabled\n");
        child.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok" } }) + "\n");
        child.close(0);
        const result = await awaitWithWatchdog(run, "delegated run");
        assert.equal(result.response, "ok");
        const warning = progress.find((entry) => entry.message.includes("--mode plan has no effect"));
        assert.ok(warning, `warning missing from progress: ${JSON.stringify(progress)}`);
        assert.equal(warning!.kind, "status", "a warning must not count as real work");
      },
    );
  });

  it("keeps provider transcript text literal when it looks like a command", async () => {
    await withTimingFakeAgy(
      {
        onSpawn: (args, child) => {
          Object.assign(child, { stdin: new PassThrough() });
          if (args[0] !== "--add-dir") return;
          spawnedArgs = [...args];
        },
      },
      async (children) => {
        const dir = await tempDir();
        const driver = new AgyProviderDriver({ idleMs: 60_000 });
        try {
          const turn = driver.turn(
            { dir, fullModel: "gemini-3.8-flash", effort: "medium", skipPermissions: false },
            {
              prompt: "/help",
              signal: new AbortController().signal,
              timeoutMs: 30_000,
            },
          );
          await Promise.resolve();
          const child = [...children][0]!;
          child.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok" } }) + "\n");
          await awaitWithWatchdog(turn, "provider turn");
          // agy 1.5.13 rejects a command-shaped stream-json turn unless
          // expansion is disabled, so this flag is the difference between a
          // model answer and "unavailable with --input-format stream-json".
          assert.ok(spawnedArgs?.includes("--disable-slash-commands"));
          assert.ok(spawnedArgs?.includes("--input-format"));
        } finally {
          await driver.close();
        }
      },
    );
  });

  it("adds subagent counts to a provider activity label", async () => {
    await withTimingFakeAgy(
      { onSpawn: (_args, child) => { Object.assign(child, { stdin: new PassThrough() }); } },
      async (children) => {
        const dir = await tempDir();
        const activity: string[] = [];
        const driver = new AgyProviderDriver({ idleMs: 60_000 });
        try {
          const turn = driver.turn(
            { dir, fullModel: "gemini-3.8-flash", effort: "medium", skipPermissions: false },
            {
              prompt: "research this",
              signal: new AbortController().signal,
              timeoutMs: 30_000,
              onActivity: (label) => activity.push(label),
            },
          );
          await Promise.resolve();
          const child = [...children][0]!;
          const step = (state: string) =>
            JSON.stringify({
              event: "step_update",
              step_update: {
                step_index: 1,
                state,
                step_type: "subagent",
                tool_name: "invoke_subagent",
                subagent_info: { subagents: [{ name: "scout", type_name: "research" }] },
              },
            }) + "\n";
          child.stdout.write(step("ACTIVE"));
          child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"ok"}}\n');
          await awaitWithWatchdog(turn, "subagent turn");
          const label = activity.find((entry) => entry.includes("subagent"));
          assert.ok(label, `no subagent label in ${JSON.stringify(activity)}`);
          assert.match(label!, /1\/1 subagents/);
        } finally {
          await driver.close();
        }
      },
    );
  });

  it("reports a warning from a provider turn as activity", async () => {
    await withTimingFakeAgy(
      { onSpawn: (_args, child) => { Object.assign(child, { stdin: new PassThrough() }); } },
      async (children) => {
        const dir = await tempDir();
        const activity: string[] = [];
        const driver = new AgyProviderDriver({ idleMs: 60_000 });
        try {
          const turn = driver.turn(
            { dir, fullModel: "gemini-3.8-flash", effort: "medium", skipPermissions: false },
            {
              prompt: "hello",
              signal: new AbortController().signal,
              timeoutMs: 30_000,
              onActivity: (label) => activity.push(label),
            },
          );
          await Promise.resolve();
          const child = [...children][0]!;
          child.stderr.write("warning: --mode auto is not available for this account\n");
          child.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "hi" } }) + "\n");
          const end = await awaitWithWatchdog(turn, "provider turn");
          assert.equal(end.kind, "done");
          assert.ok(
            activity.some((label) => label.includes("--mode auto is not available")),
            `warning missing from activity: ${JSON.stringify(activity)}`,
          );
        } finally {
          await driver.close();
        }
      },
    );
  });

  it("recognizes a sign-in prompt once and never echoes the OAuth URL", () => {
    const seen = new Set<string>();
    const chunk =
      "Authentication required. Please visit the URL to log in:\n" +
      "  https://accounts.google.com/o/oauth2/auth?state=secret\n" +
      "Waiting for authentication (timeout 5m)\n";
    const first = collectAgyWarnings(chunk, seen);
    assert.equal(first.authRequired, true);
    assert.deepEqual(first.warnings, [], "the URL must not be treated as a warning");
    const second = collectAgyWarnings(chunk, seen);
    assert.equal(second.authRequired, false, "repeats are reported once per run");
  });

  it("maps the captured unauthenticated shapes to one recovery", () => {
    for (const text of [
      "authentication failed or timed out",
      "Error: authentication required. Run 'agy' to log in, then retry.",
      "Authentication required. Please visit the URL to log in:",
    ]) {
      assert.equal(isAgyAuthFailure(text), true, text);
    }
    assert.equal(isAgyAuthFailure("agy reported terminal status FAILED"), false);
    const recovered = withAuthRecovery("agy reported terminal status ERROR: authentication failed or timed out");
    assert.match(recovered, /not signed in/);
    assert.match(recovered, /agy said:/, "the original detail must survive");
    assert.equal(withAuthRecovery("plain failure"), "plain failure");
  });

  it("fails a signed-out delegation fast with sign-in guidance", async () => {
    await withTimingFakeAgy(
      { onSpawn: (_args, child) => { Object.assign(child, { stdin: new PassThrough() }); } },
      async (children) => {
        const dir = await tempDir();
        const progress: string[] = [];
        updateModelCatalog({ "flash-medium": "gemini-3.8-flash-medium" });
        const run = spawnAgyStream(
          { prompt: "do the thing", mode: "plan", dir, timeout_ms: 60_000 },
          new AbortController().signal,
          (message) => progress.push(message),
        ).finally(() => resetModelCatalog());
        await Promise.resolve();
        const child = [...children][0]!;
        child.stderr.write("Error: authentication required. Run 'agy' to log in, then retry.\n");
        const error = await awaitWithWatchdog(
          run.then(
            () => { throw new Error("a signed-out run must not resolve"); },
            (reason: Error) => reason,
          ),
          "sign-in failure",
        );
        assert.match(error.message, /not signed in/);
        assert.match(error.message, /finish the browser sign-in/);
        assert.ok(child.killRequested, "the waiting child must be stopped");
        assert.ok(progress.some((line) => line.includes("authentication required")));
      },
    );
  });

  it("fails a signed-out provider turn fast instead of waiting", async () => {
    await withTimingFakeAgy(
      { onSpawn: (_args, child) => { Object.assign(child, { stdin: new PassThrough() }); } },
      async (children) => {
        const dir = await tempDir();
        const activity: string[] = [];
        const driver = new AgyProviderDriver({ idleMs: 60_000, inactivityMs: 30_000 });
        try {
          const turn = driver.turn(
            { dir, fullModel: "gemini-3.8-flash", effort: "medium", skipPermissions: false },
            {
              prompt: "hi",
              signal: new AbortController().signal,
              timeoutMs: 60_000,
              onActivity: (label) => activity.push(label),
            },
          );
          await Promise.resolve();
          const child = [...children][0]!;
          child.stderr.write("Error: authentication required. Run 'agy' to log in, then retry.\n");
          const error = await awaitWithWatchdog(
            turn.then(
              () => { throw new Error("a signed-out turn must not resolve"); },
              (reason: Error) => reason,
            ),
            "sign-in failure",
          );
          assert.match(error.message, /not signed in/);
          assert.ok(activity.some((label) => label.includes("authentication required")));
          assert.equal(driver.snapshot().state, "dead");
        } finally {
          await driver.close();
        }
      },
    );
  });
});
