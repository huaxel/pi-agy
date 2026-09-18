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
import { createSessionStore, getDefaultStorePath } from "../extensions/lib/sessions.js";
describe("agy config", () => {
  it("reads optional overrides from the agent config", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-config-"));
    const file = path.join(tmp, "agy-config.json");
    await writeFile(
      file,
      JSON.stringify({ skipPermissions: false, defaultModel: "sonnet", quotaBalancing: true }),
    );
    const config = await loadAgyConfig(file);
    assert.equal(config.skipPermissions, false);
    assert.equal(config.defaultModel, "sonnet");
    assert.equal(config.quotaBalancing, true);
  });

  it("returns defaults for missing or malformed config", async () => {
    assert.deepEqual(await loadAgyConfig(path.join(os.tmpdir(), "missing-agy-config.json")), {});
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-config-"));
    const file = path.join(tmp, "agy-config.json");
    await writeFile(file, "not json");
    assert.deepEqual(await loadAgyConfig(file), {});
  });

  it("fails closed on malformed permission settings", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-config-"));
    const file = path.join(tmp, "agy-config.json");
    await writeFile(
      file,
      JSON.stringify({ skipPermissions: "false", defaultModel: 42, defaultModelCommand: 7 }),
    );
    assert.deepEqual(await loadAgyConfig(file), { skipPermissions: false });
  });
});

describe("resolveDefaultModel", () => {
  it("prefers an explicit defaultModel over the command", async () => {
    resetDefaultModelCache();
    const alias = await resolveDefaultModel({
      defaultModel: "opus",
      defaultModelCommand: "echo sonnet",
    });
    assert.equal(alias, "opus");
  });

  it("accepts flash and pro shorthand defaults", async () => {
    resetDefaultModelCache();
    assert.equal(await resolveDefaultModel({ defaultModel: "flash" }), "flash-medium");
    assert.equal(await resolveDefaultModel({ defaultModel: "pro" }), "pro-high");
  });

  it("uses valid command output", async () => {
    resetDefaultModelCache();
    assert.equal(await resolveDefaultModel({ defaultModelCommand: "echo sonnet" }), "sonnet");
  });

  it("ignores invalid output, failures, and empty commands", async () => {
    resetDefaultModelCache();
    assert.equal(await resolveDefaultModel({ defaultModelCommand: "echo gpt-4" }), undefined);
    resetDefaultModelCache();
    assert.equal(await resolveDefaultModel({ defaultModelCommand: "exit 1" }), undefined);
    resetDefaultModelCache();
    assert.equal(await resolveDefaultModel({ defaultModelCommand: "   " }), undefined);
    resetDefaultModelCache();
    assert.equal(await resolveDefaultModel({}), undefined);
  });

  it("caches the command result within the TTL", async () => {
    resetDefaultModelCache();
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-default-"));
    const counter = path.join(tmp, "runs");
    const command = `echo x >> ${counter}; echo flash-high`;
    assert.equal(await resolveDefaultModel({ defaultModelCommand: command }), "flash-high");
    assert.equal(await resolveDefaultModel({ defaultModelCommand: command }), "flash-high");
    const runs = (await readFile(counter, "utf8")).split("\n").filter(Boolean).length;
    assert.equal(runs, 1);
    resetDefaultModelCache();
  });

  it("caches independent commands separately", async () => {
    resetDefaultModelCache();
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-default-"));
    const firstRuns = path.join(tmp, "first-runs");
    const secondRuns = path.join(tmp, "second-runs");
    const first = `echo x >> ${firstRuns}; echo flash-low`;
    const second = `echo x >> ${secondRuns}; echo sonnet`;
    assert.equal(await resolveDefaultModel({ defaultModelCommand: first }), "flash-low");
    assert.equal(await resolveDefaultModel({ defaultModelCommand: second }), "sonnet");
    assert.equal(await resolveDefaultModel({ defaultModelCommand: first }), "flash-low");
    assert.equal(await resolveDefaultModel({ defaultModelCommand: second }), "sonnet");
    assert.equal((await readFile(firstRuns, "utf8")).trim(), "x");
    assert.equal((await readFile(secondRuns, "utf8")).trim(), "x");
    resetDefaultModelCache();
  });

  it("does not cache an aborted command result", async () => {
    resetDefaultModelCache();
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-default-"));
    const marker = path.join(tmp, "marker");
    const command = `test -f ${marker} && echo sonnet || echo flash-low`;
    const controller = new AbortController();
    controller.abort();
    assert.equal(await resolveDefaultModel({ defaultModelCommand: command }, controller.signal), undefined);
    await writeFile(marker, "ready");
    assert.equal(await resolveDefaultModel({ defaultModelCommand: command }), "sonnet");
    resetDefaultModelCache();
  });
});



