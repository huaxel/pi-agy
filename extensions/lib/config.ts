import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { isAgyModel, type AgyModel } from "./cli.js";
import { getDefaultStorePath } from "./sessions.js";

const execFileAsync = promisify(execFile);

const COMMAND_TTL_MS = 5 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 5_000;

/**
 * Optional overrides loaded from `$PI_CODING_AGENT_DIR/agy-config.json`
 * (default `~/.pi/agent/agy-config.json`). Missing or malformed files fall
 * back to built-in defaults.
 */
export interface AgyConfig {
  /**
   * Auto-approve agy tool permission requests for accept-edits runs
   * (`--dangerously-skip-permissions`). Default `true`. When `false`,
   * accept-edits runs without the permission bypass — agy print mode has
   * no interactive approval path, so restricted operations may fail.
   */
  skipPermissions?: boolean;
  /** Default model alias when agy_execute omits model/tier (e.g. "flash-medium"). */
  defaultModel?: string;
  /**
   * Steer the default by recent usage balance when no explicit
   * `defaultModel`/`defaultModelCommand` is set: when the Gemini group
   * (flash/pro) carried `AGY_DEFAULT_MODEL_GEMINI_SHARE`% (default 75) of
   * the last `AGY_DEFAULT_MODEL_WINDOW_HOURS`h (default 24) of recorded
   * conversations (minimum `AGY_DEFAULT_MODEL_MIN_SESSIONS`, default 3),
   * the default flips to `sonnet` so routine delegation rests the hot
   * quota group. Missing/corrupt stores mean no signal (built-in default).
   */
  quotaBalancing?: boolean;
  /**
   * Shell command whose stdout is used as the default model alias when
   * `defaultModel` is unset — e.g. a quota-aware resolver. Must print a
   * single valid alias; failures and invalid output fall back to the
   * built-in default. Result cached for a few minutes per process.
   *
   * Trust boundary: executed verbatim via `sh -c`. Only point this at a
   * command you control — the config file is user-owned.
   */
  defaultModelCommand?: string;
}

export function getDefaultConfigPath(): string {
  const agentDir =
    process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "agy-config.json");
}

export async function loadAgyConfig(
  configPath = getDefaultConfigPath(),
  signal?: AbortSignal,
): Promise<AgyConfig> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(configPath, { encoding: "utf8", signal }),
    );
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const config: AgyConfig = {};
      if (typeof record.defaultModel === "string") config.defaultModel = record.defaultModel;
      if (typeof record.defaultModelCommand === "string") {
        config.defaultModelCommand = record.defaultModelCommand;
      }
      if (typeof record.quotaBalancing === "boolean") {
        config.quotaBalancing = record.quotaBalancing;
      }
      if (typeof record.skipPermissions === "boolean") {
        config.skipPermissions = record.skipPermissions;
      } else if ("skipPermissions" in record) {
        // A malformed permission setting must never silently enable bypasses.
        config.skipPermissions = false;
      }
      return config;
    }
  } catch {
    // Missing or malformed config falls back to defaults.
  }
  return {};
}

const cachedCommandAliases = new Map<string, { at: number; alias?: AgyModel }>();

/**
 * Resolve the default model alias: an explicit `defaultModel` always wins,
 * then `defaultModelCommand` runs (cached) and its output is validated,
 * then `quotaBalancing` steers by recent usage. Returns undefined for the
 * built-in fallback.
 */
export async function resolveDefaultModel(
  config: AgyConfig,
  signal?: AbortSignal,
): Promise<AgyModel | undefined> {
  const configuredModel = normalizeConfiguredModel(config.defaultModel);
  if (configuredModel) return configuredModel;
  const command = config.defaultModelCommand?.trim();
  if (command) {
    const cached = cachedCommandAliases.get(command);
    if (cached && Date.now() - cached.at < COMMAND_TTL_MS) {
      return cached.alias;
    }

    const alias = await runDefaultModelCommand(command, signal);
    if (!signal?.aborted) {
      cachedCommandAliases.set(command, { at: Date.now(), alias });
    }
    return alias;
  }
  if (config.quotaBalancing) return resolveQuotaBalancedDefault();
  return undefined;
}

async function runDefaultModelCommand(
  command: string,
  signal?: AbortSignal,
): Promise<AgyModel | undefined> {
  try {
    const { stdout } = await execFileAsync("sh", ["-c", command], {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
      signal,
    });
    const alias = stdout.trim().split("\n")[0]?.trim() ?? "";
    return isAgyModel(alias) ? alias : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Native quota balancing (replaces the external agy-default-model.sh):
 * flip the default to `sonnet` when Gemini models carried nearly all
 * recent conversations. Unreadable stores mean no signal — never throw.
 */
async function resolveQuotaBalancedDefault(): Promise<AgyModel | undefined> {
  const windowHours = envNumber("AGY_DEFAULT_MODEL_WINDOW_HOURS", 24);
  const minSessions = envNumber("AGY_DEFAULT_MODEL_MIN_SESSIONS", 3);
  const geminiShare = envNumber("AGY_DEFAULT_MODEL_GEMINI_SHARE", 75);
  let gemini = 0;
  let other = 0;
  try {
    const parsed: unknown = JSON.parse(await readFile(getDefaultStorePath(), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const cutoff = Date.now() - windowHours * 3_600_000;
    for (const record of Object.values(parsed as Record<string, unknown>)) {
      if (typeof record !== "object" || record === null) continue;
      const entry = record as {
        history?: unknown;
        last_conversation_id?: unknown;
        last_model?: unknown;
        updated_at?: unknown;
      };
      const entries: unknown[] = [
        ...(Array.isArray(entry.history) ? entry.history : []),
        ...(typeof entry.last_conversation_id === "string"
          ? [
              {
                conversation_id: entry.last_conversation_id,
                model: entry.last_model,
                updated_at: entry.updated_at,
              },
            ]
          : []),
      ];
      const seen = new Set<unknown>();
      for (const item of entries) {
        if (typeof item !== "object" || item === null) continue;
        const { conversation_id, model, updated_at } = item as {
          conversation_id?: unknown;
          model?: unknown;
          updated_at?: unknown;
        };
        if (seen.has(conversation_id)) continue;
        seen.add(conversation_id);
        const when = Date.parse(typeof updated_at === "string" ? updated_at : "");
        if (!Number.isFinite(when) || when < cutoff) continue;
        if (typeof model !== "string") continue;
        if (model.startsWith("flash") || model.startsWith("pro")) gemini++;
        else if (model === "sonnet" || model === "opus" || model === "gpt-oss") other++;
      }
    }
  } catch {
    return undefined;
  }
  const total = gemini + other;
  if (total === 0 || total < minSessions) return undefined;
  return (gemini * 100) / total >= geminiShare ? "sonnet" : undefined;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** Test helper — drop the cached default-model command result. */
function normalizeConfiguredModel(value: unknown): AgyModel | undefined {
  if (value === "flash") return "flash-medium";
  if (value === "pro") return "pro-high";
  return isAgyModel(value) ? value : undefined;
}

export function resetDefaultModelCache(): void {
  cachedCommandAliases.clear();
}
