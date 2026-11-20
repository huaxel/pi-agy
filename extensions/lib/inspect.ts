/**
 * Capability inspection: version, health, models, connectivity, agents, and
 * usage checks against the agy CLI, plus the live model-catalog state they
 * feed. Split out of `lib/cli.ts`; `cli.ts` re-exports the public surface
 * so existing importers are untouched.
 */

import { parseAgyModelIds, type AgyModelId } from "./provider-models.js";

import { compareModelIds } from "./model-sort.js";
import { runPreflightCommand } from "./spawn.js";
import { parseAgyUsage, usageError, type AgyUsageSnapshot } from "./usage.js";
import { AGY_MODEL_ALIASES, type AgyModel } from "./cli.js";

/**
 * Alias matching is structural, never a literal model name.
 *
 * An alias is `family` or `family-<effort>` (see `AGY_MODEL_ALIASES`). It
 * matches an `agy models` id when the alias's hyphen-separated tokens appear
 * contiguously in the id — and, for an effort alias, only as the id's trailing
 * tokens. `…-flash-low` therefore matches `flash-low` but not `flash-medium`,
 * and a tier the vendor retires stops matching instead of resolving to an
 * invented id. New families and renames resolve with no code change.
 */
const EFFORT_TOKENS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Release-channel qualifiers that may trail an id (`…-flash-medium-preview`).
 * Structural, not model-specific: these describe maturity, not a family, and
 * stripping them lets a preview catalog resolve while `isStableModelId` still
 * keeps such ids out of the default catalog.
 */
const QUALIFIER_TOKENS: readonly string[] = ["preview", "experimental", "beta", "alpha", "snapshot", "next"];

export type AgyModelAliasMatcher = (alias: AgyModel, id: string) => boolean;

function findTokenRun(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  const last = haystack.length - needle.length;
  for (let start = 0; start <= last; start++) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}

function aliasTokens(alias: string): string[] {
  return alias.toLowerCase().split("-").filter(Boolean);
}

/** Class tokens of an effort alias (`flash-low` -> `flash`), else undefined. */
function classTokensOf(alias: string): string[] | undefined {
  const tokens = aliasTokens(alias);
  if (tokens.length < 2) return undefined;
  if (!EFFORT_TOKENS.includes(tokens[tokens.length - 1])) return undefined;
  return tokens.slice(0, -1);
}

/** Does this catalog id satisfy the alias? Pure token comparison. */
export function aliasMatchesModelId(alias: string, id: string): boolean {
  const tokens = aliasTokens(alias);
  const idTokens = id.toLowerCase().split("-").filter(Boolean);
  if (tokens.length === 0) return false;
  const namesEffort = EFFORT_TOKENS.includes(tokens[tokens.length - 1]);
  const start = findTokenRun(idTokens, tokens);
  if (start === -1) return false;
  if (!namesEffort) return true;
  // An effort alias pins the tier: only release-channel qualifiers may follow,
  // so `…-flash-medium-preview` is still flash-medium and `…-flash-medium-x` is not.
  const trailing = idTokens.slice(start + tokens.length);
  return trailing.every((token) => QUALIFIER_TOKENS.includes(token));
}

/**
 * Class-level match used only when a family ships no effort variants at all.
 *
 * Some families have tierless IDs. Since the catalog then provides no evidence
 * that low/high aliases are distinct, only one canonical alias is retained for
 * that class (medium when offered, otherwise high, then another available
 * tier). This preserves one useful legacy selector without falsely advertising
 * multiple effort choices that all execute the same model. A family that does
 * ship variants never reaches this path, so a retired tier still fails loudly.
 */
function classMatchesModelId(classTokens: readonly string[], id: string): boolean {
  const idTokens = id.toLowerCase().split("-").filter(Boolean);
  return findTokenRun(idTokens, classTokens) !== -1;
}

// Tierless families have no evidence for distinguishing their effort aliases.
// Keep only one canonical alias: prefer the ordinary middle tier, then the
// strongest available tier, then the first remaining supported tier.
const TIERLESS_ALIAS_PREFERENCE = ["medium", "high", "low", "xhigh", "max"] as const;

