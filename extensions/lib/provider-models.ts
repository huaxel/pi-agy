/**
 * Antigravity provider model catalog.
 *
 * Projects `agy models` output into Pi provider model entries so agy-backed
 * models appear in the global `/model` picker as `antigravity/<id>`.
 *
 * `agy models` prints one model per line: `<slug>  <display label>`. Only the
 * first column (the slug) is a valid `--model` value; the label is
 * display-only. A base whose catalog carries two or more effort tiers collapses
 * to a single base entry with a thinking-level toggle (the picked level becomes
 * agy `--effort`). A base with one tier or none keeps agy's exact qualified
 * slug and never receives `--effort`.
 *
 * That grouping is derived from the catalog alone. Which families accept
 * `--effort` is agy's own answer to "does `B-T` exist" — tier-qualified ids are
 * rejected as a conflict and tierless families as unsupported — so no vendor
 * name needs to be known here.
 *
 * Pure functions only — no spawning, no Pi imports — so the catalog is
 * unit-testable without the CLI.
 */

/** Reasoning-effort tiers agy accepts via `--effort` (`agy --help`). */
export type AgyProviderEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Pi thinking levels that map onto agy effort tiers. */
export type AgyThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const EFFORT_RANK: Record<AgyProviderEffort, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
};

const EFFORT_ORDER: readonly AgyProviderEffort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Split an agy slug into (base, tier); tier is null without a tier suffix.
 *
 * `xhigh` and `max` belong here: when they did not, `gemini-4-neon-xhigh`
 * became its own base entry instead of a fourth stop inside the `gemini-4-neon`
 * thinking picker. Longer alternatives come first so `-xhigh` can never be
 * read as `-high`.
 */
const TIER_RE = /^(.+)-(xhigh|max|high|medium|low)$/;

/**
 * Preserve the established hyphenated first-column format. A leading-dash
 * token must never reach agy's flag parser as `--model`.
 */
const MODEL_LINE_RE = /^[A-Za-z0-9][A-Za-z0-9._]*-[A-Za-z0-9._-]*$/;

// Nonhyphen ids also occur (e.g. `argon`). Be conservative about ambiguous
// human text: require lowercase slug syntax with no trailing dot. Common
// header and diagnostic first tokens are not models. Other lowercase words
// (bare or followed by whitespace) are inherently indistinguishable from ids
// in this unstructured CLI format.
const NONHYPHEN_MODEL_ID_RE = /^[a-z0-9](?:[a-z0-9._]*[a-z0-9_])?$/;
const NON_MODEL_TOKEN_RE = /^(?:id|model|models|name|label|status|available|fetching|loading|error|warning|info|auth|authentication|unauthorized|forbidden|login|success)$/;

/** Exact CLI IDs, validated with the same token rules used by native discovery. */
declare const agyModelId: unique symbol;
export type AgyModelId = string & { readonly [agyModelId]: true };

export function isAgyModelId(value: unknown): value is AgyModelId {
  return typeof value === "string" && !/[\s\x00-\x1f\x7f-\x9f]/.test(value) && (
    MODEL_LINE_RE.test(value) ||
    (NONHYPHEN_MODEL_ID_RE.test(value) && !NON_MODEL_TOKEN_RE.test(value))
  );
}

export function validateAgyModelId(value: unknown): AgyModelId {
  if (!isAgyModelId(value)) throw new Error("agy model ID must be a nonempty CLI ID without whitespace or leading flags");
  return value;
}

/** Preserve full first-column IDs and tiers; never slugify or group delegation IDs. */
export function parseAgyModelIds(raw: string): AgyModelId[] {
  const ids = raw.split("\n").map(line => line.trim().split(/\s+/)[0]);
  return [...new Set(ids.filter(isAgyModelId))];
}

export interface AgyProviderModelEntry {
  /**
   * Exact agy `--model` value: a base slug (e.g. `gemini-3.8-flash`) when
   * effort-driven, otherwise agy's full qualified slug
   * (e.g. `claude-sonnet-4-6`).
   */
  full: string;
  /** Pi model id, e.g. `gemini-3-8-flash`. */
  id: string;
  /**
   * Present iff effort-driven: the tiers agy accepts for this base. Pi's
   * thinking toggle picks among them and `--effort` is always passed. Absent
   * means fixed thinking — never pass `--effort`.
   */
  efforts?: AgyProviderEffort[];
}

/**
 * Map a Pi thinking level onto one of the `efforts` tiers a base supports,
 * clamping to the nearest available (agy rejects tiers a base does not list,
 * e.g. medium on Pro). With no level, fall back to the first available tier.
 */
export function toProviderEffort(
  reasoning: AgyThinkingLevel | undefined,
  efforts: readonly AgyProviderEffort[],
): AgyProviderEffort {
  let candidate: AgyProviderEffort;
  switch (reasoning) {
    case "minimal":
    case "low":
      candidate = "low";
      break;
    case "medium":
      candidate = "medium";
      break;
    case "high":
      candidate = "high";
      break;
    // agy exposes these as real stops, so pass them through instead of
    // collapsing every strong level onto "high".
    case "xhigh":
      candidate = "xhigh";
      break;
    case "max":
      candidate = "max";
      break;
    default:
      candidate = efforts[0] ?? "low";
  }
  if (efforts.includes(candidate)) return candidate;
  const index = EFFORT_ORDER.indexOf(candidate);
  for (let j = index; j < EFFORT_ORDER.length; j++) {
    if (efforts.includes(EFFORT_ORDER[j])) return EFFORT_ORDER[j];
  }
  for (let j = index - 1; j >= 0; j--) {
    if (efforts.includes(EFFORT_ORDER[j])) return EFFORT_ORDER[j];
  }
  return efforts[0] ?? "low";
}

