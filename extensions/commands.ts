import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  checkAgyUsage,
  formatAgyUsage,
  isAgyModel,
  resolveAgyModelId,
  type AgyModel,
} from "./lib/cli.js";
import { executeAgyTask } from "./lib/execute.js";
import { describeWhen, truncate } from "./lib/output.js";
import { describePreRunDirt } from "./lib/postflight.js";
import { getHistory, getSession } from "./lib/sessions.js";

const MODEL_ALIASES: Record<string, AgyModel> = {
  flash: "flash-medium",
  "flash-low": "flash-low",
  "flash-medium": "flash-medium",
  "flash-high": "flash-high",
  pro: "pro-high",
  "pro-low": "pro-low",
  "pro-high": "pro-high",
  sonnet: "sonnet",
  opus: "opus",
  "gpt-oss": "gpt-oss",
};

const MODEL_KEYS = Object.keys(MODEL_ALIASES);

const MODEL_OPTIONS = [
  "flash — fast, cheap (Gemini Flash medium)",
  "flash-low — trivial / high-volume",
  "flash-high — harder agentic work",
  "pro — deep reasoning (Gemini Pro high)",
  "pro-low — pro, lighter reasoning",
  "pro-high — max Gemini reasoning",
  "sonnet — Claude default (review/code)",
  "opus — Claude hard problems",
  "gpt-oss — open-model alternative",
];

const MODE_OPTIONS = [
  "accept-edits — writes files (default)",
  "plan — exploration, no edits",
  "sandbox — isolated preview",
];

const MODE_KEYS = ["accept-edits", "plan", "sandbox"] as const;

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 600_000;

export interface AgyCommandArgs {
  mode?: "plan" | "accept-edits" | "sandbox";
  model?: AgyModel;
  prompt?: string;
  continue?: boolean;
  timeout_ms?: number;
}

/**
 * Parse `/agy [mode] [model] [continue] [timeout=10m] <prompt>` — leading
 * option tokens are consumed in any order; the remainder is the prompt.
 */
export function parseAgyCommandArgs(args: string): AgyCommandArgs {
  let rest = args.trim();
  const parsed: AgyCommandArgs = {};

  while (rest) {
    const token = readToken(rest);
    if (!token) break;
    const value = token.value.toLowerCase();

    const timeout = parseTimeoutToken(token.value);
    if (MODE_KEYS.includes(value as (typeof MODE_KEYS)[number])) {
      parsed.mode = value as AgyCommandArgs["mode"];
    } else if (MODEL_ALIASES[value]) {
      parsed.model = MODEL_ALIASES[value];
    } else if (value === "continue") {
      parsed.continue = true;
    } else if (timeout !== undefined) {
      parsed.timeout_ms = timeout;
    } else {
      break;
    }
    rest = rest.slice(token.end).trimStart();
  }

  if (rest) parsed.prompt = rest;
  return parsed;
}

/** `timeout=10m`, `timeout=90s`, `timeout=1500ms`; a bare number means minutes. */
function parseTimeoutToken(token: string): number | undefined {
  const match = /^timeout=(\d+(?:\.\d+)?)(ms|s|m)?$/i.exec(token);
  if (!match) return undefined;
  const amount = Number.parseFloat(match[1]);
  const unit = (match[2] ?? "m").toLowerCase();
  const ms = unit === "ms" ? amount : unit === "s" ? amount * 1_000 : amount * 60_000;
  return Math.min(Math.max(Math.round(ms), 1_000), MAX_TIMEOUT_MS);
}

function readToken(value: string): { value: string; end: number } | undefined {
  const match = /^\S+/.exec(value);
  return match ? { value: match[0], end: match[0].length } : undefined;
}

interface InteractiveRun {
  mode: "plan" | "accept-edits" | "sandbox";
  model: AgyModel;
  prompt: string;
  conversation_id?: string;
  continue?: boolean;
  timeout_ms?: number;
}

/**
 * Register the human-callable `/agy` command. Missing parts are filled with
 * dialogs, write-capable runs are confirmed, and agy executes directly — the
 * confirmed parameters stay authoritative with no second LLM turn.
 */
