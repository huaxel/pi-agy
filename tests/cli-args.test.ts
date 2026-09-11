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
import { hasFlagPair } from "./helpers.js";
describe("buildAgyArgs", () => {
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
    assert.ok(hasFlagPair(args, "--model", "gemini-3.1-pro-high"));
  });

  it("passes reasoning effort", () => {
    const args = buildAgyArgs({
      prompt: "t",
      mode: "plan",
      dir: "/tmp",
      timeout_ms: 60_000,
      effort: "high",
    });
    const idx = args.indexOf("--effort");
    assert.equal(args[idx + 1], "high");
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

  it("falls back to the static map without a catalog", () => {
    resetModelCatalog();
    assert.equal(resolveAgyModelId("flash-medium"), "gemini-3.8-flash-medium");
    assert.equal(resolveAgyModelId(undefined, "flash"), "gemini-3.8-flash-high");
  });

  it("accepts only known model aliases", () => {
    assert.ok(isAgyModel("sonnet"));
    assert.ok(!isAgyModel("gpt-4"));
    assert.ok(!isAgyModel(undefined));
  });
});

describe("isTransientAgyFailure", () => {
  it("classifies rate limits and network blips as transient", () => {
    assert.ok(isTransientAgyFailure("agy exited with code 1:\nrate limit exceeded"));
    assert.ok(isTransientAgyFailure("503 overloaded, try again"));
    assert.ok(isTransientAgyFailure("fetch failed: socket hang up"));
  });

  it("does not classify cancellations or hard errors as transient", () => {
    assert.ok(!isTransientAgyFailure("agy was cancelled (timeout)"));
    assert.ok(!isTransientAgyFailure("agy exited with code 2:\nunknown flag"));
    assert.ok(!isTransientAgyFailure("Antigravity CLI not found in PATH."));
  });
});

describe("buildAgyPrompt", () => {
  it("injects verify command for accept-edits", () => {
    const p = buildAgyPrompt("do X", "accept-edits", false, "just ci");
    assert.match(p, /just ci/);
  });
});


