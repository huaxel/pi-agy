/**
 * Antigravity provider model catalog.
 *
 * Projects `agy models` output into Pi provider model entries so agy-backed
 * models appear in the global `/model` picker as `antigravity/<id>`.
 *
 * `agy models` prints one model per line: `<slug>  <display label>`. Only the
 * first column (the slug) is a valid `--model` value; the label is
 * display-only. Gemini bases with multiple effort tiers collapse to a single
 * base entry with a thinking-level toggle (the picked level is sent as agy
 * `--effort`); fixed-thinking families (Claude, GPT-OSS, single-tier Gemini)
 * keep agy's exact qualified slug and never receive `--effort`.
 *
 * Pure functions only — no spawning, no Pi imports — so the catalog is
 * unit-testable without the CLI.
 */

/** Reasoning-effort tiers agy accepts via `--effort`. */
export type AgyProviderEffort = "low" | "medium" | "high";

/** Pi thinking levels that map onto agy effort tiers. */
export type AgyThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const EFFORT_RANK: Record<AgyProviderEffort, number> = { low: 0, medium: 1, high: 2 };

const EFFORT_ORDER: readonly AgyProviderEffort[] = ["low", "medium", "high"];

/** Split an agy slug into (base, tier); tier is null without a tier suffix. */
const TIER_RE = /^(.+)-(high|medium|low)$/;

/**
 * Validate the first column of an `agy models` line so banners, auth
 * prompts, or progress chatter ("Fetching models…") can never register as a
 * model, and a leading-dash token cannot reach agy's flag parser as `--model`.
 */
const MODEL_LINE_RE = /^[A-Za-z0-9][A-Za-z0-9._]*-[A-Za-z0-9._-]*$/;

/**
 * Families verified to accept base-slug + `--effort`. Only these collapse to
 * a base entry with a thinking toggle; every other family keeps agy's exact
 * qualified slug so unknown or fixed-thinking families degrade safely instead
 * of forcing an unsupported `--effort`.
 */
const EFFORT_CAPABLE_FAMILIES: readonly RegExp[] = [/^gemini-/];

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
    case "xhigh":
    case "max":
      candidate = "high";
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
 * as is any of low/medium/high the base does not offer. Pi treats null as
 * hidden, so the toggle shows exactly agy's stops.
 */
export function thinkingMapForEfforts(
  efforts: readonly AgyProviderEffort[],
): Partial<Record<AgyThinkingLevel, string | null>> {
  const map: Partial<Record<AgyThinkingLevel, string | null>> = {
    off: null,
    minimal: null,
  };
  for (const level of ["low", "medium", "high"] as const) {
    if (!efforts.includes(level)) map[level] = null;
  }
  return map;
}

/**
 * Parse raw `agy models` text into provider entries. Effort-capable Gemini
 * bases with >= 2 tier variants collapse to one base entry carrying the tiers
 * they accept; everything else keeps agy's exact qualified slug. Insertion
 * order of first-seen bases is preserved.
 */
export function parseProviderCatalog(raw: string): AgyProviderModelEntry[] {
  const groups = new Map<string, { lines: string[]; tiers: Set<AgyProviderEffort> }>();
  for (const line of raw.split("\n")) {
    const slug = line.trim().split(/\s+/)[0] ?? "";
    if (!slug || !MODEL_LINE_RE.test(slug)) continue;
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
    if (efforts.length >= 2 && EFFORT_CAPABLE_FAMILIES.some((re) => re.test(base))) {
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
 * Fallback catalog when `agy models` fails at load (binary missing, auth not
 * yet done, network stall). Keeps the picker populated so selection yields a
 * clear runtime error instead of an empty list. Update when agy ships new
 * Gemini versions.
 */
export const FALLBACK_PROVIDER_MODELS: AgyProviderModelEntry[] = [
  { full: "gemini-3.8-flash", id: "gemini-3-8-flash", efforts: ["low", "medium", "high"] },
  { full: "gemini-3.1-pro", id: "gemini-3-1-pro", efforts: ["low", "high"] },
  { full: "claude-sonnet-4-6", id: "claude-sonnet-4-6" },
];

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
