import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isAgyModel, resolveAgyModelId, type AgyModel } from "./lib/cli.js";
import { buildAgyContextFromEntries, effectiveResumeContextMode, type AgyContextMode } from "./lib/context.js";
import { describePreRunDirt } from "./lib/postflight.js";
import { DEFAULT_TIMEOUT_MS } from "./lib/command-args.js";
import { executeAgyTask } from "./lib/execute.js";
import { describeWhen, truncate } from "./lib/output.js";
import { buildAcceptEditsConfirm } from "./lib/confirm.js";
import { AGY_RUN_ENTRY_TYPE, type AgyRunReceipt } from "./lib/render.js";
import { getHistory } from "./lib/sessions.js";

export interface InteractiveRun {
  mode: "plan" | "accept-edits" | "sandbox";
  model: AgyModel;
  agent?: string;
  prompt: string;
  conversation_id?: string;
  continue?: boolean;
  timeout_ms?: number;
  context?: AgyContextMode;
}

export const MODE_OPTIONS = [
  "accept-edits — writes files (default)",
  "plan — exploration, no edits",
  "sandbox — isolated preview",
];

/** `/agy sessions` — pick a recorded conversation and resume it with a follow-up. */
export async function runSessionsPicker(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const history = await getHistory(ctx.cwd);
  if (history.length === 0) {
    ctx.ui.notify("agy: no recorded conversations for this directory", "info");
    return;
  }

  const options = history.map((entry, index) => {
    const id = entry.conversation_id.slice(0, 8);
    const model = entry.model ?? "unknown model";
    const agent = entry.agent ? ` · agent ${entry.agent}` : "";
    const summary = entry.summary ? `${entry.summary.slice(0, 50)} · ` : "";
    return `${index + 1}. ${summary}${model}${agent} · ${describeWhen(entry.updated_at)} · ${id}…`;
  });
  const pick = await ctx.ui.select("resume agy conversation", options);
  if (!pick) {
    ctx.ui.notify("agy: cancelled", "info");
    return;
  }
  const entry = history[options.indexOf(pick)];
  if (!entry) {
    ctx.ui.notify("agy: cancelled", "info");
    return;
  }

  const modePick = await ctx.ui.select("agy mode", MODE_OPTIONS);
  if (!modePick) {
    ctx.ui.notify("agy: cancelled", "info");
    return;
  }
  const mode = optionKey(modePick) as InteractiveRun["mode"];

  const text = await ctx.ui.editor("agy follow-up task", "");
  if (!text?.trim()) {
    ctx.ui.notify("agy: cancelled (empty task)", "info");
    return;
  }

  await executeConfirmedRun(pi, ctx, {
    mode,
    model: isAgyModel(entry.model) ? entry.model : "flash-medium",
    agent: entry.agent,
    prompt: text.trim(),
    conversation_id: entry.conversation_id,
  });
}

export async function executeConfirmedRun(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  run: InteractiveRun,
): Promise<void> {
  const cwd = ctx.cwd;
  await ctx.waitForIdle();
  const requestedContextMode = run.context ?? "none";
  const contextMode = effectiveResumeContextMode(
    requestedContextMode,
    Boolean(run.conversation_id || run.continue),
  );
  const contextText =
    contextMode === "none"
      ? undefined
      : buildAgyContextFromEntries(ctx.sessionManager.buildContextEntries(), contextMode);

  if (run.mode === "accept-edits") {
    const dirt = await describePreRunDirt(cwd, ctx.signal).catch(() => null);
    const { title, body } = buildAcceptEditsConfirm({
      modelLabel: `${run.model} (${resolveAgyModelId(run.model)})`,
      agent: run.agent,
      cwd,
      prompt: run.prompt,
      contextMode,
      contextText,
      dirt,
    });
    const ok = await ctx.ui.confirm(title, body);
    if (!ok) {
      ctx.ui.notify("agy: cancelled", "info");
      return;
    }
  }

  // Execute directly so the confirmed parameters cannot be changed by
  // a second LLM turn and the command works even when tools are limited.
  const status = createStatusThrottler(ctx);
  try {
    status(`starting (${run.model} · ${run.mode}${run.agent ? ` · agent ${run.agent}` : ""})`);
    const result = await executeAgyTask(
      {
        prompt: run.prompt,
        model: run.model,
        agent: run.agent,
        mode: run.mode,
        dir: cwd,
        timeout_ms: run.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        conversation_id: run.conversation_id,
        continue: run.continue,
        new_session: run.conversation_id || run.continue ? false : true,
        stream: true,
        context: contextMode,
        context_text: contextText,
      },
      ctx.signal,
      (progress) => status(progress),
    );
    status(undefined);
    const text = truncate(result.text || "(empty response)");
    if (typeof pi.appendEntry === "function") {
      pi.appendEntry(AGY_RUN_ENTRY_TYPE, {
        task: truncate(run.prompt, 500),
        text,
        details: result.details,
        completed_at: new Date().toISOString(),
      } satisfies AgyRunReceipt);
    } else {
      // Compatibility fallback for stripped-down hosts and test harnesses.
      ctx.ui.notify(truncate(text, 4000), "info");
    }
  } catch (error) {
    status(undefined);
    if (ctx.signal?.aborted) {
      ctx.ui.notify("agy: cancelled", "info");
    } else {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`agy failed: ${message}`, "error");
    }
  }
}

/** Coalesce status-bar updates so per-token deltas do not churn the TUI. */
function createStatusThrottler(ctx: ExtensionCommandContext, intervalMs = 300) {
  let lastEmit = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: string | undefined;

  const emit = (text: string) => {
    lastEmit = Date.now();
    ctx.ui.setStatus("agy", text.slice(0, 200));
  };

  return (text: string | undefined): void => {
    if (text === undefined) {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
      ctx.ui.setStatus("agy", undefined);
      return;
    }
    const now = Date.now();
    if (now - lastEmit >= intervalMs) {
      emit(text);
      return;
    }
    pending = text;
    if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        if (pending !== undefined) emit(pending);
        pending = undefined;
      }, intervalMs - (now - lastEmit));
    }
  };
}

export function optionKey(option: string): string {
  return option.split(" — ")[0];
}
