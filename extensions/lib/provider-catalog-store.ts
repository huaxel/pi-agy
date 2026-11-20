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

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { getDefaultConfigPath } from "./config.js";
import type { AgyProviderEffort, AgyProviderModelEntry } from "./provider-models.js";

const CACHE_FILENAME = "agy-provider-models.json";
const MAX_CACHED_ENTRIES = 500;
const EFFORT_VALUES: readonly AgyProviderEffort[] = ["low", "medium", "high"];

export function providerCatalogCachePath(configPath = getDefaultConfigPath()): string {
  return path.join(path.dirname(configPath), CACHE_FILENAME);
}

/** Validate one cached entry; anything malformed is dropped, not repaired. */
function toEntry(value: unknown): AgyProviderModelEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.full !== "string" || !record.full.trim()) return undefined;
  if (typeof record.id !== "string" || !record.id.trim()) return undefined;
  const entry: AgyProviderModelEntry = { full: record.full, id: record.id };
  if (Array.isArray(record.efforts)) {
    const efforts = record.efforts.filter(
      (effort): effort is AgyProviderEffort =>
        typeof effort === "string" && (EFFORT_VALUES as readonly string[]).includes(effort),
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
  const temp = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    const payload = JSON.stringify(
      { version: 1, models: entries.slice(0, MAX_CACHED_ENTRIES) },
      null,
      2,
    );
    writeFileSync(temp, payload, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, target);
  } catch {
    // Best effort: an unwritable cache must never fail a refresh.
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