/** Does this concrete id already name its tier (`…-flash-low`)? */
export function namesEffortTierInId(id: string): boolean {
  const idTokens = id.toLowerCase().split("-").filter(Boolean);
  return idTokens.length > 0 && EFFORT_TOKENS.includes(idTokens[idTokens.length - 1]!);
}

/**
 * Effort tiers agy accepts on a base slug, derived from the live catalog.
 *
 * agy's own error text defines the rule: `--effort T` is accepted for a base
 * `B` exactly when the catalog carries `B-T` ("has no \"high\" effort
 * (available: low, medium, high)"), is a **conflict** for a tier-qualified id
 * ("--model …-medium conflicts with --effort=high"), and is **unsupported**
 * for a family that ships no tiers. A tier-qualified id therefore answers
 * with no tiers at all, and no vendor name is consulted. Verified against
 * agy 1.5.13.
 */
export function effortTiersForModelId(
  baseId: string,
  ids: readonly string[] = Object.values(modelCatalog),
): string[] {
  if (namesEffortTierInId(baseId)) return [];
  const prefix = `${baseId}-`;
  const tiers = new Set<string>();
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue;
    const suffix = id.slice(prefix.length).toLowerCase();
    if (EFFORT_TOKENS.includes(suffix)) tiers.add(suffix);
  }
  return [...tiers].sort(
    (left, right) => EFFORT_TOKENS.indexOf(left) - EFFORT_TOKENS.indexOf(right),
  );
}

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
  const ids: string[] = [];
  for (const line of output.split("\n")) {
    const id = line.trim().split(/\s+/)[0] ?? "";
    if (!id) continue;
    if (!allow && !isStableModelId(id)) continue;
    ids.push(id);
  }

  const found: AgyModelCatalog = {};
  const unanswered: AgyModel[] = [];
  for (const alias of AGY_MODEL_ALIASES) {
    for (const id of ids) {
      // A catalog line that is just the alias name is the CLI's own shortcut,
      // not a concrete model: letting it win would shadow the real family id.
      if (id === alias) continue;
      if (aliasMatchesModelId(alias, id) && compareModelIds(id, found[alias] ?? "") > 0) {
        found[alias] = id;
      }
    }
    if (found[alias] === undefined) unanswered.push(alias);
  }

  const fallbackGroups = new Map<string, { classTokens: string[]; aliases: AgyModel[] }>();
  for (const alias of unanswered) {
    const classTokens = classTokensOf(alias);
    if (!classTokens) continue;
    const key = classTokens.join("-");
    const group = fallbackGroups.get(key) ?? { classTokens, aliases: [] };
    group.aliases.push(alias);
    fallbackGroups.set(key, group);
  }
  for (const { classTokens, aliases } of fallbackGroups.values()) {
    const candidates = ids.filter((id) => classMatchesModelId(classTokens, id));
    // A class that ships any effort variant is tier-aware: its aliases must
    // match the requested tier or fail, never fall back to another tier.
    if (candidates.length === 0 || candidates.some(namesEffortTierInId)) continue;
    const canonicalAlias = aliases.sort((left, right) => {
      const leftTier = aliasTokens(left).at(-1) ?? "";
      const rightTier = aliasTokens(right).at(-1) ?? "";
      return TIERLESS_ALIAS_PREFERENCE.indexOf(leftTier as typeof TIERLESS_ALIAS_PREFERENCE[number]) -
        TIERLESS_ALIAS_PREFERENCE.indexOf(rightTier as typeof TIERLESS_ALIAS_PREFERENCE[number]);
    })[0];
    if (!canonicalAlias) continue;
    const latest = candidates.reduce(
      (selected, id) => compareModelIds(id, selected) > 0 ? id : selected,
      "",
    );
    if (latest) found[canonicalAlias] = latest;
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

/** Raw delegation roster; successful empty/malformed output is not availability. */
export async function inspectAgyModelIds(
  cwd: string, signal?: AbortSignal, timeoutMs?: number,
): Promise<AgyModelId[]> {
  const output = await runPreflightCommand(
    ["models"], cwd, signal, "agy model discovery", true, timeoutMs,
  );
  const ids = parseAgyModelIds(output);
  if (!ids.length) throw new Error("agy models returned no valid model IDs");
  return ids;
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
