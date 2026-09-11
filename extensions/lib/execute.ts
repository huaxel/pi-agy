import { stat } from "node:fs/promises";

import {
  buildAgyPrompt,
  detectVerifyCommand,
  getAgyConversationId,
  isTransientAgyFailure,
  resolveAgyModelAlias,
  spawnAgyStream,
  type AgyEffort,
  type AgyModel,
} from "./cli.js";
import { loadAgyConfig, resolveDefaultModel } from "./config.js";
import type { AgyUsage } from "./stream.js";
import { withDirLock } from "./lock.js";
import {
  captureGitBaseline,
  summarizeGitDiffSince,
  type GitBaseline,
} from "./postflight.js";
import { runPreflight } from "./preflight.js";
import { getSession, saveSession } from "./sessions.js";

export type AgyMode = "plan" | "accept-edits" | "sandbox";

export interface AgyExecutionOptions {
  prompt: string;
  model?: AgyModel;
  tier?: "flash" | "flash-lo" | "pro";
  effort?: AgyEffort;
  mode: AgyMode;
  dir: string;
  digest?: boolean;
  timeout_ms: number;
  conversation_id?: string;
  continue?: boolean;
  new_session?: boolean;
  stream?: boolean;
}

export interface AgyExecutionDetails {
  mode: AgyMode;
  model: AgyModel | "flash-medium";
  dir: string;
  conversation_id?: string;
  verify_cmd: string | null;
  permissions_skipped?: boolean;
  effort?: AgyEffort;
  usage?: AgyUsage;
  duration_seconds?: number;
  changed_files?: string[];
  preexisting_files?: string[];
}

export interface AgyExecutionResult {
  text: string;
  details: AgyExecutionDetails;
}

export async function executeAgyTask(
  options: AgyExecutionOptions,
  signal: AbortSignal | undefined,
  onProgress?: (message: string) => void,
): Promise<AgyExecutionResult> {
  validateAgyExecutionOptions(options);
  const startedAt = Date.now();
  const budgetController = new AbortController();
  const abortSignal = signal
    ? AbortSignal.any([signal, budgetController.signal])
    : budgetController.signal;
  const budgetTimer = setTimeout(
    () => budgetController.abort(),
    Math.max(options.timeout_ms, 0),
  );
  let effectiveModel: AgyModel | "flash-medium" = "flash-medium";

  try {
    const config = await loadAgyConfig(undefined, abortSignal);
    // Explicit model → legacy tier → configured default → flash-medium.
    const selectedModel = resolveAgyModelAlias(options.model, options.tier);
    const model =
      selectedModel ?? (await resolveDefaultModel(config, abortSignal));
    effectiveModel = model ?? "flash-medium";
    const skipPermissions = config.skipPermissions !== false;

    return await withDirLock(
      options.dir,
      async () => {
        remainingBudget(startedAt, options.timeout_ms);
        if (!(await stat(options.dir)).isDirectory()) {
          throw new Error(`Working directory is not a directory: ${options.dir}`);
        }

        let conversationId = options.conversation_id;
        if (
          !conversationId &&
          !options.continue &&
          options.new_session !== true
        ) {
          const prior = await getSession(options.dir);
          if (prior?.last_conversation_id && options.new_session === false) {
            conversationId = prior.last_conversation_id;
          }
        }

        const useDigest = options.digest ?? options.mode !== "accept-edits";
        const verifyCmd =
          options.mode === "accept-edits"
            ? await detectVerifyCommand(options.dir)
            : null;
        const baseline: GitBaseline =
          options.mode === "accept-edits"
            ? await captureGitBaseline(options.dir, abortSignal)
            : { dirtyFiles: new Set(), unavailable: true };
        remainingBudget(startedAt, options.timeout_ms);
        const finalPrompt = buildAgyPrompt(
          options.prompt,
          options.mode,
          useDigest,
          verifyCmd,
        );

        const run = await runWithTransientRetry(async (trackProgress) => {
          const remainingMs = remainingBudget(startedAt, options.timeout_ms);
          await runPreflight(options.dir, abortSignal, remainingMs);
          const runTimeoutMs = remainingBudget(startedAt, options.timeout_ms);
          // Emitted via onProgress directly: progress tracking (and therefore
          // retry eligibility) must only reflect activity from agy itself.
          onProgress?.(
            `agy: starting (${effectiveModel}, ${options.mode}${options.effort ? `, effort ${options.effort}` : ""})…`,
          );

          return spawnAgyStream(
            {
              prompt: finalPrompt,
              model,
              effort: options.effort,
              mode: options.mode,
              dir: options.dir,
              timeout_ms: runTimeoutMs,
              conversation_id: conversationId,
              continue: options.continue,
              stream: options.stream ?? true,
              skipPermissions,
            },
            abortSignal,
            trackProgress,
          );
        }, onProgress);

        if (run.conversation_id) {
          try {
            await saveSession(options.dir, run.conversation_id, effectiveModel, abortSignal);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            onProgress?.(`agy: warning — could not persist session: ${reason}`);
          }
        }
        remainingBudget(startedAt, options.timeout_ms);

        let text = run.response;
        let changedFiles: string[] | undefined;
        let preexistingFiles: string[] | undefined;
        if (options.mode === "accept-edits") {
          const diff = await summarizeGitDiffSince(baseline, options.dir, abortSignal);
          if (diff.summary) text = `${text}\n\n${diff.summary}`;
          changedFiles = diff.newFiles;
          preexistingFiles = diff.preexistingFiles;
        }
        if (abortSignal.aborted) {
          throw new Error(signal?.aborted ? "agy was cancelled" : "agy timed out");
        }
        remainingBudget(startedAt, options.timeout_ms);

        return {
          text,
          details: {
            mode: options.mode,
            model: effectiveModel,
            dir: options.dir,
            conversation_id: run.conversation_id,
            verify_cmd: verifyCmd,
            permissions_skipped: options.mode === "accept-edits" ? skipPermissions : false,
            effort: options.effort,
            usage: run.usage,
            duration_seconds: run.duration_seconds,
            changed_files: changedFiles,
            preexisting_files: preexistingFiles,
          },
        };
      },
      abortSignal,
      remainingBudget(startedAt, options.timeout_ms),
    );
  } catch (error) {
    const conversationId = getAgyConversationId(error);
    if (conversationId) {
      try {
        await saveSession(options.dir, conversationId, effectiveModel, abortSignal);
      } catch {
        // Preserve the original agy failure; session persistence is best effort.
      }
    }
    if (budgetController.signal.aborted && !signal?.aborted) {
      throw new Error(`agy timed out after ${options.timeout_ms}ms`);
    }
    throw error;
  } finally {
    clearTimeout(budgetTimer);
  }
}

