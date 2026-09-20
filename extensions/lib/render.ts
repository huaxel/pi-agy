import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, truncateToWidth } from "@earendil-works/pi-tui";

import type { AgyExecutionDetails } from "./execute.js";

export const AGY_RUN_ENTRY_TYPE = "agy-run-receipt";

export interface AgyRunReceipt {
  task: string;
  text: string;
  details: AgyExecutionDetails;
  completed_at: string;
}

interface RenderResultLike {
  content: unknown;
  details?: unknown;
}

interface RenderOptions {
  expanded: boolean;
  isPartial?: boolean;
}

interface RenderContext {
  isError?: boolean;
}

function oneLine(value: unknown, max: number): string {
  const text = stripTerminalSequences(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  return truncateToWidth(text, max, "…");
}

function firstText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const part = content.find(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string",
  ) as { text?: string } | undefined;
  return part?.text ?? "";
}

function stripSyntheticResultSections(value: string): string {
  const markers = [
    "\n\n## agy quota snapshot",
    "\n\n## git diff --stat",
    "\n\n## git diff --cached --stat",
    "\n\nagy made no newly-dirty files",
  ];
  const indexes = markers
    .map((marker) => value.indexOf(marker))
    .filter((index) => index >= 0);
  const end = indexes.length ? Math.min(...indexes) : value.length;
  return value.slice(0, end).trimEnd();
}

export function renderAgyCall(
  args: {
    model?: unknown;
    tier?: unknown;
    mode?: unknown;
    agent?: unknown;
    context?: unknown;
    prompt?: unknown;
  } | undefined,
  theme: Theme,
): Text {
  const callArgs = args ?? {};
  const model = callArgs.model ?? callArgs.tier ?? "default";
  const mode = callArgs.mode ?? "accept-edits";
  const contextMode = callArgs.context ?? "none";
  const agent = callArgs.agent ? oneLine(callArgs.agent, 128) : "";
  const header =
    theme.fg("toolTitle", theme.bold("agy ")) +
    theme.fg("accent", String(model)) +
    theme.fg(
      "dim",
      ` · ${String(mode)}${agent ? ` · agent ${agent}` : ""}${contextMode === "none" ? "" : ` · context ${String(contextMode)}`}`,
    );
  const promptLine = oneLine(callArgs.prompt, 180);
  return new Text(
    promptLine ? `${header}\n${theme.fg("muted", promptLine)}` : header,
    0,
    0,
  );
}

function formatAgyResult(
  result: RenderResultLike,
  { expanded, isPartial }: RenderOptions,
  theme: Theme,
  context: RenderContext,
): string {
  const body = firstText(result.content);
  if (isPartial) {
    return theme.fg("warning", "◌ ") + theme.fg("muted", oneLine(body || "agy: working…", 180));
  }
  if (context.isError) {
    const errorBody = expanded ? stripTerminalSequences(body) : oneLine(body, 300);
    return (
      theme.fg("error", "✗ agy failed") +
      (errorBody ? `\n${theme.fg("toolOutput", errorBody)}` : "")
    );
  }

  const details = result.details as AgyExecutionDetails | undefined;
  if (!details) {
    const displayBody = stripSyntheticResultSections(body);
    const bodyLines = displayBody.split("\n");
    const shown = expanded ? bodyLines : bodyLines.slice(0, 4);
    if (!expanded && bodyLines.length > shown.length) {
      shown.push(`… ${bodyLines.length - shown.length} more lines`);
    }
    return shown.join("\n");
  }

  const duration =
    typeof details.duration_seconds === "number"
      ? ` · ${details.duration_seconds.toFixed(1)}s`
      : "";
  const lines = [
    theme.fg("success", "✓ agy") +
      theme.fg(
        "muted",
        ` · ${details.model} · ${details.mode}${details.agent ? ` · agent ${oneLine(details.agent, 128)}` : ""}${duration}`,
      ),
  ];

  const metadata: string[] = [];
  if (details.quota_status) metadata.push(`quota ${details.quota_status}`);
  if (details.verify_cmd) metadata.push(`verify requested: ${details.verify_cmd}`);
  if (details.context_mode && details.context_mode !== "none") {
    metadata.push(`context ${details.context_mode} (${details.context_chars ?? 0} chars)`);
  }
  if (metadata.length) lines.push(theme.fg("dim", metadata.join(" · ")));

  const changed = details.changed_files ?? [];
  const preexisting = details.preexisting_files ?? [];
  if (changed.length || preexisting.length) {
    lines.push(
      theme.fg(
        "muted",
        `${changed.length} changed by agy · ${preexisting.length} pre-existing`,
      ),
    );
    if (expanded) {
      for (const file of changed) lines.push(theme.fg("toolDiffAdded", `+ ${file}`));
      for (const file of preexisting) {
        lines.push(theme.fg("toolDiffContext", `~ ${file} (pre-existing)`));
      }
    }
  } else if (details.mode === "accept-edits") {
    lines.push(theme.fg("muted", "0 files changed by agy"));
  }

  const displayBody = stripSyntheticResultSections(body);
  if (displayBody) {
    const bodyLines = displayBody.split("\n");
    const shown = expanded ? bodyLines : bodyLines.slice(0, 4);
    lines.push(...shown.map((line) => theme.fg("toolOutput", line)));
    if (!expanded && bodyLines.length > shown.length) {
      lines.push(
        theme.fg(
          "dim",
          `… ${bodyLines.length - shown.length} more lines (${keyHint("app.tools.expand", "to expand")})`,
        ),
      );
    }
  }
  return lines.join("\n");
}

export function renderAgyResult(
  result: RenderResultLike,
  options: RenderOptions,
  theme: Theme,
  context: RenderContext,
): Text {
  return new Text(formatAgyResult(result, options, theme, context), 0, 0);
}

function isAgyRunReceipt(value: unknown): value is AgyRunReceipt {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Partial<AgyRunReceipt>;
  return (
    typeof data.task === "string" &&
    typeof data.text === "string" &&
    typeof data.completed_at === "string" &&
    typeof data.details === "object" &&
    data.details !== null
  );
}

export function renderAgyRunReceipt(
  value: unknown,
  options: { expanded: boolean },
  theme: Theme,
): Text {
  if (!isAgyRunReceipt(value)) {
    return new Text(theme.fg("error", "Invalid agy run receipt"), 0, 0);
  }
  const task = options.expanded
    ? stripTerminalSequences(value.task)
    : oneLine(value.task, 180);
  const result = formatAgyResult(
    { content: [{ type: "text", text: value.text }], details: value.details },
    { expanded: options.expanded },
    theme,
    {},
  );
  const taskLine = task ? `${theme.fg("dim", "task: ")}${theme.fg("muted", task)}\n` : "";
  return new Text(taskLine + result, 0, 0);
}
