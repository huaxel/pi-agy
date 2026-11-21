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
