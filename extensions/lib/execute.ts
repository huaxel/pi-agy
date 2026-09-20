import { stat } from "node:fs/promises";

import {
  buildAgyPrompt,
  detectVerifyCommand,
  findAgyQuotaEntries,
  formatAgyUsage,
  getAgyConversationId,
  isAgyQuotaExhausted,
  isTransientAgyFailure,
  normalizeAgyAgentName,
  resolveAgyModelAlias,
  resolveAgyModelId,
  spawnAgyStream,
  type AgyEffort,
  type AgyModel,
  type AgyUsageSnapshot,
} from "./cli.js";
import { loadAgyConfig, resolveDefaultModel } from "./config.js";
import type { AgyContextMode } from "./context.js";
import type { AgyUsage } from "./stream.js";
import {
  formatAgySubagentObservations,
  type AgyObservedSubagent,
} from "./subagents.js";
import { withDirLock } from "./lock.js";
import {
  captureGitBaseline,
  summarizeGitDiffSince,
  type GitBaseline,
} from "./postflight.js";
import { resetPreflightCache, runPreflight } from "./preflight.js";
import { getHistory, getSession, saveSession, conversationSummary } from "./sessions.js";

export type AgyMode = "plan" | "accept-edits" | "sandbox";

export interface AgyExecutionOptions {
  prompt: string;
  model?: AgyModel;
  tier?: "flash" | "flash-lo" | "pro";
  effort?: AgyEffort;
  agent?: string;
  mode: AgyMode;
  dir: string;
  digest?: boolean;
  timeout_ms: number;
  conversation_id?: string;
  continue?: boolean;
  new_session?: boolean;
  stream?: boolean;
  context?: AgyContextMode;
  /** Pre-serialized bounded Pi context; supplied only when context is not none. */
  context_text?: string;
}

export interface AgyExecutionDetails {
  mode: AgyMode;
  model: AgyModel | "flash-medium";
  dir: string;
  conversation_id?: string;
  verify_cmd: string | null;
  permissions_skipped?: boolean;
  effort?: AgyEffort;
  agent?: string;
  usage?: AgyUsage;
  duration_seconds?: number;
  /** Stream observations only; entries do not imply a live controllable process. */
  subagents?: AgyObservedSubagent[];
  changed_files?: string[];
  preexisting_files?: string[];
  context_mode?: AgyContextMode;
  context_chars?: number;
  /** Model-specific quota information refreshed before the run, when supported. */
  quota?: AgyUsageSnapshot;
  quota_status?: "available" | "unknown";
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
  let agent = normalizeAgyAgentName(options.agent);
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
    const resolvedModel = selectedModel ?? (await resolveDefaultModel(config, abortSignal));
    let model: AgyModel = resolvedModel ?? "flash-medium";
    effectiveModel = model;
    const autoModelSelection =
      !selectedModel && !config.defaultModel && !config.defaultModelCommand;
    const skipPermissions = config.skipPermissions !== false;

