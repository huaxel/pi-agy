import {
  checkAgyConnectivity,
  checkAgyHealth,
  checkAgyUsage,
  type AgyUsageSnapshot,
} from "./cli.js";

const TTL_MS = 5 * 60 * 1000;
const USAGE_TTL_MS = 60 * 1000;
const USAGE_FAILURE_TTL_MS = 5 * 1000;
let cachedAt = 0;
let cachedUsageAt = 0;
let cachedUsage: AgyUsageSnapshot | undefined;

/** Run cached health/model checks and a shorter-lived model quota refresh. */
export async function runPreflight(
  cwd: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<AgyUsageSnapshot | undefined> {
  const now = Date.now();
  const healthFresh = cachedAt > 0 && now - cachedAt < TTL_MS;
  const usageTtl = cachedUsage?.error || !cachedUsage ? USAGE_FAILURE_TTL_MS : USAGE_TTL_MS;
  const usageFresh = cachedUsageAt > 0 && now - cachedUsageAt < usageTtl;
  if (healthFresh && usageFresh) return cachedUsage;
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    throw new Error("agy timed out before preflight");
  }

  const health = healthFresh
    ? Promise.resolve()
    : Promise.all([
        checkAgyHealth(cwd, signal, timeoutMs),
        checkAgyConnectivity(cwd, signal, timeoutMs),
      ]).then(() => undefined);
  const usage = usageFresh ? Promise.resolve(cachedUsage) : checkAgyUsage(cwd, signal, timeoutMs);
  const [, refreshedUsage] = await Promise.all([health, usage]);
  if (!healthFresh) cachedAt = Date.now();
  if (!usageFresh) {
    cachedUsage = refreshedUsage;
    cachedUsageAt = Date.now();
  }
  return cachedUsage;
}

/** Test helper — reset the in-process cache. */
export function resetPreflightCache(): void {
  cachedAt = 0;
  cachedUsageAt = 0;
  cachedUsage = undefined;
}
