import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piAgyExtension from "../extensions/index.js";
import { renderAgyRunReceipt } from "../extensions/lib/render.js";

initTheme("dark", false);

type RenderTool = {
  renderCall: (...args: any[]) => { render: (width: number) => string[] };
  renderResult: (...args: any[]) => { render: (width: number) => string[] };
};

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function registeredExecuteTool(): RenderTool {
  let executeTool: RenderTool | undefined;
  piAgyExtension({
    registerCommand: () => {},
    registerTool: (tool: { name: string }) => {
      if (tool.name === "agy_execute") executeTool = tool as unknown as RenderTool;
    },
  } as unknown as ExtensionAPI);
  assert.ok(executeTool);
  return executeTool;
}

function rendered(component: { render: (width: number) => string[] }): string {
  return component.render(200).join("\n");
}

describe("agy run receipt rendering", () => {
  it("renders bounded task and structured result details without synthetic duplication", () => {
    const receipt = {
      task: "Review the cancellation path\nand preserve cleanup diagnostics",
      text: "review complete\n\n## agy quota snapshot\nhidden quota",
      completed_at: "2026-09-20T12:00:00.000Z",
      details: {
        model: "sonnet",
        mode: "plan",
        dir: "/repo",
        verify_cmd: null,
        duration_seconds: 4.2,
        quota_status: "available",
        changed_files: ["src/cancel.ts"],
        preexisting_files: ["README.md"],
      },
    };
    const text = rendered(renderAgyRunReceipt(receipt, { expanded: false }, theme as any));
    assert.match(text, /task: Review the cancellation path and preserve cleanup diagnostics/);
    assert.match(text, /✓ agy · sonnet · plan · 4\.2s/);
    assert.match(text, /review complete/);
    assert.ok(!text.includes("hidden quota"));
    assert.ok(!text.includes("src/cancel.ts"));

    const expanded = rendered(renderAgyRunReceipt(receipt, { expanded: true }, theme as any));
    assert.match(expanded, /Review the cancellation path\s*\nand preserve cleanup diagnostics/);
    assert.match(expanded, /\+ src\/cancel\.ts/);
    assert.match(expanded, /~ README\.md \(pre-existing\)/);
  });

  it("fails closed for malformed persisted receipt data", () => {
    const text = rendered(renderAgyRunReceipt({ text: "missing fields" }, { expanded: false }, theme as any));
    assert.match(text, /Invalid agy run receipt/);
  });
});

describe("agy_execute rendering", () => {
  it("renders model, mode, context, and a compact prompt in the call card", () => {
    const tool = registeredExecuteTool();
    const text = rendered(
      tool.renderCall(
        {
          prompt: "Review the compatibility layer and focus on cancellation semantics",
          model: "sonnet",
          mode: "plan",
          context: "summary",
        },
        theme,
        {},
      ),
    );
    assert.match(text, /agy sonnet · plan · context summary/);
    assert.match(text, /Review the compatibility layer/);

    const incomplete = tool.renderCall(undefined, theme, {}).render(200);
    assert.equal(incomplete.length, 1);
    assert.match(incomplete[0]!, /agy default · accept-edits/);
  });

  it("renders live progress without dumping partial details", () => {
    const tool = registeredExecuteTool();
    const text = rendered(
      tool.renderResult(
        { content: [{ type: "text", text: "agy: starting\nextra" }], details: {} },
        { expanded: false, isPartial: true },
        theme,
        { isError: false },
      ),
    );
    assert.match(text, /◌ agy: starting extra/);
  });

  it("summarizes metadata and expands changed-file attribution", () => {
    const tool = registeredExecuteTool();
    const result = {
      content: [{
        type: "text",
        text: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\n\n## agy quota snapshot\nquota details",
      }],
      details: {
        model: "flash-medium",
        mode: "accept-edits",
        dir: "/repo",
        duration_seconds: 12.34,
        verify_cmd: "just ci",
        quota_status: "available",
        context_mode: "recent",
        context_chars: 1234,
        changed_files: ["src/new.ts"],
        preexisting_files: ["README.md"],
      },
    };

    const collapsed = rendered(
      tool.renderResult(result, { expanded: false, isPartial: false }, theme, { isError: false }),
    );
    assert.match(collapsed, /✓ agy · flash-medium · accept-edits · 12\.3s/);
    assert.match(collapsed, /quota available · verify requested: just ci · context recent \(1234 chars\)/);
    assert.match(collapsed, /1 changed by agy · 1 pre-existing/);
    assert.match(collapsed, /… 2 more lines/);
    assert.ok(!collapsed.includes("src/new.ts"));

    const expanded = rendered(
      tool.renderResult(result, { expanded: true, isPartial: false }, theme, { isError: false }),
    );
    assert.match(expanded, /\+ src\/new\.ts/);
    assert.match(expanded, /~ README\.md \(pre-existing\)/);
    assert.match(expanded, /line 6/);
    assert.ok(!expanded.includes("## agy quota snapshot"));
  });

  it("bounds legacy results without details and removes synthetic appendices", () => {
    const tool = registeredExecuteTool();
    const text = rendered(
      tool.renderResult(
        {
          content: [{
            type: "text",
            text: "one\ntwo\nthree\nfour\nfive\n\n## agy quota snapshot\nhidden",
          }],
        },
        { expanded: false, isPartial: false },
        theme,
        { isError: false },
      ),
    );
    assert.match(text, /… 1 more lines/);
    assert.ok(!text.includes("agy quota snapshot"));
  });

  it("labels clean write runs without claiming verification passed", () => {
    const tool = registeredExecuteTool();
    const text = rendered(
      tool.renderResult(
        {
          content: [{ type: "text", text: "implementation complete" }],
          details: {
            model: "flash-medium",
            mode: "accept-edits",
            dir: "/repo",
            verify_cmd: "npm test",
            changed_files: [],
            preexisting_files: [],
          },
        },
        { expanded: false, isPartial: false },
        theme,
        { isError: false },
      ),
    );
    assert.match(text, /verify requested: npm test/);
    assert.match(text, /0 files changed by agy/);
    assert.ok(!text.includes("verify passed"));
  });

  it("renders tool failures prominently and expands multiline diagnostics", () => {
    const tool = registeredExecuteTool();
    const text = rendered(
      tool.renderResult(
        { content: [{ type: "text", text: "quota probe failed" }], details: {} },
        { expanded: false, isPartial: false },
        theme,
        { isError: true },
      ),
    );
    assert.match(text, /✗ agy failed/);
    assert.match(text, /quota probe failed/);

    const expanded = rendered(
      tool.renderResult(
        { content: [{ type: "text", text: "first line\nsecond line" }], details: {} },
        { expanded: true, isPartial: false },
        theme,
        { isError: true },
      ),
    );
    assert.match(expanded, /first line\s*\nsecond line/);
  });
});
