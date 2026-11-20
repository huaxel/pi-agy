import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat as statFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const execAsync = promisify(execFile);

import {
  AGY_MODEL_ALIASES,
  buildAgyArgs,
  buildAgyPrompt,
  effortTiersForModelId,
  isAgyModel,
  isTransientAgyFailure,
  normalizeAgyAgentName,
  parseAgyAgents,
  parseModelCatalog,
  requireAgyModelId,
  resetModelCatalog,
  resolveAgyModelId,
  supportsAgyEffort,
  supportsAgyEffortId,
  updateModelCatalog,
} from "../extensions/lib/cli.js";
import { validateAgyModelId } from "../extensions/lib/provider-models.js";
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
import { hasFlagPair } from "./helpers.js";
/**
 * Fixture catalog for argv tests. Production hardcodes no model ids, so the
 * executable path requires an observed catalog; fixtures supply their own.
 */
const ARGV_CATALOG = {
  "flash-low": "gemini-9.9-flash-low",
  "flash-medium": "gemini-9.9-flash-medium",
  "flash-high": "gemini-9.9-flash-high",
  "pro-low": "gemini-9.9-pro-low",
  "pro-high": "gemini-9.9-pro-high",
  sonnet: "claude-sonnet-9-9",
  opus: "claude-opus-9-9",
  "gpt-oss": "gpt-oss-9-9-medium",
} as const;

