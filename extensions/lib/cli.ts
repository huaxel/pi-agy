import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import {
  accumulateRunResult,
  appendStreamChunk,
  finalizeRunResult,
  formatStepProgress,
  parseStreamLine,
  type AgyProgressHandler,
  type AgyRunResult,
  type AgyStreamLine,
} from "./stream.js";

export { detectVerifyCommand } from "./verify.js";
export { parseJsonResponse } from "./parse.js";

// Ported from upstream pi-agy 0.3.4: Windows ENOENT errors must not suggest
// a bash one-liner.
const INSTALL_HINT =
  process.platform === "win32"
    ? "Install agy: irm https://antigravity.google/cli/install.ps1 | iex"
    : "Install agy: curl -fsSL https://antigravity.google/cli/install.sh | bash";

export type AgyModel =
  | "flash-low"
  | "flash-medium"
  | "flash-high"
  | "pro-low"
  | "pro-high"
  | "sonnet"
  | "opus"
  | "gpt-oss";

export const AGY_MODEL_ALIASES: readonly AgyModel[] = [
  "flash-low",
  "flash-medium",
  "flash-high",
  "pro-low",
  "pro-high",
  "sonnet",
  "opus",
  "gpt-oss",
];

export function isAgyModel(value: unknown): value is AgyModel {
  return typeof value === "string" && (AGY_MODEL_ALIASES as readonly string[]).includes(value);
}

export type AgyEffort = "low" | "medium" | "high";

/** A normalized model quota entry returned by agy's read-only usage command. */
export interface AgyQuotaEntry {
  model: string;
  window?: string;
  remaining_fraction?: number;
  remaining_requests?: number;
  remaining_tokens?: number;
  reset_at?: string;
}

/** Best-effort quota snapshot; agy versions may expose different JSON shapes. */
export interface AgyUsageSnapshot {
  fetched_at: string;
  models: AgyQuotaEntry[];
  raw_summary?: string;
  error?: string;
}

export interface AgyOptions {
  prompt: string;
  model?: AgyModel;
  tier?: "flash" | "flash-lo" | "pro";
  effort?: AgyEffort;
  mode?: "plan" | "accept-edits" | "sandbox";
  dir: string;
  timeout_ms: number;
  conversation_id?: string;
  continue?: boolean;
  stream?: boolean;
  skipPermissions?: boolean;
}

const PREFLIGHT_TIMEOUT_MS = 10_000;
// Raw stdout capture bound; only the non-streaming/parse-failure fallback —
// the stream-json path accumulates results incrementally and is not capped by
// it. Large enough that plain-text fallbacks rarely truncate.
const MAX_CAPTURE_BYTES = 1024 * 1024;
// Preview/experimental model ids must never win catalog resolution implicitly.
const UNSTABLE_MODEL_PATTERN =
  /(?:^|[-_.])(?:preview|experimental|beta|alpha|rc\d*|snapshot|next)(?:$|[-_.])/i;

// Static fallback for when `agy models` output is unavailable. The live
// catalog (updated during preflight) overrides these per alias.
const MODEL_MAP: Record<AgyModel, string> = {
  "flash-low": "gemini-3.8-flash-low",
  "flash-medium": "gemini-3.8-flash-medium",
  "flash-high": "gemini-3.8-flash-high",
  "pro-low": "gemini-3.1-pro-low",
  "pro-high": "gemini-3.1-pro-high",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6-thinking",
  "gpt-oss": "gpt-oss-120b-medium",
};

const TIER_MAP: Record<NonNullable<AgyOptions["tier"]>, AgyModel> = {
  flash: "flash-high",
  "flash-lo": "flash-low",
  pro: "pro-high",
};

/** alias → pattern matching concrete model ids in `agy models` output. */
const UNSTABLE_SUFFIX = "(?:-(?:preview|experimental|beta|alpha|rc\\d*|snapshot|next))*";
const CATALOG_PATTERNS: Record<AgyModel, RegExp> = {
  "flash-low": new RegExp(`^gemini-\\d+(?:\\.\\d+)*-flash-low${UNSTABLE_SUFFIX}$`),
  "flash-medium": new RegExp(`^gemini-\\d+(?:\\.\\d+)*-flash-medium${UNSTABLE_SUFFIX}$`),
  "flash-high": new RegExp(`^gemini-\\d+(?:\\.\\d+)*-flash-high${UNSTABLE_SUFFIX}$`),
  "pro-low": new RegExp(`^gemini-\\d+(?:\\.\\d+)*-pro-low${UNSTABLE_SUFFIX}$`),
  "pro-high": new RegExp(`^gemini-\\d+(?:\\.\\d+)*-pro-high${UNSTABLE_SUFFIX}$`),
  sonnet: /^claude-sonnet-[\w.-]+$/,
  opus: /^claude-opus-[\w.-]+$/,
  "gpt-oss": /^gpt-oss-[\w.-]+$/,
};

