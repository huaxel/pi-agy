/**
 * Transient-failure classification for agy runs.
 *
 * Split out of `lib/cli.ts`: pure string matching with no process or catalog
 * state. `cli.ts` re-exports the classifier for existing importers.
 */

const TRANSIENT_FAILURE_PATTERN =
  /rate.?limit|resource[_ -]?exhausted|429|overloaded|temporarily unavailable|network|connection (reset|refused)|econnreset|etimedout|socket hang up|\b50[023]\b/i;

function parseStructuredRetryability(message: string): boolean | undefined {
  for (const line of message.split(/\r?\n/)) {
    const match = line.match(/^\s*AGY_ERROR:\s*(\{.*\})\s*$/);
    if (!match) continue;
    try {
      const parsed: unknown = JSON.parse(match[1]);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { retryable?: unknown }).retryable === "boolean"
      ) {
        return (parsed as { retryable: boolean }).retryable;
      }
    } catch {
      // Malformed structured diagnostics fall back to legacy text matching.
    }
  }
  return undefined;
}

/** Heuristic for transient agy failures that are safe to retry once. */
export function isTransientAgyFailure(message: string): boolean {
  return parseStructuredRetryability(message) ?? TRANSIENT_FAILURE_PATTERN.test(message);
}
