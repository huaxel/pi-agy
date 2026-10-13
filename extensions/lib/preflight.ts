import * as path from "node:path";

import {
  checkAgyConnectivity,
  checkAgyHealth,
  checkAgyUsage,
  type AgyUsageSnapshot,
} from "./cli.js";

const TTL_MS = 5 * 60 * 1000;
const USAGE_TTL_MS = 60 * 1000;
const USAGE_FAILURE_TTL_MS = 5 * 1000;

interface PreflightEntry {
  healthAt: number;
  usageAt: number;
  usage?: AgyUsageSnapshot;
}

// Per-directory: health/quota answers depend on the working directory, so a
// single global entry would serve dir B dir A's snapshot. Bounded so long
// sessions across many checkouts cannot grow the map without limit.
const MAX_CACHED_DIRS = 32;
const entries = new Map<string, PreflightEntry>();

function entryFor(cwd: string): PreflightEntry {
  const key = path.resolve(cwd);
  let entry = entries.get(key);
  if (!entry) {
    entry = { healthAt: 0, usageAt: 0, usage: undefined };
    entries.set(key, entry);
    if (entries.size > MAX_CACHED_DIRS) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
  }
  return entry;
}

/** Run cached health/model checks and a shorter-lived model quota refresh. */
export async function runPreflight(
  cwd: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<AgyUsageSnapshot | undefined> {
  const entry = entryFor(cwd);
  const now = Date.now();
  const healthFresh = entry.healthAt > 0 && now - entry.healthAt < TTL_MS;
  const usageTtl =
    entry.usage?.error || !entry.usage ? USAGE_FAILURE_TTL_MS : USAGE_TTL_MS;
  const usageFresh = entry.usageAt > 0 && now - entry.usageAt < usageTtl;
  if (healthFresh && usageFresh) return entry.usage;
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    throw new Error("agy timed out before preflight");
  }

  const health = healthFresh
    ? Promise.resolve()
    : runHealthWithRetry(cwd, signal, timeoutMs).then(() => undefined);
  const usage = usageFresh
    ? Promise.resolve(entry.usage)
    : checkAgyUsage(cwd, signal, timeoutMs);
  const [, refreshedUsage] = await Promise.all([health, usage]);
  if (!healthFresh) entry.healthAt = Date.now();
  if (!usageFresh) {
    entry.usage = refreshedUsage;
    entry.usageAt = Date.now();
  }
  return entry.usage;
}

/**
 * Health probes with one retry on timeout. Four parallel cold agy spawns
 * can serialize behind a single OAuth refresh past the per-probe cap; the
 * retry almost always lands warm. Only timeouts retry: auth failures,
 * missing binaries, and cancellations fail fast on first attempt.
 */
async function runHealthWithRetry(
  cwd: string,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<void> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  const attempt = (): Promise<void> => {
    const remaining = deadline === undefined ? undefined : deadline - Date.now();
    if (remaining !== undefined && remaining <= 0) {
      throw new Error("agy timed out before preflight retry");
    }
    return Promise.all([
      checkAgyHealth(cwd, signal, remaining),
      checkAgyConnectivity(cwd, signal, remaining),
    ]).then(() => undefined);
  };
  try {
    await attempt();
  } catch (error) {
    if (signal?.aborted) throw error;
    if (!(error instanceof Error) || !/timed out/i.test(error.message)) throw error;
    await attempt();
  }
}

/** Test helper — reset the in-process cache. */
export function resetPreflightCache(): void {
  entries.clear();
}