export type AgyModelCatalog = Partial<Record<AgyModel, string>>;

let modelCatalog: AgyModelCatalog = {};

export function isStableModelId(id: string): boolean {
  return !UNSTABLE_MODEL_PATTERN.test(id);
}

/**
 * Parse `agy models` output into alias → concrete model id. Newer model
 * generations win over older ones so aliases track the latest catalog.
 * Preview/experimental ids are ignored unless `allowPreview` is set, so an
 * unstable catalog entry can never silently become the default model.
 */
export function parseModelCatalog(output: string, allowPreview = false): AgyModelCatalog {
  const allow = allowPreview || process.env.PI_AGY_ALLOW_PREVIEW === "1";
  const found: AgyModelCatalog = {};
  for (const line of output.split("\n")) {
    const id = line.trim().split(/\s+/)[0] ?? "";
    if (!id) continue;
    if (!allow && !isStableModelId(id)) continue;
    for (const [alias, pattern] of Object.entries(CATALOG_PATTERNS) as Array<[AgyModel, RegExp]>) {
      if (pattern.test(id) && compareModelIds(id, found[alias] ?? "") > 0) {
        found[alias] = id;
      }
    }
  }
  return found;
}

function compareModelIds(a: string, b: string): number {
  if (!b) return 1;
  const versionA = /^gemini-(\d+(?:\.\d+)*)-/.exec(a)?.[1];
  const versionB = /^gemini-(\d+(?:\.\d+)*)-/.exec(b)?.[1];
  if (versionA && versionB) return compareDottedVersions(versionA, versionB);
  // Numeric-aware compare so claude-sonnet-4-10 sorts above claude-sonnet-4-6.
  return compareNatural(a, b);
}

function compareNatural(a: string, b: string): number {
  const sa = a.split(/(\d+)/);
  const sb = b.split(/(\d+)/);
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const pa = sa[i] ?? "";
    const pb = sb[i] ?? "";
    if (pa === pb) continue;
    if (/^\d+$/.test(pa) && /^\d+$/.test(pb)) {
      const na = Number(pa);
      const nb = Number(pb);
      if (na !== nb) return na < nb ? -1 : 1;
    }
    return pa < pb ? -1 : 1;
  }
  return 0;
}

function compareDottedVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const delta = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Merge freshly observed catalog entries over the in-process catalog. */
export function updateModelCatalog(catalog: AgyModelCatalog): void {
  modelCatalog = { ...modelCatalog, ...catalog };
}

export function getModelCatalog(): AgyModelCatalog {
  return { ...modelCatalog };
}

/** Test helper — drop in-process catalog state. */
export function resetModelCatalog(): void {
  modelCatalog = {};
}

/** Resolve explicit model or legacy tier to the internal alias. */
export function resolveAgyModelAlias(
  model?: AgyModel,
  tier?: AgyOptions["tier"],
): AgyModel | undefined {
  return model ?? (tier ? TIER_MAP[tier] : undefined);
}

/** Resolve a model alias to a concrete agy model id, preferring the live catalog. */
export function resolveAgyModelId(model?: AgyModel, tier?: AgyOptions["tier"]): string {
  const alias = resolveAgyModelAlias(model, tier) ?? "flash-medium";
  return modelCatalog[alias] ?? MODEL_MAP[alias];
}

/**
 * Gemini aliases already select a low/medium/high model variant. Claude's
 * thinking models also reject --effort; keep the flag for model families that
 * expose it without turning a valid tool call into an argument error.
 */
export function supportsAgyEffort(model?: AgyModel, tier?: AgyOptions["tier"]): boolean {
  return resolveAgyModelId(model, tier).startsWith("gpt-oss-");
}

const TRANSIENT_FAILURE_PATTERN =
  /rate.?limit|resource[_ -]?exhausted|429|overloaded|temporarily unavailable|network|connection (reset|refused)|econnreset|etimedout|socket hang up|\b50[023]\b/i;

/** Heuristic for transient agy failures that are safe to retry once. */
export function isTransientAgyFailure(message: string): boolean {
  return TRANSIENT_FAILURE_PATTERN.test(message);
}

