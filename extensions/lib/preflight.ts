import { checkAgyConnectivity, checkAgyHealth } from "./cli.js";

const TTL_MS = 5 * 60 * 1000;
let cachedAt = 0;

/** Run agy health/connectivity checks, cached for a few minutes per process. */
export async function runPreflight(
  cwd: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<void> {
  if (cachedAt && Date.now() - cachedAt < TTL_MS) return;
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    throw new Error("agy timed out before preflight");
  }
  await Promise.all([
    checkAgyHealth(cwd, signal, timeoutMs),
    checkAgyConnectivity(cwd, signal, timeoutMs),
  ]);
  cachedAt = Date.now();
}

/** Test helper — reset the in-process cache. */
export function resetPreflightCache(): void {
  cachedAt = 0;
}