describe("quotaBalancing", () => {
  const ENV_VARS = [
    "PI_CODING_AGENT_DIR",
    "AGY_DEFAULT_MODEL_WINDOW_HOURS",
    "AGY_DEFAULT_MODEL_MIN_SESSIONS",
    "AGY_DEFAULT_MODEL_GEMINI_SHARE",
  ] as const;

  async function withAgentDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const saved = new Map<string, string | undefined>();
    for (const name of ENV_VARS) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-quota-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      return await fn(dir);
    } finally {
      for (const name of ENV_VARS) {
        const value = saved.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  function entry(id: string, model: string, hoursAgo = 1): Record<string, string> {
    return {
      conversation_id: id,
      model,
      updated_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    };
  }

  it("flips to sonnet when Gemini carried recent work", async () => {
    await withAgentDir(async (dir) => {
      await writeFile(
        path.join(dir, "agy-sessions.json"),
        JSON.stringify({
          "/a": { history: [entry("1", "flash-medium"), entry("2", "pro-high")] },
          "/b": { history: [entry("3", "flash-low")] },
        }),
      );
      assert.equal(await resolveDefaultModel({ quotaBalancing: true }), "sonnet");
    });
  });

  it("keeps the built-in default below the minimum or when balanced", async () => {
    await withAgentDir(async (dir) => {
      await writeFile(
        path.join(dir, "agy-sessions.json"),
        JSON.stringify({ "/a": { history: [entry("1", "flash-medium")] } }),
      );
      assert.equal(await resolveDefaultModel({ quotaBalancing: true }), undefined);
      await writeFile(
        path.join(dir, "agy-sessions.json"),
        JSON.stringify({
          "/a": {
            history: [
              entry("1", "flash-medium"),
              entry("2", "sonnet"),
              entry("3", "opus"),
              entry("4", "gpt-oss"),
            ],
          },
        }),
      );
      assert.equal(await resolveDefaultModel({ quotaBalancing: true }), undefined);
    });
  });

  it("ignores stale, duplicate, and unknown entries without throwing", async () => {
    await withAgentDir(async (dir) => {
      const now = new Date().toISOString();
      await writeFile(
        path.join(dir, "agy-sessions.json"),
        JSON.stringify({
          "/a": {
            last_conversation_id: "1",
            last_model: "flash-medium",
            updated_at: now,
            history: [
              entry("1", "flash-medium"),
              entry("1", "flash-medium"),
              entry("old", "flash-medium", 48),
              { conversation_id: "weird", model: "mystery-9", updated_at: now },
            ],
          },
        }),
      );
      // One live Gemini conversation: below minimum, and no double-count.
      assert.equal(await resolveDefaultModel({ quotaBalancing: true }), undefined);
    });
  });

  it("treats missing or corrupt stores as no signal", async () => {
    await withAgentDir(async (dir) => {
      assert.equal(await resolveDefaultModel({ quotaBalancing: true }), undefined);
      await writeFile(path.join(dir, "agy-sessions.json"), "not json");
      assert.equal(await resolveDefaultModel({ quotaBalancing: true }), undefined);
      await writeFile(path.join(dir, "agy-sessions.json"), JSON.stringify(["nope"]));
      assert.equal(await resolveDefaultModel({ quotaBalancing: true }), undefined);
    });
  });

  it("honors tuning overrides from the environment", async () => {
    await withAgentDir(async (dir) => {
      await writeFile(
        path.join(dir, "agy-sessions.json"),
        JSON.stringify({
          "/a": { history: [entry("1", "flash-medium"), entry("2", "sonnet")] },
        }),
      );
      // 1/2 = 50% Gemini: below the default 75% share.
      assert.equal(await resolveDefaultModel({ quotaBalancing: true }), undefined);
      process.env.AGY_DEFAULT_MODEL_GEMINI_SHARE = "50";
      process.env.AGY_DEFAULT_MODEL_MIN_SESSIONS = "2";
      assert.equal(await resolveDefaultModel({ quotaBalancing: true }), "sonnet");
    });
  });

  it("an explicit default still wins over balancing", async () => {
    await withAgentDir(async () => {
      assert.equal(
        await resolveDefaultModel({ defaultModel: "opus", quotaBalancing: true }),
        "opus",
      );
    });
  });
});