describe("buildAgyArgs", () => {
  beforeEach(() => {
    resetModelCatalog();
    updateModelCatalog({ ...ARGV_CATALOG });
  });
  afterEach(() => {
    resetModelCatalog();
  });
  it("uses stream-json for plan mode", () => {
    const args = buildAgyArgs({
      prompt: "test",
      mode: "plan",
      dir: "/tmp",
      timeout_ms: 60_000,
      stream: true,
    });
    assert.ok(args.includes("--output-format"));
    assert.ok(args.includes("stream-json"));
  });

  it("keeps agy's partial-success print timeout behind Pi's hard deadline", () => {
    const args = buildAgyArgs({
      prompt: "test",
      mode: "plan",
      dir: "/tmp",
      timeout_ms: 1_500,
    });
    assert.ok(hasFlagPair(args, "--print-timeout", "30s"));
  });

  it("buckets the print timeout so similar budgets share identical argv", () => {
    const base = { prompt: "test", mode: "plan" as const, dir: "/tmp" };
    const a = buildAgyArgs({ ...base, timeout_ms: 60_000 });
    const b = buildAgyArgs({ ...base, timeout_ms: 61_000 });
    assert.ok(hasFlagPair(a, "--print-timeout", "90s"));
    assert.ok(hasFlagPair(b, "--print-timeout", "90s"));
  });

  it("passes a normalized custom agent as a distinct argv value", () => {
    const args = buildAgyArgs({
      prompt: "test",
      dir: "/tmp",
      timeout_ms: 60_000,
      agent: "  gsd-debugger  ",
    });
    assert.ok(hasFlagPair(args, "--agent", "gsd-debugger"));
  });

  it("rejects unsafe or invalid custom agent names", () => {
    assert.throws(() => normalizeAgyAgentName("  "), /must not be empty/);
    assert.throws(() => normalizeAgyAgentName("bad\nname"), /control characters/);
    assert.throws(() => normalizeAgyAgentName("x".repeat(129)), /at most 128/);
  });

  it("parses the line-oriented agent roster tolerantly", () => {
    assert.deepEqual(
      parseAgyAgents("Available agents:\n- reviewer\nplanner  custom plan\nreviewer\nNo custom agents configured\n\u001b[31mbad\n"),
      ["reviewer", "planner"],
    );
    assert.equal(parseAgyAgents(Array.from({ length: 250 }, (_, i) => `agent-${i}`).join("\n")).length, 200);
  });

  it("passes conversation id", () => {
    const args = buildAgyArgs({
      prompt: "test",
      dir: "/tmp",
      timeout_ms: 60_000,
      conversation_id: "abc-123",
    });
    const idx = args.indexOf("--conversation");
    assert.equal(args[idx + 1], "abc-123");
  });

  it("passes continue flag", () => {
    const args = buildAgyArgs({
      prompt: "test",
      dir: "/tmp",
      timeout_ms: 60_000,
      continue: true,
    });
    assert.ok(args.includes("--continue"));
  });

  it("rejects ambiguous conversation selectors", () => {
    assert.throws(
      () =>
        buildAgyArgs({
          prompt: "test",
          dir: "/tmp",
          timeout_ms: 60_000,
          continue: true,
          conversation_id: "conv-1",
        }),
      /--continue and --conversation together/,
    );
  });

  it("does not bypass permissions inside the sandbox", () => {
    const args = buildAgyArgs({
      prompt: "preview",
      mode: "sandbox",
      dir: "/tmp",
      timeout_ms: 60_000,
    });
    assert.ok(args.includes("--sandbox"));
    assert.ok(!args.includes("--dangerously-skip-permissions"));
  });

  it("disables slash command expansion in print mode", () => {
    const args = buildAgyArgs({
      prompt: "/review everything",
      mode: "plan",
      dir: "/tmp",
      timeout_ms: 60_000,
    });
    assert.ok(args.includes("--disable-slash-commands"));
  });

  it("maps legacy tiers to model aliases", () => {
    const args = buildAgyArgs({
      prompt: "t",
      tier: "pro",
      dir: "/tmp",
      timeout_ms: 60_000,
    });
    assert.ok(hasFlagPair(args, "--model", ARGV_CATALOG["pro-high"]));
  });

  it("passes reasoning effort to a base slug whose catalog lists the tier", () => {
    const base = buildAgyArgs({
      prompt: "t",
      model_id: validateAgyModelId("gemini-9.9-flash"),
      mode: "plan",
      dir: "/tmp",
      timeout_ms: 60_000,
      effort: "high",
    });
    assert.equal(base[base.indexOf("--effort") + 1], "high");
  });

  it("never layers --effort onto an id that already names its tier", () => {
    // agy 1.5.13: `--model gpt-oss-120b-medium --effort high` fails with
    // "--model gpt-oss-120b-medium conflicts with --effort=high". The former
    // `/^gpt-oss-/` exception shipped exactly that broken argv.
    for (const id of ["gpt-oss-120b-medium", "gemini-4-neon-high"] as const) {
      const args = buildAgyArgs({
        prompt: "t",
        model_id: validateAgyModelId(id),
        mode: "plan",
        dir: "/tmp",
        timeout_ms: 60_000,
        effort: "high",
      });
      assert.equal(args.includes("--effort"), false, id);
    }
    const alias = buildAgyArgs({
      prompt: "t",
      model: "gpt-oss",
      mode: "plan",
      dir: "/tmp",
      timeout_ms: 60_000,
      effort: "high",
    });
    assert.equal(alias.includes("--effort"), false);
    assert.equal(supportsAgyEffort("gpt-oss"), false);
  });

  it("derives effort tiers from the catalog, per tier", () => {
    // The same base answers only the tiers it actually ships.
    assert.equal(supportsAgyEffortId("gemini-9.9-flash", "high"), true);
    assert.equal(supportsAgyEffortId("gemini-9.9-flash", "xhigh"), false);
    assert.deepEqual(effortTiersForModelId("gemini-9.9-flash"), ["low", "medium", "high"]);
    // A tier-qualified id is a conflict, not a capability.
    assert.deepEqual(effortTiersForModelId("gemini-9.9-flash-low"), []);
    // A family with no tier variants offers nothing to pick.
    assert.deepEqual(effortTiersForModelId("gemini-9.9-pro"), ["low", "high"]);
  });

  it("omits unsupported effort for Claude and Gemini aliases", () => {
    for (const model of ["sonnet", "opus", "flash-medium"] as const) {
      const args = buildAgyArgs({
        prompt: "t",
        model,
        mode: "plan",
        dir: "/tmp",
        timeout_ms: 60_000,
        effort: "high",
      });
      assert.equal(args.includes("--effort"), false, model);
      assert.equal(supportsAgyEffort(model), false);
    }
  });

  it("can run accept-edits without bypassing permissions", () => {
    const args = buildAgyArgs({
      prompt: "t",
      dir: "/tmp",
      timeout_ms: 60_000,
      skipPermissions: false,
    });
    assert.ok(!args.includes("--dangerously-skip-permissions"));
  });
});