    return await withDirLock(
      options.dir,
      async () => {
        remainingBudget(startedAt, options.timeout_ms);
        if (!(await stat(options.dir)).isDirectory()) {
          throw new Error(`Working directory is not a directory: ${options.dir}`);
        }

        let conversationId = options.conversation_id;
        const resumesLatest = options.continue || options.new_session === false;
        const prior =
          (!conversationId && options.new_session !== true) || (!agent && resumesLatest)
            ? await getSession(options.dir)
            : undefined;
        if (
          !conversationId &&
          !options.continue &&
          prior?.last_conversation_id &&
          options.new_session === false
        ) {
          conversationId = prior.last_conversation_id;
        }
        if (!agent && resumesLatest && prior?.last_agent) {
          try {
            agent = normalizeAgyAgentName(prior.last_agent);
          } catch {
            // Ignore malformed legacy store data rather than blocking a resume.
          }
        }
        if (!agent && conversationId) {
          const recorded = (await getHistory(options.dir)).find(
            (entry) => entry.conversation_id === conversationId,
          );
          if (recorded?.agent) agent = normalizeAgyAgentName(recorded.agent);
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
          options.context_text,
        );

        let quota: AgyUsageSnapshot | undefined;
        let quotaStatus: "available" | "unknown" | undefined;
        const run = await runWithTransientRetry(async (trackProgress) => {
          const remainingMs = remainingBudget(startedAt, options.timeout_ms);
          quota = await runPreflight(options.dir, abortSignal, remainingMs);
          const selectedModelId = resolveAgyModelId(model, options.tier);
          const selectedQuotas = findAgyQuotaEntries(quota, selectedModelId);
          quotaStatus = quota
            ? selectedQuotas.length === 0
              ? "unknown"
              : "available"
            : undefined;
          const quotaSummary = quota ? formatAgyUsage(quota, selectedModelId) : undefined;
          if (quotaSummary) onProgress?.(quotaSummary);
          if (selectedQuotas.some((entry) => isAgyQuotaExhausted(entry))) {
            const fallback = autoModelSelection
              ? findAvailableFallbackModel(quota, model)
              : undefined;
            if (fallback) {
              onProgress?.(
                `agy: ${selectedModelId} quota exhausted; falling back to ${resolveAgyModelId(fallback)}…`,
              );
              model = fallback;
              effectiveModel = fallback;
            } else {
              const quotaEntries = quota?.models ?? [];
              const alternatives = [...new Set(quotaEntries.map((entry) => entry.model))]
                .filter((candidate) => candidate.toLowerCase() !== selectedModelId.toLowerCase())
                .filter((candidate) =>
                  quotaEntries
                    .filter((entry) => entry.model === candidate)
                    .every((entry) => !isAgyQuotaExhausted(entry)),
                );
              const alternativeText = alternatives.length
                ? ` Available reported alternatives: ${alternatives.join(", ")}.`
                : " No available alternative was reported.";
              throw new Error(
                `agy quota exhausted for ${selectedModelId}; choose another model or run agy_usage first.${alternativeText}\n${quotaSummary ?? ""}`,
              );
            }
          }
          const runTimeoutMs = remainingBudget(startedAt, options.timeout_ms);
          // Emitted via onProgress directly: progress tracking (and therefore
          // retry eligibility) must only reflect activity from agy itself.
          onProgress?.(
            `agy: starting (${effectiveModel}, ${options.mode}${agent ? `, agent ${agent}` : ""}${options.effort ? `, effort ${options.effort}` : ""})…`,
          );

          return spawnAgyStream(
            {
              prompt: finalPrompt,
              model,
              effort: options.effort,
              agent,
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
        }, onProgress, abortSignal);

        if (run.conversation_id) {
          try {
            // Fresh bounded signal: the composed one may already be aborted
            // when the run finished at the deadline edge (see below).
            await saveSession(
              options.dir,
              run.conversation_id,
              effectiveModel,
              AbortSignal.timeout(10_000),
              conversationSummary(options.prompt),
              agent,
            );
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            onProgress?.(`agy: warning — could not persist session: ${reason}`);
          }
        }

        let text = run.response;
        const subagentSummary = formatAgySubagentObservations(run.subagents);
        if (subagentSummary) text = `${text}\n\n## ${subagentSummary}`;
        const quotaSummary = quota?.models.length
          ? formatAgyUsage(quota, resolveAgyModelId(model, options.tier))
          : undefined;
        if (quotaSummary) text = `${text}\n\n## agy quota snapshot\n${quotaSummary}`;
        let changedFiles: string[] | undefined;
        let preexistingFiles: string[] | undefined;
        // The agy run itself is complete; from here, an expiring budget or a
        // racing cancellation must never discard its response. Skip the
        // post-run steps with a note instead of throwing the result away.
        if (options.mode === "accept-edits") {
          try {
            const diff = await summarizeGitDiffSince(baseline, options.dir, abortSignal);
            if (diff.summary) text = `${text}\n\n${diff.summary}`;
            changedFiles = diff.newFiles;
            preexistingFiles = diff.preexistingFiles;
          } catch (error) {
            if (!abortSignal.aborted) throw error;
            const reason = signal?.aborted ? "cancelled" : "reaching its deadline";
            text += `\n\n(diff summary skipped: the run was ${reason} as agy finished)`;
          }
        }
        if (abortSignal.aborted) {
          text += `\n\nagy finished as the run was ${signal?.aborted ? "cancelled" : "timing out"}; the completed result is preserved.`;
        }

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
            agent,
            usage: run.usage,
            duration_seconds: run.duration_seconds,
            subagents: run.subagents,
            changed_files: changedFiles,
            preexisting_files: preexistingFiles,
            context_mode: options.context ?? "none",
            context_chars: options.context_text?.length ?? 0,
            quota,
            quota_status: quotaStatus,
          },
        };
      },
      abortSignal,
      remainingBudget(startedAt, options.timeout_ms),
    );
  } catch (error) {
    const conversationId = getAgyConversationId(error);
    let conversationPersisted = false;
    if (conversationId) {
      try {
        // The composed signal is aborted in exactly the cases this save
        // exists for (timeout, cancellation), and every store guard refuses
        // an aborted signal — so persist under a fresh bounded deadline to
        // keep the conversation resumable after the failure.
        await saveSession(
          options.dir,
          conversationId,
          effectiveModel,
          AbortSignal.timeout(10_000),
          conversationSummary(options.prompt),
          agent,
        );
        conversationPersisted = true;
      } catch {
        // Preserve the original agy failure; session persistence is best effort.
      }
    }
    if (budgetController.signal.aborted && !signal?.aborted) {
      const resume = conversationId
        ? conversationPersisted
          ? `; conversation ${JSON.stringify(conversationId.slice(0, 128))} was recorded — resume with conversation_id, /agy continue, or /agy sessions`
          : `; conversation ${JSON.stringify(conversationId.slice(0, 128))} was observed — resume with conversation_id`
        : "";
      throw new Error(`agy timed out after ${options.timeout_ms}ms${resume}`);
    }
    throw error;
  } finally {
    clearTimeout(budgetTimer);
  }
}