export function registerAgyCommand(pi: ExtensionAPI): void {
  pi.registerCommand("agy", {
    description:
      "Run agy directly: /agy [mode] [model] [continue] [timeout=10m] <prompt>; use /agy usage to inspect model quotas.",
    getArgumentCompletions: (prefix: string) => {
      const tokens = prefix.trim().split(/\s+/).filter(Boolean);
      const p = prefix.toLowerCase();

      if (
        tokens.length === 1 &&
        (MODE_KEYS.includes(tokens[0] as (typeof MODE_KEYS)[number]) ||
          tokens[0] === "usage" ||
          tokens[0] === "quota")
      ) {
        return [
          ...MODEL_KEYS.map((k) => ({ value: k, label: k })),
          ...(tokens[0] === "usage" || tokens[0] === "quota"
            ? []
            : [
                { value: "continue", label: "continue" },
                { value: "timeout=10m", label: "timeout=10m" },
              ]),
        ];
      }
      if (
        tokens.length === 2 &&
        (tokens[0] === "usage" || tokens[0] === "quota")
      ) {
        const partial = prefix.endsWith(" ") ? "" : tokens[1].toLowerCase();
        return MODEL_KEYS.filter((key) => key.startsWith(partial)).map((key) => ({
          value: key,
          label: key,
        }));
      }
      if (tokens.length <= 1) {
        const modes = MODE_KEYS.filter((m) => m.startsWith(tokens[0] ?? ""));
        const models = MODEL_KEYS.filter((k) => k.startsWith(p));
        const extras = ["continue", "sessions", "usage", "quota", "timeout=10m"].filter((k) =>
          k.startsWith(p),
        );
        return [
          ...modes.map((m) => ({ value: m, label: m })),
          ...models.map((m) => ({ value: m, label: m })),
          ...extras.map((k) => ({ value: k, label: k })),
        ];
      }
      return null;
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/agy requires interactive (TUI) mode", "error");
        return;
      }

      const command = args.trim().toLowerCase();
      if (command === "sessions") {
        await runSessionsPicker(ctx);
        return;
      }
      const usageMatch = /^(?:usage|quota)(?:\s+(\S+))?$/.exec(command);
      if (usageMatch) {
        const requestedModel = usageMatch[1] ? MODEL_ALIASES[usageMatch[1]] : undefined;
        if (usageMatch[1] && !requestedModel) {
          ctx.ui.notify(`agy: unknown model alias '${usageMatch[1]}'`, "error");
          return;
        }
        await showUsage(ctx, requestedModel);
        return;
      }

      const parsed = parseAgyCommandArgs(args);

      let mode: InteractiveRun["mode"] | undefined = parsed.mode;
      if (!mode) {
        const pick = await ctx.ui.select("agy mode", MODE_OPTIONS);
        if (!pick) {
          ctx.ui.notify("agy: cancelled", "info");
          return;
        }
        mode = optionKey(pick) as InteractiveRun["mode"];
      }

      let model = parsed.model;
      if (!model && parsed.continue) {
        const prior = await getSession(ctx.cwd);
        if (prior?.last_model && isAgyModel(prior.last_model)) model = prior.last_model;
      }
      if (!model) {
        const pick = await ctx.ui.select("agy model", MODEL_OPTIONS);
        if (!pick) {
          ctx.ui.notify("agy: cancelled", "info");
          return;
        }
        model = MODEL_ALIASES[optionKey(pick)] ?? "flash-medium";
      }

      let prompt = parsed.prompt;
      if (!prompt) {
        const text = await ctx.ui.editor("agy task", "");
        if (!text?.trim()) {
          ctx.ui.notify("agy: cancelled (empty task)", "info");
          return;
        }
        prompt = text.trim();
      }

      await executeConfirmedRun(ctx, {
        mode,
        model,
        prompt,
        continue: parsed.continue,
        timeout_ms: parsed.timeout_ms,
      });
    },
  });
}

/** `/agy usage` — show model quotas without starting an agent turn. */
async function showUsage(
  ctx: ExtensionCommandContext,
  model?: AgyModel,
): Promise<void> {
  try {
    await ctx.waitForIdle();
    const snapshot = await checkAgyUsage(ctx.cwd, ctx.signal);
    const report = formatAgyUsage(snapshot, model ? resolveAgyModelId(model) : undefined);
    ctx.ui.notify(report ?? "agy quota information is unavailable in this CLI version", report ? "info" : "warning");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`agy usage check failed: ${message}`, "error");
  }
}

/** `/agy sessions` — pick a recorded conversation and resume it with a follow-up. */
async function runSessionsPicker(ctx: ExtensionCommandContext): Promise<void> {
  const history = await getHistory(ctx.cwd);
  if (history.length === 0) {
    ctx.ui.notify("agy: no recorded conversations for this directory", "info");
    return;
  }

  const options = history.map((entry, index) => {
    const id = entry.conversation_id.slice(0, 8);
    const model = entry.model ?? "unknown model";
    const summary = entry.summary ? `${entry.summary.slice(0, 50)} · ` : "";
    return `${index + 1}. ${summary}${model} · ${describeWhen(entry.updated_at)} · ${id}…`;
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

  await executeConfirmedRun(ctx, {
    mode,
    model: isAgyModel(entry.model) ? entry.model : "flash-medium",
    prompt: text.trim(),
    conversation_id: entry.conversation_id,
  });
}

async function executeConfirmedRun(ctx: ExtensionCommandContext, run: InteractiveRun): Promise<void> {
  const cwd = ctx.cwd;

  if (run.mode === "accept-edits") {
    const dirt = await describePreRunDirt(cwd, ctx.signal).catch(() => null);
    const dirtLine = dirt ? `\nworkspace: ${dirt}` : "";
    const warning =
      dirt && dirt !== "clean"
        ? `\n\nWarning: uncommitted changes already exist — the result summary only attributes newly-dirty files to agy.`
        : "";
    const ok = await ctx.ui.confirm(
      "Run agy (accept-edits)?",
      `model: ${run.model} (${resolveAgyModelId(run.model)})\ndir: ${cwd}${dirtLine}\n\ntask: ${run.prompt.slice(0, 200)}${run.prompt.length > 200 ? "…" : ""}\n\nThis grants agy permission to modify files and run commands.${warning}`,
    );
    if (!ok) {
      ctx.ui.notify("agy: cancelled", "info");
      return;
    }
  }

  // Execute directly so the confirmed parameters cannot be changed by
  // a second LLM turn and the command works even when tools are limited.
  const status = createStatusThrottler(ctx);
  try {
    await ctx.waitForIdle();
    status(`starting (${run.model} · ${run.mode})`);
    const result = await executeAgyTask(
      {
        prompt: run.prompt,
        model: run.model,
        mode: run.mode,
        dir: cwd,
        timeout_ms: run.timeout_ms ?? DEFAULT_TIMEOUT_MS,
        conversation_id: run.conversation_id,
        continue: run.continue,
        new_session: run.conversation_id || run.continue ? false : true,
        stream: true,
      },
      ctx.signal,
      (progress) => status(progress),
    );
    status(undefined);
    ctx.ui.notify(truncate(result.text || "(empty response)", 4000), "info");
  } catch (error) {
    status(undefined);
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`agy failed: ${message}`, "error");
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

function optionKey(option: string): string {
  return option.split(" — ")[0];
}
