import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat as statFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const execAsync = promisify(execFile);

import {
  buildAgyArgs,
  buildAgyPrompt,
  isAgyModel,
  isTransientAgyFailure,
  parseModelCatalog,
  resetModelCatalog,
  resolveAgyModelId,
  updateModelCatalog,
} from "../extensions/lib/cli.js";
import { resolveAgyMode, truncate } from "../extensions/index.js";
import piAgyExtension from "../extensions/index.js";
import { registerAgyCommand } from "../extensions/commands.js";
import { executeAgyTask } from "../extensions/lib/execute.js";
import { resetPreflightCache } from "../extensions/lib/preflight.js";
import { withDirLock } from "../extensions/lib/lock.js";
import { detectVerifyCommand } from "../extensions/lib/verify.js";
import { summarizeGitDiff } from "../extensions/lib/postflight.js";
import { loadAgyConfig, resetDefaultModelCache, resolveDefaultModel } from "../extensions/lib/config.js";
import {
  accumulateRunResult,
  finalizeRunResult,
  formatStepProgress,
  parseStreamLine,
} from "../extensions/lib/stream.js";
import { parseJsonResponse } from "../extensions/lib/parse.js";
import { parseAgyCommandArgs } from "../extensions/commands.js";
import { conversationSummary, createSessionStore, getDefaultStorePath } from "../extensions/lib/sessions.js";
describe("session store", () => {
  it("uses PI_CODING_AGENT_DIR for the default store path", () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agy-custom-agent";
      assert.equal(
        getDefaultStorePath(),
        path.join("/tmp/pi-agy-custom-agent", "agy-sessions.json"),
      );
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  it("serializes concurrent updates and writes a private file", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-sessions-"));
    const store = createSessionStore(path.join(tmp, "agy-sessions.json"));

    await Promise.all([
      store.saveSession("/project-a", "conversation-a", "flash-medium"),
      store.saveSession("/project-b", "conversation-b", "sonnet"),
    ]);

    assert.equal((await store.getSession("/project-a"))?.last_conversation_id, "conversation-a");
    assert.equal((await store.getSession("/project-b"))?.last_conversation_id, "conversation-b");
    const mode = (await statFile(path.join(tmp, "agy-sessions.json"))).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("keeps a capped, most-recent-first history per directory", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-sessions-"));
    const store = createSessionStore(path.join(tmp, "agy-sessions.json"));

    await store.saveSession("/p", "c1", "flash-medium", undefined, undefined, "gsd-debugger");
    await store.saveSession("/p", "c2", "sonnet");
    await store.saveSession("/p", "c1", "flash-low", undefined, undefined, "gsd-debugger");

    const history = await store.getHistory("/p");
    assert.deepEqual(
      history.map((entry) => entry.conversation_id),
      ["c1", "c2"],
    );
    assert.equal(history[0].model, "flash-low");
    assert.equal(history[0].agent, "gsd-debugger");
    assert.equal((await store.getSession("/p"))?.last_agent, "gsd-debugger");

    for (let i = 0; i < 12; i++) await store.saveSession("/p", `extra-${i}`);
    assert.equal((await store.getHistory("/p")).length, 10);
  });

  it("merges updates from independent store instances", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-sessions-"));
    const storePath = path.join(tmp, "agy-sessions.json");
    const stores = [createSessionStore(storePath), createSessionStore(storePath)];

    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        stores[i % stores.length].saveSession(`/project-${i}`, `conversation-${i}`),
      ),
    );

    for (let i = 0; i < 12; i++) {
      assert.equal(
        (await stores[0].getSession(`/project-${i}`))?.last_conversation_id,
        `conversation-${i}`,
      );
    }
  });

  it("ignores malformed history entries", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-sessions-"));
    const storePath = path.join(tmp, "agy-sessions.json");
    await writeFile(
      storePath,
      JSON.stringify({
        [path.resolve("/p")]: {
          history: [
            { conversation_id: 42 },
            null,
            { conversation_id: "ok", updated_at: "now", agent: "bad\nagent" },
          ],
        },
      }),
    );
    const store = createSessionStore(storePath);

    assert.deepEqual(await store.getHistory("/p"), [
      { conversation_id: "ok", updated_at: "now" },
    ]);
  });

  it("does not overwrite a corrupt session store", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-sessions-"));
    const storePath = path.join(tmp, "agy-sessions.json");
    await writeFile(storePath, "not json");
    const store = createSessionStore(storePath);

    await assert.rejects(store.saveSession("/p", "conversation"), /JSON/i);
    assert.equal(await readFile(storePath, "utf8"), "not json");
  });

  it("reads degrade gracefully on a corrupt session store", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-sessions-"));
    const storePath = path.join(tmp, "agy-sessions.json");
    await writeFile(storePath, "not json");
    const store = createSessionStore(storePath);

    assert.equal(await store.getSession("/p"), undefined);
    assert.deepEqual(await store.getHistory("/p"), []);
  });

  it("reads degrade gracefully on a valid-shaped but wrong-typed store", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-sessions-"));
    const storePath = path.join(tmp, "agy-sessions.json");
    await writeFile(storePath, JSON.stringify(["not", "a", "store"]));
    const store = createSessionStore(storePath);

    assert.equal(await store.getSession("/p"), undefined);
    assert.deepEqual(await store.getHistory("/p"), []);
  });

  it("stores task summaries with each conversation", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-sessions-"));
    const store = createSessionStore(path.join(tmp, "agy-sessions.json"));
    await store.saveSession("/p", "c1", "flash-low", undefined, "first task");
    await store.saveSession("/p", "c2", "sonnet", undefined, "second task");
    let history = await store.getHistory("/p");
    assert.equal(history[0]?.summary, "second task");
    assert.equal(history[1]?.summary, "first task");

    // Re-saving an id keeps it once, moves it to the front, refreshes the
    // summary, and never duplicates.
    await store.saveSession("/p", "c1", "flash-low", undefined, "first task again");
    history = await store.getHistory("/p");
    assert.equal(history.length, 2);
    assert.equal(history[0]?.conversation_id, "c1");
    assert.equal(history[0]?.summary, "first task again");
  });

  it("collapses prompts into compact one-line summaries", () => {
    assert.equal(conversationSummary("line one\n  line\ttwo   three"), "line one line two three");
    assert.equal(conversationSummary("short prompt"), "short prompt");
    const long = "word ".repeat(60);
    const summarized = conversationSummary(long);
    assert.ok(summarized.length <= 81);
    assert.ok(summarized.endsWith("…"));
  });
});


