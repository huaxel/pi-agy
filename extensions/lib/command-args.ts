/**
 * `/agy` command-line argument parsing.
 *
 * Split out of `extensions/commands.ts`: pure tokenizer with no pi APIs, so
 * the grammar is testable without a TUI harness. `commands.ts` re-exports the
 * parser for its existing test importers.
 */

import { validateAgyModelId, type AgyModelId } from "./provider-models.js";

import { normalizeAgyAgentName, type AgyModel } from "./cli.js";
import type { AgyContextMode } from "./context.js";

export const MODEL_ALIASES: Record<string, AgyModel> = {
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

export const MODEL_KEYS = Object.keys(MODEL_ALIASES);

export const MODE_KEYS = ["accept-edits", "plan", "sandbox"] as const;

export const DEFAULT_TIMEOUT_MS = 300_000;
export const MAX_TIMEOUT_MS = 600_000;

export interface AgyCommandArgs {
  mode?: "plan" | "accept-edits" | "sandbox";
  model?: AgyModel;
  model_id?: AgyModelId;
  agent?: string;
  prompt?: string;
  continue?: boolean;
  timeout_ms?: number;
  context?: AgyContextMode;
  error?: string;
}

/**
 * Parse `/agy [mode] [model] [agent=name] [continue] [timeout=10m] <prompt>` — leading
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
    } else if (Object.hasOwn(MODEL_ALIASES, value)) {
      if (parsed.model_id !== undefined) parsed.error = "model and model= cannot be combined";
      parsed.model = MODEL_ALIASES[value];
    } else if (value.startsWith("model=")) {
      try {
        if (parsed.model !== undefined || parsed.model_id !== undefined) throw new Error("model= cannot be combined with another model selector");
        parsed.model_id = validateAgyModelId(token.value.slice("model=".length));
      } catch (error) {
        parsed.error = error instanceof Error ? error.message : String(error);
      }
    } else if (value === "continue") {
      parsed.continue = true;
    } else if (value.startsWith("agent=")) {
      try {
        parsed.agent = normalizeAgyAgentName(token.value.slice("agent=".length));
      } catch (error) {
        parsed.error = error instanceof Error ? error.message : String(error);
      }
    } else if (value.startsWith("context=")) {
      const context = value.slice("context=".length);
      if (context === "none" || context === "summary" || context === "recent") {
        parsed.context = context;
      } else {
        parsed.error = `unknown context mode '${context || "(empty)"}'`;
      }
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