describe("model catalog", () => {
  it("maps aliases to the newest catalog generation", () => {
    const catalog = parseModelCatalog(
      [
        "Fetching available models...",
        "gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)",
        "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
        "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
        "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
        "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
      ].join("\n"),
    );
    assert.equal(catalog["flash-medium"], "gemini-3.8-flash-medium");
    assert.equal(catalog["flash-low"], "gemini-3.8-flash-low");
    assert.equal(catalog["pro-high"], "gemini-3.1-pro-high");
    assert.equal(catalog.sonnet, "claude-sonnet-4-6");
    assert.equal(catalog.opus, undefined);
  });

  it("prefers live catalog entries when building args", () => {
    resetModelCatalog();
    updateModelCatalog({ "flash-low": "gemini-9.1-flash-low" });
    try {
      const args = buildAgyArgs({
        prompt: "t",
        model: "flash-low",
        dir: "/tmp",
        timeout_ms: 60_000,
      });
      assert.ok(args.includes("gemini-9.1-flash-low"));
    } finally {
      resetModelCatalog();
    }
  });

  it("never invents a model id without a catalog", () => {
    resetModelCatalog();
    assert.equal(resolveAgyModelId("flash-medium"), undefined);
    assert.equal(resolveAgyModelId(undefined, "flash"), undefined);
    assert.throws(
      () => requireAgyModelId("flash-medium"),
      /matches nothing in the current catalog/,
    );
  });

  it("resolves legacy tiers through the catalog, not through literals", () => {
    resetModelCatalog();
    updateModelCatalog({ "flash-high": "gemini-9.9-flash-high" });
    try {
      assert.equal(resolveAgyModelId(undefined, "flash"), "gemini-9.9-flash-high");
      assert.equal(requireAgyModelId(undefined, "flash"), "gemini-9.9-flash-high");
    } finally {
      resetModelCatalog();
    }
  });

  it("accepts only known model aliases", () => {
    for (const alias of AGY_MODEL_ALIASES) assert.ok(isAgyModel(alias), alias);
    for (const value of ["gpt-4", "", "FLASH-LOW", undefined, null, 1, {}]) {
      assert.equal(isAgyModel(value), false);
    }
  });
});

describe("isTransientAgyFailure", () => {
  it("classifies rate limits and network blips as transient", () => {
    assert.ok(isTransientAgyFailure("agy exited with code 1:\nrate limit exceeded"));
    assert.ok(isTransientAgyFailure("RESOURCE_EXHAUSTED (code 429): quota exceeded"));
    assert.ok(isTransientAgyFailure("503 overloaded, try again"));
    assert.ok(isTransientAgyFailure("fetch failed: socket hang up"));
    assert.ok(
      isTransientAgyFailure(
        'AGY_ERROR: {"status":"UNKNOWN","code":14,"retryable":true,"error_id":"abc"}',
      ),
    );
  });

  it("does not classify cancellations or hard errors as transient", () => {
    assert.ok(!isTransientAgyFailure("agy was cancelled (timeout)"));
    assert.ok(!isTransientAgyFailure("agy exited with code 2:\nunknown flag"));
    assert.ok(
      !isTransientAgyFailure(
        'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"retryable":false}',
      ),
    );
    assert.ok(!isTransientAgyFailure('tool rejected input {"retryable":true}'));
    assert.ok(!isTransientAgyFailure('AGY_ERROR: not-json {"retryable":true}'));
    assert.ok(!isTransientAgyFailure("Antigravity CLI not found in PATH."));
  });
});

describe("buildAgyPrompt", () => {
  it("injects verify command for accept-edits", () => {
    const p = buildAgyPrompt("do X", "accept-edits", false, "just ci");
    assert.match(p, /just ci/);
  });
});


