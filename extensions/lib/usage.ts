/**
 * Usage/quotas parsing and formatting.
 *
 * Split out of `lib/cli.ts`: pure payload normalization with no process,
 * catalog, or spawn state, so it can be tested and reasoned about in isolation.
 * `cli.ts` re-exports the public surface, so existing importers are untouched.
 */

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

export function usageError(message: string): AgyUsageSnapshot {
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
