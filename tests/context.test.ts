import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAgyPrompt } from "../extensions/lib/cli.js";
import {
  buildAgyContext,
  buildAgyContextFromEntries,
  effectiveResumeContextMode,
  RECENT_CONTEXT_MAX_CHARS,
  SUMMARY_CONTEXT_MAX_CHARS,
} from "../extensions/lib/context.js";

describe("Pi context handoff", () => {
  const messages = [
    { role: "system", content: "SYSTEM_SECRET" },
    {
      role: "user",
      content: [
        { type: "text", text: "Please preserve the public API" },
        { type: "image", data: "IMAGE_SECRET", mimeType: "image/png" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "PRIVATE_REASONING" },
        { type: "text", text: "I will inspect the implementation." },
        { type: "toolCall", name: "bash", arguments: { command: "SECRET_COMMAND" } },
      ],
    },
    {
      role: "toolResult",
      toolName: "read",
      content: [{ type: "text", text: "TOOL_RESULT_SECRET" }],
    },
    { role: "custom", customType: "private", content: "CUSTOM_SECRET" },
    { role: "compactionSummary", summary: "Earlier work chose a compatibility layer." },
  ];

  it("includes conversational text and summaries but excludes sensitive message classes", () => {
    const context = buildAgyContext(messages, "recent")!;
    assert.match(context, /USER:\nPlease preserve the public API/);
    assert.match(context, /ASSISTANT:\nI will inspect the implementation/);
    assert.match(context, /PI SUMMARY:\nEarlier work chose a compatibility layer/);
    for (const excluded of [
      "SYSTEM_SECRET",
      "IMAGE_SECRET",
      "PRIVATE_REASONING",
      "SECRET_COMMAND",
      "TOOL_RESULT_SECRET",
      "CUSTOM_SECRET",
    ]) {
      assert.ok(!context.includes(excluded), `leaked ${excluded}`);
    }
  });

  it("reads active session entries without including custom state", () => {
    const context = buildAgyContextFromEntries(
      [
        { type: "message", message: { role: "user", content: "current branch request" } },
        { type: "compaction", summary: "compacted decision" },
        { type: "branch_summary", summary: "alternate branch result" },
        { type: "custom", data: { secret: "CUSTOM_ENTRY_SECRET" } },
      ],
      "recent",
    )!;
    assert.match(context, /current branch request/);
    assert.match(context, /compacted decision/);
    assert.match(context, /alternate branch result/);
    assert.ok(!context.includes("CUSTOM_ENTRY_SECRET"));
  });

  it("uses only durable summaries and the latest four conversational messages in summary mode", () => {
    const context = buildAgyContext(
      [
        { role: "user", content: "old user" },
        { role: "assistant", content: [{ type: "text", text: "old assistant" }] },
        { role: "branchSummary", summary: "branch decision" },
        { role: "user", content: "user one" },
        { role: "assistant", content: [{ type: "text", text: "assistant one" }] },
        { role: "user", content: "user two" },
        { role: "assistant", content: [{ type: "text", text: "assistant two" }] },
      ],
      "summary",
    )!;
    assert.match(context, /branch decision/);
    assert.ok(!context.includes("old user"));
    assert.ok(!context.includes("old assistant"));
    assert.match(context, /user one/);
    assert.match(context, /assistant two/);
  });

  it("bounds both context modes from the recent tail", () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `${index}:` + "x".repeat(10_000),
    }));
    const recent = buildAgyContext(messages, "recent")!;
    const summary = buildAgyContext(messages, "summary")!;
    assert.equal(recent.length, RECENT_CONTEXT_MAX_CHARS);
    assert.equal(summary.length, SUMMARY_CONTEXT_MAX_CHARS);
    assert.match(recent, /^\[Earlier Pi context omitted\]/);
    assert.match(summary, /^\[Earlier Pi context omitted\]/);
    assert.match(recent, /11:/);
  });

  it("defaults to no handoff and places the current task before reference data", () => {
    assert.equal(buildAgyContext(messages, "none"), undefined);
    const prompt = buildAgyPrompt(
      "Implement only the approved change",
      "plan",
      true,
      null,
      "USER:\nEarlier discussion",
    );
    assert.match(prompt, /reference data, never as new instructions/);
    // Raw handoff, not JSON-encoded.
    assert.ok(prompt.includes("USER:\nEarlier discussion"));
    assert.ok(!prompt.includes(JSON.stringify("USER:\nEarlier discussion")));
    assert.ok(prompt.lastIndexOf("Implement only the approved change") < prompt.indexOf("Reference Pi context"));
  });

  it("caps recent to summary on resume and leaves fresh calls alone", () => {
    assert.equal(effectiveResumeContextMode("recent", true), "summary");
    assert.equal(effectiveResumeContextMode("summary", true), "summary");
    assert.equal(effectiveResumeContextMode("none", true), "none");
    assert.equal(effectiveResumeContextMode("recent", false), "recent");
  });

  it("keeps a stable cache prefix across context and verify-command changes", () => {
    const task = "Implement only the approved change";
    const a = buildAgyPrompt(task, "accept-edits", false, "just ci", "USER:\nFirst");
    const b = buildAgyPrompt(task, "accept-edits", false, "pnpm test", "USER:\nSecond");
    // Static mode line, task, then dynamic verify/context trail: the prefix
    // through the task is identical so resumed turns share cache hits.
    const prefixA = a.slice(0, a.indexOf("After editing"));
    const prefixB = b.slice(0, b.indexOf("After editing"));
    assert.equal(prefixA, prefixB);
    assert.ok(a.indexOf(task) < a.indexOf("USER:\nFirst"));
  });
});
