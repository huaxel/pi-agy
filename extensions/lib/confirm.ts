/**
 * accept-edits confirmation dialog text.
 *
 * Shared by the `/agy` command (commands.ts) and the `agy_execute` tool
 * (index.ts): one pre-run summary builder so the two approval paths can never
 * drift apart. Pure text — callers fetch `dirt` and `verify` and pass
 * everything in.
 */

import type { VerifyCommandSource } from "./verify.js";

export interface AcceptEditsConfirmInput {
  /** Pre-rendered model line, e.g. `flash-medium (gemini-3.8-flash-medium)`. */
  modelLabel: string;
  agent?: string;
  cwd: string;
  prompt: string;
  contextMode: string;
  contextText?: string;
  /** Pre-run workspace dirt, or null when the check was skipped or failed. */
  dirt: string | null;
  /**
   * Detected verify loop, or null when none applies.
   *
   * The command string is allowlisted, but the code it runs belongs to the
   * checkout — `just ci` is whatever `justfile` says. Naming both here is what
   * makes the approval cover the code that will actually execute.
   */
  verify?: VerifyCommandSource | null;
}

export interface ContextForwardConfirmInput {
  mode: string;
  /** Rendered model line, same convention as the accept-edits dialog. */
  modelLabel: string;
  agent?: string;
  cwd: string;
  contextMode: string;
  contextText?: string;
  background: boolean;
}

/**
 * Dialog for forwarding Pi transcript text to agy in a mode that otherwise
 * runs silently.
 *
 * `plan` and `sandbox` are the cheap iterations — no writes, so no accept-edits
 * dialog, which is deliberate. Forwarding transcript text is a different act:
 * it hands conversation content to an external CLI (and its model provider)
 * that would otherwise never see it, and the tool can do that without the user
 * having typed anything. This is the only place a human sees it leave, so the
 * dialog covers the excerpt itself rather than the permission grant.
 */
export function buildContextForwardConfirm(input: ContextForwardConfirmInput): {
  title: string;
  body: string;
} {
  const { mode, modelLabel, agent, cwd, contextMode, contextText, background } = input;
  const agentLine = agent ? `\nagent: ${agent}` : "";
  const size = contextText
    ? `${contextText.length.toLocaleString()} chars; text-only`
    : "0 chars; no eligible text";
  const excerpt = (contextText ?? "").slice(0, 200).replace(/\s+/g, " ").trim();
  const excerptLine = excerpt ? `\n\nexcerpt: ${excerpt}${(contextText?.length ?? 0) > 200 ? "…" : ""}` : "";
  const backgroundLine = background
    ? "\n\nThe run is detached: this approval outlives the dialog."
    : "";
  return {
    title: `Forward Pi transcript to agy (${mode})?`,
    body:
      `model: ${modelLabel}${agentLine}\ndir: ${cwd}\ncontext: ${contextMode} (${size})${excerptLine}` +
      `\n\n${mode} writes nothing, so it needs no accept-edits approval — this asks only about the transcript, ` +
      `which leaves this machine for the model provider.${backgroundLine}`,
  };
}

export function buildAcceptEditsConfirm(input: AcceptEditsConfirmInput): {
  title: string;
  body: string;
} {
  const { modelLabel, agent, cwd, prompt, contextMode, contextText, dirt, verify } = input;
  const dirtLine = dirt ? `\nworkspace: ${dirt}` : "";
  const agentLine = agent ? `\nagent: ${agent}` : "";
  const verifyLine = verify ? `\nverify: ${verify.command} (${verify.definedIn})` : "";
  const contextLine =
    contextMode === "none"
      ? "\ncontext: none"
      : contextText
        ? `\ncontext: ${contextMode} (${contextText.length.toLocaleString()} chars; text-only)`
        : `\ncontext: ${contextMode} (0 chars; no eligible text)`;
  const warning =
    dirt && dirt !== "clean"
      ? `\n\nWarning: uncommitted changes already exist — the result summary only attributes newly-dirty files to agy.`
      : "";
  const verifyClause = verify
    ? ` — including \`${verify.command}\`, defined in ${verify.definedIn}`
    : "";
  const excerpt = prompt.slice(0, 200) + (prompt.length > 200 ? "…" : "");
  return {
    title: "Run agy (accept-edits)?",
    body: `model: ${modelLabel}${agentLine}\ndir: ${cwd}${dirtLine}${verifyLine}${contextLine}\n\ntask: ${excerpt}\n\nThis grants agy permission to modify files and run commands${verifyClause}.${warning}`,
  };
}

export interface ContextConsentDeps {
  hasUI: boolean;
  confirm: (title: string, body: string) => Promise<boolean>;
}

/**
 * Whether this run needs the forwarding dialog.
 *
 * `accept-edits` already shows `context:` in its own approval, and `none`
 * forwards nothing, so the dialog exists for the remaining gap: a silent mode
 * that would still hand transcript text to agy.
 */
export function needsContextConsent(mode: string, contextMode: string): boolean {
  return mode !== "accept-edits" && contextMode !== "none";
}

/**
 * Ask before a silent mode forwards transcript text; throw when it may not.
 *
 * Fail-closed on both refusals: no UI means the question cannot be asked, and
 * declining means the content must not leave. Both raise, because returning a
 * falsy result would let the caller run the turn anyway.
 */
export async function requestContextConsent(
  input: ContextForwardConfirmInput,
  deps: ContextConsentDeps,
): Promise<void> {
  if (!needsContextConsent(input.mode, input.contextMode)) return;
  if (!deps.hasUI) {
    throw new Error(`agy ${input.mode} with context forwarding requires interactive confirmation`);
  }
  const { title, body } = buildContextForwardConfirm(input);
  if (!(await deps.confirm(title, body))) {
    throw new Error(`agy ${input.mode} cancelled by user`);
  }
}
