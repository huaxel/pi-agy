/**
 * agy's unauthenticated state, captured from agy 1.5.13 rather than guessed:
 *
 * - stdout envelope: `{"status":"ERROR","error":"authentication failed or timed out",...}`
 * - stderr: `Authentication required. Please visit the URL to log in:` followed
 *   by an OAuth URL, then `Waiting for authentication (timeout …)`.
 *
 * Without recognition, a signed-out CLI wastes the whole print timeout waiting
 * for a browser sign-in that cannot happen, and the operator sees either a
 * generic terminal-status error or a silence watchdog firing later. The OAuth
 * URL itself is never echoed: it is long, single-use, and belongs in a terminal.
 */

/**
 * Every unauthenticated shape agy is known to print. `agy models` does not use
 * the print-mode wording: measured on 1.5.15, a signed-out CLI answers with
 * `Error: Please sign in to view available models.` and exits 1, which the
 * earlier pattern missed — a signed-out machine was reported as a broken CLI.
 */
const AUTH_FAILURE =
  /authentication failed or timed out|authentication required|waiting for authentication|please sign in|sign in to view|not logged in|not logged into|not authenticated|login required/i;

/** One recovery sentence: what is wrong and the only thing that fixes it. */
export const AGY_AUTH_RECOVERY =
  "agy is not signed in (authentication failed or timed out). Run `agy` once in a terminal and finish the browser sign-in, then retry.";

/** Fixed, URL-free label for a live warning surface. */
export const AGY_AUTH_PROGRESS = "agy: authentication required — sign in from a terminal";

export function isAgyAuthFailure(text: string | undefined): boolean {
  return typeof text === "string" && AUTH_FAILURE.test(text);
}

/**
 * Replace a generic failure with the recovery when the text says the CLI is
 * signed out; keep the original detail so the diagnosis is still visible.
 */
export function withAuthRecovery(message: string): string {
  return isAgyAuthFailure(message) ? `${AGY_AUTH_RECOVERY} (agy said: ${message.trim()})` : message;
}
