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

  it("bounds multibyte records by UTF-8 bytes", () => {
    const warnings: string[] = [];
    const state = appendStreamChunk(
      "",
      "é".repeat(Math.ceil(MAX_STREAM_LINE_BYTES / 2) + 1),
      (message) => warnings.push(message),
    );
    assert.equal(state.lineBuffer, "");
    assert.equal(warnings.length, 1);
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

  it("delivers large terminated result records intact", () => {
    // A response past the old 256 KB bound must survive the chunker and
    // accumulate fully — MAX_RESPONSE_CHARS allows up to 1M chars.
    const bigResponse = "x".repeat(300_000);
    const record =
      JSON.stringify({
        event: "result",
        result: { conversation_id: "id-big", response: bigResponse, status: "SUCCESS" },
      }) + "\n";
    const warnings: string[] = [];
    const state = appendStreamChunk("", record, (message) => warnings.push(message));
    assert.equal(state.lines.length, 1);
    assert.deepEqual(warnings, []);
    const out = accumulateRunResult(parseStreamLine(state.lines[0]!)!, { response: "" });
    assert.equal(out.response, bigResponse);
    assert.equal(out.conversation_id, "id-big");
  });

  it("buffers a large record across chunks until its newline arrives", () => {
    // While streaming, a legitimate record is unterminated for many chunks;
    // the bound must not drop it mid-growth.
    const record = JSON.stringify({ result: { response: "y".repeat(280_000) } });
    const warnings: string[] = [];
    const lines: string[] = [];
    let buffer = "";
    for (let index = 0; index < record.length; index += 65_536) {
      const state = appendStreamChunk(buffer, record.slice(index, index + 65_536), (m) =>
        warnings.push(m),
      );
      lines.push(...state.lines);
      buffer = state.lineBuffer;
    }
    const final = appendStreamChunk(buffer, "\n", (m) => warnings.push(m));
    lines.push(...final.lines);
    assert.equal(lines.length, 1);
    assert.deepEqual(warnings, []);
    const out = accumulateRunResult(parseStreamLine(lines[0]!)!, { response: "" });
    assert.equal(out.response.length, 280_000);
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

  it("surfaces native subagent progress and bounded result observations", () => {
    const active = parseStreamLine(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        step_type: "subagent",
        state: "ACTIVE",
        tool_name: "invoke_subagent",
        subagent_info: {
          subagents: [{
            type_name: "research",
            role: "File Counter",
            initial_prompt: "Count files in the current directory.",
          }],
        },
      },
    }))!;
    assert.equal(
      formatStepProgress(active),
      "▸ subagent File Counter — Count files in the current directory.",
    );
    let result = accumulateRunResult(active, { response: "" });
    assert.equal(result.subagents?.[0]?.status, "active");

    const done = parseStreamLine(JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        step_type: "subagent",
        state: "DONE",
        tool_name: "invoke_subagent",
        duration_seconds: 1.5,
        subagent_info: { subagents: [] },
      },
    }))!;
    result = accumulateRunResult(done, result);
    assert.equal(result.subagents?.[0]?.status, "done");
    assert.equal(result.subagents?.[0]?.duration_seconds, 1.5);
  });

  it("shows active-tool intent and async thresholds without exposing command text", () => {
    const command = parseStreamLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "tool",
          state: "ACTIVE",
          tool_name: "\u001b[31mrun_command\u001b[0m",
          tool_info: {
            parameters: {
              CommandLine: "curl -H 'Authorization: secret' https://example.test",
              toolAction: "\u001b]0;hidden title\u0007Starting\u202e\n development server",
              WaitMsBeforeAsync: 5_000,
            },
          },
        },
      }),
    );
    const progress = formatStepProgress(command!);
    assert.equal(progress, "▸ run_command — Starting development server · async threshold 5s");
    assert.ok(!progress?.includes("secret"));

    const task = parseStreamLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "tool",
          state: "ACTIVE",
          tool_name: "manage_task",
          tool_info: {
            parameters: {
              TaskId: "task-42",
              toolAction: "Checking status",
              WaitMsBeforeAsync: -1,
            },
          },
        },
      }),
    );
    assert.equal(
      formatStepProgress(task!),
      "▸ manage_task → task task-42 — Checking status",
    );

    const summary = parseStreamLine(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "tool",
          state: "ACTIVE",
          tool_name: "run_command",
          tool_info: { parameters: { toolSummary: "Building project", WaitMsBeforeAsync: 250 } },
        },
      }),
    );
    assert.equal(
      formatStepProgress(summary!),
      "▸ run_command — Building project · async threshold 250ms",
    );
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

  it("accumulates result conversation id and terminal status", () => {
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
    assert.equal(out.terminal_status, "SUCCESS");
  });

  it("preserves top-level JSON terminal errors", () => {
    const out = finalizeRunResult(
      JSON.stringify({
        conversation_id: "id-error",
        status: "ERROR",
        response: "",
        error: "model failed",
      }),
      { response: "" },
    );
    assert.equal(out.conversation_id, "id-error");
    assert.equal(out.response, "");
    assert.equal(out.terminal_status, "ERROR");
    assert.equal(out.terminal_error, "model failed");
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

  it("sanitizes, deduplicates, and bounds denied actions from both envelope shapes", () => {
    const denied = [
      { action: "command", display_name: "\u001b[31mRun\nCommand\u001b[0m" },
      { action: "command", display_name: "Run Command" },
      "read_file",
      { action: 42 },
      ...Array.from({ length: 40 }, (_, index) => ({ action: `action-${index}` })),
    ];
    const nested = accumulateRunResult(
      parseStreamLine(JSON.stringify({ result: { denied_actions: denied } }))!,
      { response: "" },
    );
    assert.deepEqual(nested.denied_actions?.slice(0, 3), [
      { action: "command", display_name: "Run Command" },
      { action: "read_file" },
      { action: "action-0" },
    ]);
    assert.equal(nested.denied_actions?.length, 32);

    const topLevel = finalizeRunResult(
      JSON.stringify({
        status: "SUCCESS",
        response: "permission was refused",
        denied_actions: [{ action: "write_file", display_name: "Write File" }],
      }),
      { response: "" },
    );
    assert.deepEqual(topLevel.denied_actions, [
      { action: "write_file", display_name: "Write File" },
    ]);
  });

  it("fails closed on malformed status while ignoring other malformed result fields", () => {
    const line = parseStreamLine(
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: 42,
          status: 42,
          response: { text: "not a response" },
          duration_seconds: "slow",
          usage: "not usage",
        },
      }),
    );
    const out = accumulateRunResult(line!, { response: "fallback" });
    assert.equal(out.conversation_id, undefined);
    assert.equal(out.terminal_status, "(invalid)");
    assert.equal(out.response, "fallback");
    assert.equal(out.duration_seconds, undefined);
    assert.equal(out.usage, undefined);
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

  it("returns empty text for a zero cap and degrades when the marker cannot fit", () => {
    assert.equal(truncate("anything", 0), "");
    const cramped = truncate("y".repeat(500), 30);
    assert.ok(cramped.length <= 30);
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