export function buildAgyArgs(options: AgyOptions): string[] {
  if (options.continue && options.conversation_id) {
    throw new Error("agy cannot use --continue and --conversation together");
  }

  const model = resolveAgyModelId(options.model, options.tier);
  const timeoutSec = Math.ceil(options.timeout_ms / 1000);
  const mode = options.mode ?? "accept-edits";
  const writes = mode === "accept-edits";
  const skipPermissions = options.skipPermissions ?? true;
  const useStream = options.stream ?? true;
  const structured = mode !== "accept-edits" || useStream;

  const args = [
    "--model",
    model,
    "--print-timeout",
    `${timeoutSec}s`,
    "--add-dir",
    options.dir,
    // Task text must never be interpreted as agy slash commands or skills.
    "--disable-slash-commands",
    ...(mode === "sandbox" ? ["--sandbox"] : ["--mode", mode]),
    ...(writes && skipPermissions ? ["--dangerously-skip-permissions"] : []),
    ...(options.effort && supportsAgyEffort(options.model, options.tier)
      ? ["--effort", options.effort]
      : []),
  ];

  if (options.continue) {
    args.push("--continue");
  } else if (options.conversation_id) {
    args.push("--conversation", options.conversation_id);
  }

  if (structured) {
    args.push("--output-format", useStream ? "stream-json" : "json");
  }

  args.push("-p", options.prompt);
  return args;
}

export function buildAgyPrompt(
  prompt: string,
  mode: "plan" | "accept-edits" | "sandbox",
  useDigest: boolean,
  verifyCmd: string | null,
): string {
  const lines: string[] = [];
  if (mode === "plan") lines.push("Explore and produce an implementation plan only; do not edit.");
  else if (mode === "sandbox") lines.push("Work inside the sandbox; changes are isolated for preview.");
  else if (verifyCmd) lines.push(`After editing, run \`${verifyCmd}\` and fix failures until it passes.`);
  if (useDigest) lines.push("Use compact digests, not full file contents.");
  lines.push(prompt);
  return lines.join("\n");
}

function getSpawn() {
  return _require("node:child_process").spawn;
}

function appendBounded(chunks: Buffer[], total: number, data: Buffer): number {
  const remaining = MAX_CAPTURE_BYTES - total;
  if (remaining > 0) chunks.push(data.subarray(0, remaining));
  return Math.min(MAX_CAPTURE_BYTES, total + data.length);
}