export function validateAgyExecutionOptions(options: AgyExecutionOptions): void {
  if (!options.prompt?.trim()) throw new Error("agy prompt must not be empty");
  normalizeAgyAgentName(options.agent);
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

const FALLBACK_MODELS: readonly AgyModel[] = [
  "flash-medium",
  "flash-low",
  "flash-high",
  "pro-low",
  "pro-high",
  "gpt-oss",
  "sonnet",
  "opus",
];

function findAvailableFallbackModel(
  snapshot: AgyUsageSnapshot | undefined,
  current: AgyModel,
): AgyModel | undefined {
  if (!snapshot) return undefined;
  return FALLBACK_MODELS.find((candidate) => {
    if (candidate === current) return false;
    const entries = findAgyQuotaEntries(snapshot, resolveAgyModelId(candidate));
    return entries.length > 0 && entries.every((entry) => !isAgyQuotaExhausted(entry));
  });
}

/**
 * Retry once when agy fails before emitting any activity (tool step or model
 * response) with a transient error (rate limit, network blip). Zero activity
 * means no tool steps ran, so the retry cannot double-apply edits.
 */
async function runWithTransientRetry<T>(
  attempt: (trackProgress: (message: string) => void) => Promise<T>,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
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
        const quotaMayHaveChanged = /resource[_ -]?exhausted|429/i.test(message);
        if (quotaMayHaveChanged) resetPreflightCache();
        onProgress?.(
          quotaMayHaveChanged
            ? "agy: quota request was rejected before any work — refreshing quota and retrying once…"
            : "agy: transient failure before any work — retrying once…",
        );
        await delayBeforeRetry(signal);
        continue;
      }
      throw error;
    }
  }
}

function delayBeforeRetry(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 1_000);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("agy retry cancelled"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("agy retry cancelled"));
      },
      { once: true },
    );
  });
}
