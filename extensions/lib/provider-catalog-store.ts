/**
 * Last-good provider catalog persistence.
 *
 * The catalog is discovered at runtime and deliberately ships no hardcoded
 * model ids, so a cold process has nothing to answer `getModels()` with until
 * `agy models` returns. Pi resolves configured scopes (`enabledModels`) at
 * startup, so an empty catalog there reports `No models match pattern
 * "antigravity/<id>"` for a model that exists — the provider looked empty, not
 * the model missing.
 *
 * Persisting the last observed roster closes that window without inventing
 * model names: a fresh process starts from real, previously observed entries,
 * and discovery still replaces them. Loading is synchronous because it feeds
 * provider registration; both directions are best effort and never throw, so a
 * corrupt or unwritable cache degrades to today's empty-start behaviour.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { getDefaultConfigPath } from "./config.js";
import {
  EFFORT_ORDER,
  isAgyModelId,
  type AgyProviderEffort,
  type AgyProviderModelEntry,
} from "./provider-models.js";

const CACHE_FILENAME = "agy-provider-models.json";
const MAX_CACHED_ENTRIES = 500;


let observedCatalog: { source: "cache" | "live"; count: number; observedAt: number } | undefined;

export interface ProviderCatalogProvenance {
  source: "live" | "cache" | "empty";
  count: number;
  ageMs?: number;
}

/**
 * Record the roster the provider is actually serving. Only the provider's
 * catalog owner calls this: loading the cache for another reason (the bridge's
 * discovery fallback) or failing to persist a live roster must not change what
 * status surfaces report about the provider.
 */
export function recordProviderCatalogProvenance(source: "cache" | "live", count: number): void {
  observedCatalog = count > 0 ? { source, count, observedAt: Date.now() } : undefined;
}

/** Passive provenance for the roster the provider last started from or discovered. */
export function getProviderCatalogProvenance(
  configPath = getDefaultConfigPath(),
): ProviderCatalogProvenance {
  if (!observedCatalog || observedCatalog.count === 0) {
    return { source: "empty", count: 0 };
  }
  let observedAt = observedCatalog.observedAt;
  if (observedCatalog.source === "cache") {
    try {
      observedAt = statSync(providerCatalogCachePath(configPath)).mtimeMs;
    } catch {
      // Keep the in-memory observation time if the cache disappears.
    }
  }
  return {
    source: observedCatalog.source,
    count: observedCatalog.count,
    ageMs: Math.max(0, Date.now() - observedAt),
  };
}

export function providerCatalogCachePath(configPath = getDefaultConfigPath()): string {
  return path.join(path.dirname(configPath), CACHE_FILENAME);
}

/**
 * Validate one cached entry; anything malformed is dropped, not repaired.
 *
 * `full` becomes an argv value (`--model <full>`), so it is held to the same
 * rule the live parser applies to `agy models` output: no whitespace, no
 * control characters, and no leading `-`. Without that, a writable cache file
 * could smuggle a flag into the argv stream — `--dangerously-skip-permissions`
 * as a "model id" — which the discovery path already refuses.
 */
function toEntry(value: unknown): AgyProviderModelEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!isAgyModelId(record.full) || !isAgyModelId(record.id)) return undefined;
  const entry: AgyProviderModelEntry = { full: record.full, id: record.id };
  if (Array.isArray(record.efforts)) {
    const efforts = record.efforts.filter(
      (effort): effort is AgyProviderEffort =>
        typeof effort === "string" && (EFFORT_ORDER as readonly string[]).includes(effort),
    );
    // A base entry is only effort-driven when it still carries usable tiers.
    if (efforts.length > 0) entry.efforts = [...new Set(efforts)];
  }
  return entry;
}

/** Read the last-good catalog. Returns `[]` when absent, unreadable, or invalid. */
export function loadProviderCatalogCache(configPath = getDefaultConfigPath()): AgyProviderModelEntry[] {
  let raw: string;
  try {
    raw = readFileSync(providerCatalogCachePath(configPath), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { models?: unknown }).models)
        ? (parsed as { models: unknown[] }).models
        : [];
    const entries: AgyProviderModelEntry[] = [];
    const seen = new Set<string>();
    for (const value of list.slice(0, MAX_CACHED_ENTRIES)) {
      const entry = toEntry(value);
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Persist the roster just discovered. Writes a sibling temp file and renames,
 * so a crash mid-write can never leave a half-parsed cache behind.
 */
export function saveProviderCatalogCache(
  entries: readonly AgyProviderModelEntry[],
  configPath = getDefaultConfigPath(),
): void {
  if (entries.length === 0) return;
  const target = providerCatalogCachePath(configPath);
  // A predictable `${target}.${pid}.tmp` name is a clobber primitive: anyone
  // who can write in the agent directory can plant a symlink there and have a
  // successful refresh follow it and truncate whatever it points at. The name
  // is unguessable and `wx` refuses to open a file that already exists, so the
  // only file this can ever write is the one it just created.
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    const payload = JSON.stringify(
      { version: 1, models: entries.slice(0, MAX_CACHED_ENTRIES) },
      null,
      2,
    );
    writeFileSync(temp, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    created = true;
    renameSync(temp, target);
  } catch {
    // Best effort: an unwritable cache must never fail a refresh. `wx` failing
    // means the path was not ours, so only a file this call created is removed.
    if (!created) return;
    try {
      unlinkSync(temp);
    } catch {
      // Nothing to clean up.
    }
  }
}

/** Test helper — drop the persisted roster. */
export function clearProviderCatalogCache(configPath = getDefaultConfigPath()): void {
  try {
    unlinkSync(providerCatalogCachePath(configPath));
  } catch {
    // Absent is already the desired state.
  }
}