export async function checkAgyHealth(
  cwd: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<void> {
  await runPreflightCommand(["--version"], cwd, signal, "agy health check", false, timeoutMs);
}

export async function checkAgyConnectivity(
  cwd: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<void> {
  const output = await runPreflightCommand(
    ["models"],
    cwd,
    signal,
    "agy connectivity check",
    true,
    timeoutMs,
  );
  const catalog = parseModelCatalog(output);
  if (Object.keys(catalog).length > 0) updateModelCatalog(catalog);
}

/**
 * Refresh model-specific quotas without spending a model turn. Newer agy
 * versions answer read-only `/usage` in print mode; older versions may not,
 * so unsupported usage reporting is deliberately best effort.
 */
const MIN_NATIVE_USAGE_VERSION = [1, 1, 11] as const;

export async function checkAgyUsage(
  cwd: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<AgyUsageSnapshot | undefined> {
  let versionOutput: string;
  try {
    versionOutput = await runPreflightCommand(
      ["--version"],
      cwd,
      signal,
      "agy version check",
      true,
      timeoutMs,
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return usageError(`could not verify native usage support: ${message}`);
  }

  const version = parseAgyVersion(versionOutput);
  if (!version) {
    return usageError("could not verify native usage support; refusing to run /usage blindly");
  }
  if (compareVersions(version, MIN_NATIVE_USAGE_VERSION) < 0) {
    return usageError(
      `headless /usage requires agy >= ${MIN_NATIVE_USAGE_VERSION.join(".")} (detected ${version.join(".")})`,
    );
  }

  try {
    const output = await runPreflightCommand(
      ["--output-format", "json", "-p", "/usage"],
      cwd,
      signal,
      "agy usage check",
      true,
      timeoutMs,
    );
    return parseAgyUsage(output);
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return usageError(message);
  }
}

function parseAgyVersion(output: string): [number, number, number] | undefined {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/m.exec(output);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined;
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function usageError(message: string): AgyUsageSnapshot {
  return {
    fetched_at: new Date().toISOString(),
    models: [],
    error: message.slice(0, 2_000),
  };
}

const MAX_USAGE_SUMMARY_CHARS = 12_000;
const MODEL_FIELD_KEYS = [
  "model",
  "model_id",
  "modelId",
  "model_name",
  "modelName",
  "displayName",
  "label",
  "group",
  "family",
  "pool",
  // agy 1.2.6 usage groups carry the family in `name` ("Gemini Models",
  // "Claude and GPT models"); the looksLikeModelName gate rejects the
  // non-model names ("Weekly Limit Remaining", "usage", …) that also use it.
  "name",
];
const REMAINING_FRACTION_KEYS = [
  "remainingFraction",
  "remaining_fraction",
  "fractionRemaining",
];
const REMAINING_PERCENT_KEYS = ["remainingPercent", "remaining_percent"];
const REMAINING_REQUEST_KEYS = ["remainingRequests", "remaining_requests", "requestsRemaining"];
const REMAINING_TOKEN_KEYS = ["remainingTokens", "remaining_tokens", "tokensRemaining"];
const WINDOW_KEYS = ["window", "period", "quotaWindow", "duration"];
const RELATIVE_RESET_KEYS = ["resetsInSeconds", "resetAfterSeconds", "reset_after_seconds"];
const RESET_KEYS = [
  "resetAt",
  "reset_at",
  "resetTime",
  "reset_time",
  "reset_timestamp",
  "quotaResetTime",
  "nextReset",
];

/** Normalize both documented and version-specific usage payloads. */
export function parseAgyUsage(output: string): AgyUsageSnapshot | undefined {
  const raw = output.trim();
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const plainTextSnapshot = parsePlainTextUsage(raw);
    if (plainTextSnapshot) return plainTextSnapshot;
    const jsonLines = raw
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .filter((line): line is unknown => line !== undefined);
    if (jsonLines.length > 0) {
      const lineSnapshot = parseAgyUsage(JSON.stringify(jsonLines));
      if (lineSnapshot?.models.length) return lineSnapshot;
    }
    return {
      fetched_at: new Date().toISOString(),
      models: [],
      raw_summary: raw.slice(0, MAX_USAGE_SUMMARY_CHARS),
    };
  }

  const entries = new Map<string, AgyQuotaEntry>();
  const visit = (value: unknown, hintedModel?: string, hintedWindow?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, hintedModel, hintedWindow);
      return;
    }
    if (!isRecord(value)) return;

    const model = findModelName(value) ?? hintedModel;
    const entry = model ? readQuotaEntry(model, value, hintedWindow) : undefined;
    if (entry) {
      const key = `${entry.model.toLowerCase()}\u0000${entry.window?.toLowerCase() ?? ""}`;
      entries.set(key, mergeQuotaEntries(entries.get(key), entry));
    }

    for (const [key, child] of Object.entries(value)) {
      visit(
        child,
        model ?? (looksLikeModelName(key) ? key : undefined),
        hintedWindow ?? quotaWindowName(key),
      );
    }
  };
  visit(parsed);

  if (entries.size === 0 && isRunEnvelope(parsed)) return undefined;

  const snapshot: AgyUsageSnapshot = {
    fetched_at: new Date().toISOString(),
    models: [...entries.values()].sort((a, b) => a.model.localeCompare(b.model)),
  };
  if (snapshot.models.length === 0) {
    snapshot.raw_summary = JSON.stringify(parsed).slice(0, MAX_USAGE_SUMMARY_CHARS);
  }
  return snapshot;
}

function parsePlainTextUsage(raw: string): AgyUsageSnapshot | undefined {
  const models: AgyQuotaEntry[] = [];
  for (const line of raw.split("\n")) {
    const match = /^\s*[-*]?\s*((?:gemini|claude|gpt(?:[- ]?oss))[^:\t—]+?)\s*(?::|\t|\s+—\s+|\s+-\s+)(.+)$/i.exec(line);
    if (!match) continue;
    let model = match[1].trim();
    const values = match[2];
    const modelWindowMatch = /\s*\((five[- ]hour|weekly|daily|monthly)\)\s*$/i.exec(model);
    if (modelWindowMatch) model = model.slice(0, modelWindowMatch.index).trim();
    const percentMatch = /(\d+(?:\.\d+)?)\s*%/.exec(values);
    const requestMatch = /(\d[\d,]*)\s+(?:requests?|reqs?)\s*(?:left|remaining)?/i.exec(values);
    const tokenMatch = /(\d[\d,]*)\s+tokens?\s*(?:left|remaining)?/i.exec(values);
    const resetMatch = /\breset(?:s| at)?\s*(?:in|at)?\s+(.+)$/i.exec(values);
    const windowMatch = /\b(five[- ]hour|weekly|daily|monthly)\b/i.exec(values);
    const entry: AgyQuotaEntry = {
      model,
      window: modelWindowMatch?.[1] ?? windowMatch?.[1],
      remaining_fraction: percentMatch ? Number(percentMatch[1]) / 100 : undefined,
      remaining_requests: requestMatch ? Number(requestMatch[1].replace(/,/g, "")) : undefined,
      remaining_tokens: tokenMatch ? Number(tokenMatch[1].replace(/,/g, "")) : undefined,
      reset_at: resetMatch?.[1]?.trim(),
    };
    if (
      entry.remaining_fraction !== undefined ||
      entry.remaining_requests !== undefined ||
      entry.remaining_tokens !== undefined ||
      entry.reset_at ||
      /\bexhausted\b/i.test(values)
    ) {
      if (/\bexhausted\b/i.test(values)) entry.remaining_fraction = 0;
      models.push(entry);
    }
  }
  return models.length
    ? { fetched_at: new Date().toISOString(), models }
    : undefined;
}

function isRunEnvelope(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.event === "result" || isRecord(value.result);
}

/** Return true when a quota record explicitly says the model is exhausted. */
export function isAgyQuotaExhausted(entry: AgyQuotaEntry | undefined): boolean {
  if (!entry) return false;
  return (
    (entry.remaining_fraction !== undefined && entry.remaining_fraction <= 0) ||
    (entry.remaining_requests !== undefined && entry.remaining_requests <= 0) ||
    (entry.remaining_tokens !== undefined && entry.remaining_tokens <= 0)
  );
}

/** Find quota windows that correspond to a concrete agy model id or label. */
export function findAgyQuotaEntries(
  snapshot: AgyUsageSnapshot | undefined,
  selectedModel: string,
): AgyQuotaEntry[] {
  if (!snapshot) return [];
  return snapshot.models.filter((entry) => quotaModelsMatch(entry.model, selectedModel));
}

function quotaModelsMatch(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/\bthinking\b/g, "")
      .replace(/[^a-z0-9]/g, "");
  const leftNormalized = normalize(left);
  const rightNormalized = normalize(right);
  if (leftNormalized === rightNormalized) return true;

  const leftGroup = quotaModelGroup(leftNormalized);
  const rightGroup = quotaModelGroup(rightNormalized);
  if (leftGroup && leftGroup === rightGroup && (isQuotaGroup(leftNormalized) || isQuotaGroup(rightNormalized))) {
    return true;
  }

  const leftTier = /(low|medium|high)$/.exec(leftNormalized)?.[1];
  const rightTier = /(low|medium|high)$/.exec(rightNormalized)?.[1];
  if (leftTier && rightTier) return false;
  const leftBase = leftTier ? leftNormalized.slice(0, -leftTier.length) : leftNormalized;
  const rightBase = rightTier ? rightNormalized.slice(0, -rightTier.length) : rightNormalized;
  return leftBase === rightBase;
}

function quotaModelGroup(normalized: string): "gemini" | "claude-gpt" | undefined {
  if (normalized.startsWith("gemini")) return "gemini";
  if (normalized.startsWith("claude") || normalized.startsWith("gptoss")) return "claude-gpt";
  return undefined;
}

function isQuotaGroup(normalized: string): boolean {
  return /^(?:gemini(?:models)?|claude(?:andgpt)?models?|gptossmodels?)$/.test(normalized);
}

/** Format a compact, agent-readable quota report for tool results and TUI status. */
export function formatAgyUsage(
  snapshot: AgyUsageSnapshot | undefined,
  selectedModel?: string,
): string | undefined {
  if (!snapshot) return undefined;
  if (snapshot.models.length === 0) {
    if (snapshot.error) return `agy quota unavailable: ${snapshot.error}`;
    return snapshot.raw_summary ? `agy quota snapshot: ${snapshot.raw_summary}` : undefined;
  }

  const selectedEntries = selectedModel ? findAgyQuotaEntries(snapshot, selectedModel) : [];
  const selectedSet = new Set(selectedEntries);
  const ordered = selectedEntries.length
    ? [...selectedEntries, ...snapshot.models.filter((entry) => !selectedSet.has(entry))]
    : snapshot.models;
  const lines = ordered.map((entry) => {
    const values: string[] = [];
    if (entry.window) values.push(`${entry.window} window`);
    if (entry.remaining_fraction !== undefined) {
      const percent = entry.remaining_fraction <= 1
        ? entry.remaining_fraction * 100
        : entry.remaining_fraction;
      values.push(`${formatNumber(percent)}% remaining`);
    }
    if (entry.remaining_requests !== undefined) {
      values.push(`${formatNumber(entry.remaining_requests)} requests left`);
    }
    if (entry.remaining_tokens !== undefined) {
      values.push(`${formatNumber(entry.remaining_tokens)} tokens left`);
    }
    if (entry.reset_at) values.push(`resets ${entry.reset_at}`);
    return `- ${entry.model}: ${values.join(", ") || "quota reported without remaining amount"}`;
  });
  return `agy model quota (refreshed ${snapshot.fetched_at}):\n${lines.join("\n")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findModelName(value: Record<string, unknown>): string | undefined {
  for (const key of MODEL_FIELD_KEYS) {
    const candidate = value[key];
    if (typeof candidate === "string" && looksLikeModelName(candidate)) return candidate;
  }
  return undefined;
}

function looksLikeModelName(value: string): boolean {
  return /(?:gemini|claude|gpt[-_ ]?oss|flash|pro|sonnet|opus)/i.test(value);
}

function readQuotaEntry(
  model: string,
  value: Record<string, unknown>,
  hintedWindow?: string,
): AgyQuotaEntry | undefined {
  // Normalize window spellings ("5h" → "five-hour") so reports and merge
  // keys stay consistent across CLI versions.
  const rawWindow = readString(value, WINDOW_KEYS);
  const window = (rawWindow ? quotaWindowName(rawWindow) ?? rawWindow : undefined) ?? hintedWindow;
  const fraction = readNumber(value, REMAINING_FRACTION_KEYS);
  const percent = readNumber(value, REMAINING_PERCENT_KEYS);
  const normalizedFraction = fraction ?? (percent !== undefined ? percent / 100 : undefined);
  const requests = readNumber(value, REMAINING_REQUEST_KEYS);
  const tokens = readNumber(value, REMAINING_TOKEN_KEYS);
  const reset = readReset(value, RESET_KEYS, RELATIVE_RESET_KEYS);
  const exhausted =
    value.exhausted === true || value.isExhausted === true || value.is_exhausted === true;
  if (
    // A disabled limit is not in effect and carries no availability signal —
    // recording its remaining fraction would mislead model selection.
    value.disabled === true ||
    (normalizedFraction === undefined &&
      requests === undefined &&
      tokens === undefined &&
      !reset &&
      !exhausted)
  ) {
    return undefined;
  }
  return {
    model,
    window,
    remaining_fraction: exhausted ? 0 : normalizedFraction,
    remaining_requests: requests,
    remaining_tokens: tokens,
    reset_at: reset,
  };
}

function quotaWindowName(value: string): string | undefined {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized === "weekly") return "weekly";
  if (normalized === "daily") return "daily";
  if (normalized === "monthly") return "monthly";
  if (normalized === "fivehour" || normalized === "5h") return "five-hour";
  return undefined;
}

function mergeQuotaEntries(existing: AgyQuotaEntry | undefined, next: AgyQuotaEntry): AgyQuotaEntry {
  return {
    model: existing?.model ?? next.model,
    window: existing?.window ?? next.window,
    remaining_fraction: next.remaining_fraction ?? existing?.remaining_fraction,
    remaining_requests: next.remaining_requests ?? existing?.remaining_requests,
    remaining_tokens: next.remaining_tokens ?? existing?.remaining_tokens,
    reset_at: next.reset_at ?? existing?.reset_at,
  };
}

function readNumber(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    const number = typeof candidate === "number" ? candidate : typeof candidate === "string" ? Number(candidate) : NaN;
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function readString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function readReset(
  value: Record<string, unknown>,
  keys: string[],
  relativeKeys: string[],
): string | undefined {
  for (const key of relativeKeys) {
    const seconds = readNumber(value, [key]);
    if (seconds !== undefined && seconds >= 0) return `in ${formatDuration(seconds)}`;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      const milliseconds = candidate < 1e12 ? candidate * 1000 : candidate;
      const date = new Date(milliseconds);
      if (Number.isFinite(date.getTime())) return date.toISOString();
    }
  }
  return undefined;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

/**
 * Terminate a spawned agy process and any tools it started. Node's `signal`
 * and `timeout` spawn options only kill the direct child, so cancel/timeout
 * must kill the whole process group — otherwise a nested tool can keep
 * modifying files after Pi reported cancellation.
 */
export function killProcessTree(child: ChildProcess): void {
  try {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.pid && process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    return;
  }
  const escalate = setTimeout(() => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        if (child.pid && process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGKILL");
            return;
          } catch {
            // Fall through to direct kill.
          }
        }
        child.kill("SIGKILL");
      }
    } catch {
      // Best effort: the close handler reports the real outcome.
    }
  }, 2000);
  (escalate as unknown as { unref?: () => void }).unref?.();
}

async function runPreflightCommand(
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  label: string,
  capture: boolean,
  timeoutMs?: number,
): Promise<string> {
  if (signal?.aborted) throw new Error(`${label} was cancelled`);
  const spawn = getSpawn();
  const timeout = Math.max(1, Math.min(PREFLIGHT_TIMEOUT_MS, timeoutMs ?? PREFLIGHT_TIMEOUT_MS));
  const child = spawn("agy", args, {
    cwd,
    stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"],
    // Managed manually below so cancellation kills the process group.
    detached: process.platform !== "win32",
  });
  let timedOut = false;
  const onAbort = () => killProcessTree(child);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child);
  }, timeout);
  (timer as unknown as { unref?: () => void }).unref?.();

  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr.on("data", (d: Buffer) => {
    stderrBytes = appendBounded(stderr, stderrBytes, d);
  });

  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  if (capture) {
    child.stdout?.on("data", (d: Buffer) => {
      stdoutBytes = appendBounded(stdout, stdoutBytes, d);
    });
  }

  let settled = false;

  await new Promise<void>((resolve, reject) => {
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    child.on("error", (err: Error) => {
      done(() => {
        if (signal?.aborted && !timedOut) reject(new Error(`${label} was cancelled`));
        else if (timedOut) reject(new Error(`${label} timed out`));
        else if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(`Antigravity CLI is not installed. ${INSTALL_HINT}`));
        } else reject(new Error(`${label} failed: ${err.message}`));
      });
    });

    child.on("close", (code: number | null) => {
      done(() => {
        if (signal?.aborted && !timedOut) {
          reject(new Error(`${label} was cancelled`));
          return;
        }
        if (code === 0 && !timedOut) resolve();
        else if (timedOut || code === null) {
          reject(new Error(`${label} timed out`));
        } else {
          const msg = Buffer.concat(stderr).toString("utf8").trim();
          const status = `exit ${code}`;
          // A failing --version probe usually means the CLI is present but
          // not authenticated; every failure names the check that failed.
          const authHint =
            args[0] === "--version"
              ? " — Antigravity CLI is not authenticated or not working"
              : "";
          reject(
            new Error(
              `${label} failed${authHint} (${status}). ${msg || "Run 'agy' interactively to authenticate."}`,
            ),
          );
        }
      });
    });
  });

  const stdoutText = capture ? Buffer.concat(stdout).toString("utf8") : "";
  // Stdout only: stderr diagnostics must never leak into catalog parsing.
  return stdoutText;
}

export function getAgyConversationId(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const conversationId = (error as { conversation_id?: unknown }).conversation_id;
  return typeof conversationId === "string" ? conversationId : undefined;
}

export function spawnAgy(options: AgyOptions, signal: AbortSignal): Promise<string> {
  return spawnAgyInternal(options, signal).then((result) => result.response);
}

/** Real agy work (tool steps / model responses), as opposed to lifecycle chatter. */
function isActivityProgress(parsed: AgyStreamLine): boolean {
  const step = parsed.step_update;
  return step?.step_type === "tool" || step?.step_type === "agent_response";
}

export function spawnAgyStream(
  options: AgyOptions,
  signal: AbortSignal,
  onProgress?: AgyProgressHandler,
): Promise<AgyRunResult> {
  return spawnAgyInternal(options, signal, onProgress);
}

function spawnAgyInternal(
  options: AgyOptions,
  signal: AbortSignal,
  onProgress?: AgyProgressHandler,
): Promise<AgyRunResult> {
  const spawn = getSpawn();
  const args = buildAgyArgs(options);
  // The parent process owns the hard deadline; agy's second-based timeout is
  // rounded up, so do not add grace time here.
  const alignedTimeout = Math.max(1, options.timeout_ms);

  return new Promise<AgyRunResult>((resolve, reject) => {
    if (signal.aborted) {
      reject(withConversationId("agy was cancelled", { response: "" }));
      return;
    }
    const child = spawn("agy", args, {
      cwd: options.dir,
      stdio: ["ignore", "pipe", "pipe"],
      // Managed manually so abort/timeout kills nested tool processes too.
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    const onAbort = () => killProcessTree(child);
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, alignedTimeout);
    (timer as unknown as { unref?: () => void }).unref?.();

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let lineBuffer = "";
    let runResult: AgyRunResult = { response: "" };
    const decoder = new StringDecoder("utf8");

    const processStdoutText = (text: string): void => {
      if (!text) return;
      const chunk = appendStreamChunk(lineBuffer, text, onProgress);
      lineBuffer = chunk.lineBuffer;
      for (const line of chunk.lines) {
        runResult = processStreamLine(line, runResult, onProgress);
      }
    };

    child.stdout.on("data", (d: Buffer) => {
      const before = stdoutBytes;
      stdoutBytes = appendBounded(stdout, stdoutBytes, d);
      // The raw buffer is only a fallback; flag overflow so a verbatim
      // response is never served as silently truncated text.
      if (before + d.length > stdoutBytes) stdoutTruncated = true;
      processStdoutText(decoder.write(d));
    });

    child.stderr.on("data", (d: Buffer) => {
      stderrBytes = appendBounded(stderr, stderrBytes, d);
    });

    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };

    child.on("error", (err: Error) => {
      done(() => {
        const message =
          signal.aborted && !timedOut
            ? "agy was cancelled"
            : timedOut
              ? "agy timed out"
              : (err as NodeJS.ErrnoException).code === "ENOENT"
                ? `Antigravity CLI not found in PATH. ${INSTALL_HINT}`
                : `agy spawn failed: ${err.message}`;
        reject(withConversationId(message, runResult));
      });
    });

    child.on("close", (code: number | null, sig: string | null) => {
      done(() => {
        const out = Buffer.concat(stdout).toString("utf8");
        const err = Buffer.concat(stderr).toString("utf8");

        // Flush a partial UTF-8 sequence before handling the final record.
        processStdoutText(decoder.end());

        // JSONL producers normally terminate every record with a newline, but
        // process failures can leave the final record unterminated. Parse it
        // before handling the exit code so retry logic sees real activity and
        // users still receive the terminal progress update. The remainder is
        // bounded by appendStreamChunk, so no length check is needed here.
        if (lineBuffer.trim()) {
          runResult = processStreamLine(lineBuffer, runResult, onProgress);
        }

        // A fully delivered result outranks the kill: when cancellation or
        // timeout lands after the response arrived, the work is done and the
        // response must not be discarded.
        if (runResult.response_complete) {
          resolve(finalizeRunResult(out, runResult));
          return;
        }

        if (sig === "SIGTERM" || sig === "SIGKILL" || code === null) {
          reject(
            withConversationId(
              signal.aborted && !timedOut ? "agy was cancelled" : "agy timed out",
              runResult,
            ),
          );
          return;
        }

        if (code !== 0) {
          const detail = (err || out).slice(0, 2000).trim();
          reject(withConversationId(`agy exited with code ${code}:\n${detail || "(no output)"}`, runResult));
          return;
        }

        // agy writes diagnostics to stderr even on successful runs. Keep it
        // out of the response so JSON/stream parsing remains deterministic.
        const finalized = finalizeRunResult(out, runResult);
        // Only responses served verbatim from the bounded raw capture can be
        // incomplete; anything parsed from a record was delivered in full.
        if (stdoutTruncated && !finalized.response_complete) {
          finalized.response += `\n\n(raw stdout capture was truncated at the ${MAX_CAPTURE_BYTES / 1024} KB fallback bound)`;
        }
        resolve(finalized);
      });
    });
  });
}

function withConversationId(message: string, runResult: AgyRunResult): Error {
  const error = new Error(message) as Error & { conversation_id?: string };
  if (runResult.conversation_id) error.conversation_id = runResult.conversation_id;
  return error;
}

function processStreamLine(
  line: string,
  current: AgyRunResult,
  onProgress?: AgyProgressHandler,
): AgyRunResult {
  const parsed = parseStreamLine(line);
  if (!parsed) return current;

  const next = accumulateRunResult(parsed, current);
  const activity = isActivityProgress(parsed);
  const progress = formatStepProgress(parsed);
  if (progress) onProgress?.(progress, activity ? "activity" : "status");
  else if (activity) onProgress?.("agy: working…", "activity");
  return next;
}

// Re-export for tests that imported detectVerifyCommand from cli in upstream.
export async function detectVerifyCommandFromPackageJson(cwd: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    if (pkg?.scripts?.test) return "npm test";
  } catch {
    // ignore
  }
  return null;
}
