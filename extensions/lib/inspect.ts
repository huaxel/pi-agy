/**
 * Capability inspection: version, health, models, connectivity, agents, and
 * usage checks against the agy CLI, plus the live model-catalog state they
 * feed. Split out of `lib/cli.ts`; `cli.ts` re-exports the public surface
 * so existing importers are untouched.
 */

import { compareModelIds } from "./model-sort.js";
import { runPreflightCommand } from "./spawn.js";
import { parseAgyUsage, usageError, type AgyUsageSnapshot } from "./usage.js";
import type { AgyModel } from "./cli.js";

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

const UNSTABLE_MODEL_PATTERN =
  /(?:^|[-_.])(?:preview|experimental|beta|alpha|rc\d*|snapshot|next)(?:$|[-_.])/i;

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

export async function inspectAgyVersion(
  cwd: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<string> {
  return (
    await runPreflightCommand(
      ["--version"],
      cwd,
      signal,
      "agy health check",
      true,
      timeoutMs,
    )
  ).trim();
}

export async function checkAgyHealth(
  cwd: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<void> {
  await inspectAgyVersion(cwd, signal, timeoutMs);
}

export async function inspectAgyModels(
  cwd: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<AgyModelCatalog> {
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
  return catalog;
}

export async function checkAgyConnectivity(
  cwd: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<void> {
  await inspectAgyModels(cwd, signal, timeoutMs);
}

/** List configured custom agents without spending a model turn. */
export async function inspectAgyAgents(
  cwd: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<string[]> {
  const output = await runPreflightCommand(
    ["agents"],
    cwd,
    signal,
    "agy agents check",
    true,
    timeoutMs,
  );
  return parseAgyAgents(output);
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

const MAX_AGENT_NAME_LENGTH = 128;
const MAX_AGENT_COUNT = 200;

export function normalizeAgyAgentName(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const agent = value.trim();
  if (!agent) throw new Error("agy agent must not be empty");
  if (/[\x00-\x1f\x7f]/.test(agent)) {
    throw new Error("agy agent must not contain control characters");
  }
  if (agent.length > MAX_AGENT_NAME_LENGTH) {
    throw new Error(`agy agent must be at most ${MAX_AGENT_NAME_LENGTH} characters`);
  }
  return agent;
}

/** Parse the intentionally simple, line-oriented output of `agy agents`. */
export function parseAgyAgents(output: string): string[] {
  const agents: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (
      !line ||
      /^available\s+agents:?$/i.test(line) ||
      /^name\s+/i.test(line) ||
      /^(?:no|zero)\s+(?:custom\s+)?agents?\b/i.test(line)
    ) {
      continue;
    }
    const candidate = line
      .split(/\t|\s{2,}/, 1)[0]
      ?.replace(/^[-*]\s*/, "")
      .trim();
    try {
      const agent = normalizeAgyAgentName(candidate);
      if (agent && !agents.includes(agent)) {
        agents.push(agent);
        if (agents.length >= MAX_AGENT_COUNT) break;
      }
    } catch {
      // Ignore malformed diagnostics and overlong names from CLI output.
    }
  }
  return agents;
}
