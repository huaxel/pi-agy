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
  appendStreamChunk,
  finalizeRunResult,
  formatStepProgress,
  MAX_STREAM_LINE_BYTES,
  parseStreamLine,
} from "../extensions/lib/stream.js";
import { parseJsonResponse } from "../extensions/lib/parse.js";
import { parseAgyCommandArgs } from "../extensions/commands.js";
import { createSessionStore, getDefaultStorePath } from "../extensions/lib/sessions.js";
describe("appendStreamChunk", () => {
  it("splits complete lines and preserves the remainder", () => {
    const warnings: string[] = [];
    const first = appendStreamChunk("", '{"a":1}\n{"b":', (message) =>
      warnings.push(message),
    );
    assert.deepEqual(first.lines, ['{"a":1}']);
    assert.equal(first.lineBuffer, '{"b":');
    const second = appendStreamChunk(first.lineBuffer, '2}\n', (message) =>
      warnings.push(message),
    );
    assert.deepEqual(second.lines, ['{"b":2}']);
    assert.equal(second.lineBuffer, "");
    assert.deepEqual(warnings, []);
  });

  it("drops a newline-less runaway with a warning", () => {
    const warnings: string[] = [];
    let state = appendStreamChunk("", "x".repeat(MAX_STREAM_LINE_BYTES + 1), (message) =>
      warnings.push(message),
    );
    assert.deepEqual(state.lines, []);
    assert.equal(state.lineBuffer, "");
    assert.equal(warnings.length, 1);
    // The stream recovers: later records still parse.
    state = appendStreamChunk(state.lineBuffer, '{"ok":true}\n', (message) =>
      warnings.push(message),
    );
    assert.deepEqual(state.lines, ['{"ok":true}']);
  });

  it("skips oversized complete lines but keeps neighbors", () => {
    const warnings: string[] = [];
    const state = appendStreamChunk(
      "",
      `good\n${"y".repeat(MAX_STREAM_LINE_BYTES + 1)}\nalso-good\n`,
      (message) => warnings.push(message),
    );
    assert.deepEqual(state.lines, ["good", "also-good"]);
    assert.equal(warnings.length, 1);
  });

  it("drops an oversized remainder without losing complete lines", () => {
    const warnings: string[] = [];
    const state = appendStreamChunk(
      "",
      `fine\n${"z".repeat(MAX_STREAM_LINE_BYTES + 10)}`,
      (message) => warnings.push(message),
    );
    assert.deepEqual(state.lines, ["fine"]);
    assert.equal(state.lineBuffer, "");
    assert.equal(warnings.length, 1);
  });
});

describe("stream parser", () => {
  it("formats tool progress", () => {
    const parsed = parseStreamLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "tool",
          state: "ACTIVE",
          tool_name: "write_to_file",
          tool_info: { parameters: { TargetFile: "/tmp/a.ts" } },
        },
      }),
    );
    assert.ok(parsed);
    assert.equal(formatStepProgress(parsed!), "▸ write_to_file → /tmp/a.ts");
  });

  it("uses stable progress for response deltas", () => {
    const parsed = parseStreamLine(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "partial" },
      }),
    );
    assert.equal(formatStepProgress(parsed!), "agy: generating response…");
  });

  it("ignores non-object JSON lines", () => {
    assert.equal(parseStreamLine("null"), null);
    assert.equal(parseStreamLine("[1, 2, 3]"), null);
    assert.equal(parseStreamLine('"text"'), null);
  });

  it("formats result progress", () => {
    const parsed = parseStreamLine(
      JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", duration_seconds: 1.25 },
      }),
    );
    assert.equal(formatStepProgress(parsed!), "agy: SUCCESS in 1.3s");
  });

  it("preserves metadata from plain JSON output", () => {
    const out = finalizeRunResult(
      JSON.stringify({ conversation_id: "id-2", response: "done", duration_seconds: 2 }),
      { response: "" },
    );
    assert.equal(out.conversation_id, "id-2");
    assert.equal(out.response, "done");
    assert.equal(out.duration_seconds, 2);
  });

  it("accumulates result conversation id", () => {
    const line = parseStreamLine(
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "id-1",
          response: "done",
          status: "SUCCESS",
        },
      }),
    );
    const out = accumulateRunResult(line!, { response: "" });
    assert.equal(out.conversation_id, "id-1");
    assert.equal(out.response, "done");
  });

  it("preserves an explicitly empty successful response", () => {
    const raw =
      JSON.stringify({
        event: "result",
        result: { conversation_id: "id-empty", response: "", status: "SUCCESS" },
      }) + "\n";
    const out = finalizeRunResult(raw, { response: "" });
    assert.equal(out.conversation_id, "id-empty");
    assert.equal(out.response, "");
  });
});


describe("truncate", () => {
  it("keeps the ending of long responses", () => {
    const result = truncate("START\n" + "x".repeat(200) + "\nFINAL SUMMARY", 80);
    assert.ok(result.length <= 80);
    assert.match(result, /START/);
    assert.match(result, /FINAL SUMMARY/);
    assert.match(result, /truncated/);
  });
});


describe("parseJsonResponse", () => {
  it("extracts response field", () => {
    assert.equal(parseJsonResponse(JSON.stringify({ response: "hello" })), "hello");
  });

  it("falls back when response is not text", () => {
    const raw = JSON.stringify({ response: { text: "hello" } });
    assert.equal(parseJsonResponse(raw), raw);
  });
});


