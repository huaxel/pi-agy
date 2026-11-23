/**
 * agy writes diagnostics to stderr even on successful runs. Most of it is
 * noise, but its `warning:` lines change what actually happened: `warning:
 * --mode plan has no effect while slash command expansion is disabled` once
 * meant every plan delegation wrote files instead. That line sat unread in a
 * stderr tail that was only printed on failure, so behavior diverged from the
 * request with nothing in the UI saying so.
 *
 * Only those warnings are surfaced, bounded, deduped and capped so a chatty
 * CLI cannot flood progress or the footer.
 */

const NOTABLE_STDERR = /^warning:/i;
/**
 * A sign-in prompt is the most consequential stderr line agy writes, and it is
 * not a warning. It arrives as `Authentication required. Please visit the URL
 * to log in:` followed by the URL, then `Waiting for authentication`. Report a
 * fixed label instead: the URL is long, single-use, and belongs in a terminal.
 */
// Captured shapes (agy 1.5.13): print mode writes `Authentication required.
// Please visit the URL to log in:`, stream-json writes `Error: authentication
// required. Run 'agy' to log in, then retry.`, both then repeat a wait notice.
const AUTH_REQUIRED_STDERR = /authentication required|waiting for authentication/i;

export const MAX_STDERR_WARNING_CHARS = 300;
export const MAX_STDERR_WARNINGS = 8;
/**
 * Key for the one-shot sign-in report. It shares `seen` with the warnings for
 * dedupe, but it is not a warning: counting it against the cap would silently
 * drop one real warning from a signed-out run.
 */
const AUTH_REQUIRED_KEY = "auth-required";

/** Reportable warnings already emitted, ignoring non-warning markers in `seen`. */
function warningCount(seen: ReadonlySet<string>): number {
  let count = 0;
  for (const key of seen) {
    if (key !== AUTH_REQUIRED_KEY) count += 1;
  }
  return count;
}

export interface AgyWarnings {
  /** New, still-unreported warnings from the completed lines in `buffer`. */
  warnings: string[];
  /** True when this chunk carried a sign-in prompt (reported once per run). */
  authRequired: boolean;
  /** Incomplete trailing line, to prepend to the next chunk. */
  buffer: string;
}

/**
 * Split one stderr chunk into reportable warnings. Pass the returned `buffer`
 * back with the next chunk; `seen` dedupes across the whole run.
 */
export function collectAgyWarnings(
  buffer: string,
  seen: Set<string>,
  limit = MAX_STDERR_WARNINGS,
): AgyWarnings {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const warnings: string[] = [];
  let authRequired = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (AUTH_REQUIRED_STDERR.test(line)) {
      // One report per run: the CLI repeats the prompt while it waits.
      if (!seen.has(AUTH_REQUIRED_KEY)) {
        seen.add(AUTH_REQUIRED_KEY);
        authRequired = true;
      }
      continue;
    }
    if (!NOTABLE_STDERR.test(line)) continue;
    const bounded =
      line.length > MAX_STDERR_WARNING_CHARS
        ? `${line.slice(0, MAX_STDERR_WARNING_CHARS - 1)}…`
        : line;
    if (seen.has(bounded) || warningCount(seen) >= limit) continue;
    seen.add(bounded);
    warnings.push(bounded);
  }
  return { warnings, authRequired, buffer: rest };
}