export function validateAgyExecutionOptions(options: AgyExecutionOptions): void {
  if (!options.prompt?.trim()) throw new Error("agy prompt must not be empty");
  if (!Number.isFinite(options.timeout_ms) || options.timeout_ms <= 0) {
    throw new Error("agy timeout_ms must be a positive finite number");
  }
  if (options.continue && options.conversation_id) {
    throw new Error("agy cannot use --continue and --conversation together");
  }
  if (options.new_session === true && (options.continue || options.conversation_id)) {
    throw new Error("agy new_session cannot be combined with a conversation to resume");
  }
}

function remainingBudget(startedAt: number, timeoutMs: number): number {
  const remaining = timeoutMs - (Date.now() - startedAt);
  if (remaining <= 0) throw new Error("agy timed out");
  return remaining;
}

/**
 * Retry once when agy fails before emitting any activity (tool step or model
 * response) with a transient error (rate limit, network blip). Zero activity
 * means no tool steps ran, so the retry cannot double-apply edits.
 */
async function runWithTransientRetry<T>(
  attempt: (trackProgress: (message: string) => void) => Promise<T>,
  onProgress?: (message: string) => void,
): Promise<T> {
  for (let tries = 0; ; tries++) {
    let sawActivity = false;
    const trackProgress = (message: string, kind?: "status" | "activity") => {
      if (kind === "activity") sawActivity = true;
      onProgress?.(message);
    };
    try {
      return await attempt(trackProgress);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        tries === 0 &&
        !sawActivity &&
        isTransientAgyFailure(message) &&
        !/\b(?:ETIMEDOUT|timed out)\b/i.test(message)
      ) {
        onProgress?.("agy: transient failure before any work — retrying once…");
        continue;
      }
      throw error;
    }
  }
}