/** `Gemini 3.8 Flash (Medium)` -> `gemini-3-8-flash-medium`. */
export function slugifyProviderId(full: string): string {
  return full
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build the thinking-level map for an effort-driven base: `off` and `minimal`
 * are always hidden (agy has no no-thinking mode; a base requires an effort),
 * as is any tier the base does not offer. Pi treats null as hidden, so the
 * toggle shows exactly agy's stops.
 */
export function thinkingMapForEfforts(
  efforts: readonly AgyProviderEffort[],
): Partial<Record<AgyThinkingLevel, string | null>> {
  const map: Partial<Record<AgyThinkingLevel, string | null>> = {
    off: null,
    minimal: null,
  };
  for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
    if (!efforts.includes(level)) map[level] = null;
  }
  return map;
}

/**
 * Parse raw `agy models` text into provider entries. A base with >= 2 tier
 * variants collapses to one base entry carrying the tiers it accepts;
 * everything else keeps agy's exact qualified slug. Insertion order of
 * first-seen bases is preserved.
 */
export function parseProviderCatalog(raw: string): AgyProviderModelEntry[] {
  const groups = new Map<string, { lines: string[]; tiers: Set<AgyProviderEffort> }>();
  for (const slug of parseAgyModelIds(raw)) {
    const match = TIER_RE.exec(slug);
    const base = match ? match[1] : slug;
    const tier = match ? (match[2] as AgyProviderEffort) : null;
    let group = groups.get(base);
    if (!group) {
      group = { lines: [], tiers: new Set<AgyProviderEffort>() };
      groups.set(base, group);
    }
    group.lines.push(slug);
    if (tier) group.tiers.add(tier);
  }
  const entries: AgyProviderModelEntry[] = [];
  const seenIds = new Set<string>();
  const pushEntry = (entry: AgyProviderModelEntry): void => {
    // Distinct slugs can slugify identically (e.g. `a.b` vs `a-b`); the
    // picker cannot hold duplicate ids, so first-seen wins.
    if (!entry.id || seenIds.has(entry.id)) return;
    seenIds.add(entry.id);
    entries.push(entry);
  };
  for (const [base, group] of groups) {
    const efforts = [...group.tiers].sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b]);
    if (efforts.length >= 2) {
      pushEntry({ full: base, id: slugifyProviderId(base), efforts });
    } else {
      for (const line of group.lines) {
        pushEntry({ full: line, id: slugifyProviderId(line) });
      }
    }
  }
  return entries;
}

/** Catalog equality for refresh: ids AND effort tiers (a base can gain/lose tiers). */
export function areProviderCatalogsEqual(
  left: readonly AgyProviderModelEntry[],
  right: readonly AgyProviderModelEntry[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    if (!other || entry.id !== other.id || entry.full !== other.full) return false;
    const leftEfforts = entry.efforts ?? [];
    const rightEfforts = other.efforts ?? [];
    return (
      leftEfforts.length === rightEfforts.length &&
      leftEfforts.every((effort, effortIndex) => effort === rightEfforts[effortIndex])
    );
  });
}

/** Display name for a picker entry: the exact agy `--model` value. */
export function providerEntryName(entry: AgyProviderModelEntry): string {
  return entry.full;
}

/**
 * Pre-discovery catalog.
 *
 * Intentionally empty: `agy models` is the only source of model names, so a
 * built-in list would silently offer ids the installed CLI no longer serves
 * (a retired tier then fails at launch instead of at selection). Callers treat
 * an empty catalog as "not discovered yet" and surface the discovery error.
 */
export const FALLBACK_PROVIDER_MODELS: readonly AgyProviderModelEntry[] = [];

/**
 * Plain provider model definition (structurally compatible with Pi's
 * `ProviderModelConfig`). Kept dependency-free so this module stays pure;
 * the extension entry maps these into `registerProvider` models.
 */
export interface AgyProviderModelDef {
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<AgyThinkingLevel, string | null>>;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

/** Project a catalog entry into a Pi provider model definition. */
export function toProviderModelDef(entry: AgyProviderModelEntry): AgyProviderModelDef {
  const effortDriven = !!entry.efforts && entry.efforts.length > 0;
  return {
    id: entry.id,
    name: entry.full,
    // Custom API sentinel: no built-in provider claims it, so it can never
    // collide. streamSimple intercepts every turn; baseUrl/apiKey below are
    // present only because Pi requires non-empty values.
    api: "agy-provider",
    reasoning: effortDriven,
    ...(effortDriven ? { thinkingLevelMap: thinkingMapForEfforts(entry.efforts!) } : {}),
    // Attached images are staged as files the turn can open (see
    // stageImages), so image input is genuinely served, not dropped.
    input: ["text", "image"],
    // Antigravity subscription billing flows through agy; nothing to track.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // agy does not expose per-model windows; 1M is the documented Gemini ceiling.
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  };
}
