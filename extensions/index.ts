import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as path from "node:path";

import {
  checkAgyUsage,
  findAgyQuotaEntries,
  formatAgyUsage,
  isAgyQuotaExhausted,
  resolveAgyModelAlias,
  resolveAgyModelId,
  type AgyModel,
} from "./lib/cli.js";
import { describePreRunDirt } from "./lib/postflight.js";
import { registerAgyCommand } from "./commands.js";
import {
  executeAgyTask,
  validateAgyExecutionOptions,
  type AgyMode,
} from "./lib/execute.js";
import { truncate } from "./lib/output.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 600_000;

export { truncate } from "./lib/output.js";

export function resolveAgyMode(mode?: AgyMode): AgyMode {
  return mode ?? "accept-edits";
}

export default function piAgyExtension(pi: ExtensionAPI) {
  registerAgyCommand(pi);

  pi.registerTool({
    name: "agy_execute",
    label: "Antigravity CLI",
    description:
      "Run a task through the Antigravity CLI (agy) for bulk implementation, scaffolding, or test generation.",
    promptSnippet: "Run a task through the Antigravity CLI (agy)",
    promptGuidelines: [
      "Use agy_execute with accept-edits for scoped implementation; use plan for exploration and review.",
      "Plan or research with one family only when needed; implement with flash-medium or sonnet according to which quota group should carry the work.",
      "Use flash-medium by default for bulk coding, exploration, tests, and repetitive work.",
      "Use flash-low for trivial few-step or high-volume work, and flash-high for difficult agentic work.",
      "Use pro-low or pro-high only when advanced reasoning needs escalation within the Gemini quota group.",
      "Use sonnet for normal coding or review in the Claude quota group; reserve opus for the hardest architecture, root-cause, or adversarial review.",
      "Use gpt-oss when an open-model alternative is specifically desired.",
      "For consequential work, use one family to produce and the opposite family to cross-review in mode=plan; do not spend both quota groups on trivial tasks.",
      "Reuse conversation_id or continue=true for multi-step plan→implement→review handoffs.",
      "Use agy_usage before choosing a model when quota availability matters; agy_execute also refreshes and returns a quota snapshot.",
      "Batch related work, prefer digest output for non-write calls, and avoid parallel agy_execute calls within one shared-quota group or directory.",
      "Always review the git diff and run just ci (or the project gate) after agy_execute with mode=accept-edits.",
      "Never use agy for irreversible production changes.",
      "Set an appropriate timeout_ms for large tasks (default 5m).",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task instruction for agy.",
        minLength: 1,
      }),
      model: Type.Optional(
        Type.Union(
          [
            Type.Literal("flash-low"),
            Type.Literal("flash-medium"),
            Type.Literal("flash-high"),
            Type.Literal("pro-low"),
            Type.Literal("pro-high"),
            Type.Literal("sonnet"),
            Type.Literal("opus"),
            Type.Literal("gpt-oss"),
          ],
          { description: "Model alias. Defaults to 'flash-medium'.", default: "flash-medium" },
        ),
      ),
      effort: Type.Optional(
        Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
          description:
            "Reasoning effort passed to agy (--effort). Optional; mostly useful for sonnet/opus/gpt-oss since Gemini aliases encode effort in the model id.",
        }),
      ),
      tier: Type.Optional(
        Type.Union(
          [Type.Literal("flash"), Type.Literal("flash-lo"), Type.Literal("pro")],
          { description: "Legacy Gemini tier. Ignored when model is set." },
        ),
      ),
      mode: Type.Optional(
        Type.Union(
          [Type.Literal("accept-edits"), Type.Literal("plan"), Type.Literal("sandbox")],
          { description: "'accept-edits' (default), 'plan', or 'sandbox'.", default: "accept-edits" },
        ),
      ),
      dir: Type.Optional(
        Type.String({
          description: "Working directory. Defaults to current project root.",
        }),
      ),
      digest: Type.Optional(
        Type.Boolean({
          description:
            "Request compact digests instead of full output. Defaults on for plan/sandbox and off for accept-edits.",
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          description: "Timeout in milliseconds (default 300000 = 5m, max 600000).",
          minimum: 1000,
          maximum: MAX_TIMEOUT_MS,
        }),
      ),
      conversation_id: Type.Optional(
        Type.String({
          description: "Resume a previous agy conversation by ID.",
        }),
      ),
      continue: Type.Optional(
        Type.Boolean({
          description: "Continue the most recent agy conversation for this workspace.",
        }),
      ),
      new_session: Type.Optional(
        Type.Boolean({
          description: "Force a fresh agy conversation (default when no conversation_id/continue).",
        }),
      ),
      stream: Type.Optional(
        Type.Boolean({
          description: "Stream agy progress via stream-json (default true).",
          default: true,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = params.dir ? path.resolve(ctx.cwd, params.dir) : ctx.cwd;
      const abortSignal = signal ?? new AbortController().signal;
      const timeoutMs = Math.min(params.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      const mode = resolveAgyMode(params.mode);
      const model = params.model as AgyModel | undefined;
      const executionOptions = {
        prompt: params.prompt,
        model,
        tier: params.tier,
        effort: params.effort,
        mode,
        dir: cwd,
        digest: params.digest,
        timeout_ms: timeoutMs,
        conversation_id: params.conversation_id,
        continue: params.continue,
        new_session: params.new_session,
        stream: params.stream ?? true,
      };
      validateAgyExecutionOptions(executionOptions);

      if (mode === "accept-edits") {
        if (!ctx.hasUI) {
          throw new Error("accept-edits requires interactive confirmation");
        }
        const requestedModel = resolveAgyModelAlias(model, params.tier);
        const modelLabel = requestedModel
          ? `${requestedModel} (${resolveAgyModelId(model, params.tier)})`
          : "configured default (fallback flash-medium)";
        const dirt = await describePreRunDirt(cwd, abortSignal).catch(() => null);
        const excerpt =
          params.prompt.slice(0, 200) + (params.prompt.length > 200 ? "…" : "");
        const dirtLine = dirt ? `\nworkspace: ${dirt}` : "";
        const warning =
          dirt && dirt !== "clean"
            ? `\n\nWarning: uncommitted changes already exist — the result summary only attributes newly-dirty files to agy.`
            : "";
        const approved = await ctx.ui.confirm(
          "Run agy (accept-edits)?",
          `model: ${modelLabel}\ndir: ${cwd}${dirtLine}\n\ntask: ${excerpt}\n\nThis grants agy permission to modify files and run commands.${warning}`,
        );
        if (!approved) throw new Error("agy accept-edits cancelled by user");
      }

      const result = await executeAgyTask(
        executionOptions,
        abortSignal,
        (progress) => {
          onUpdate?.({ content: [{ type: "text", text: progress }], details: {} });
        },
      );

      return {
        content: [{ type: "text", text: truncate(result.text || "(empty response)") }],
        details: result.details,
      };
    },
  });

  pi.registerTool({
    name: "agy_usage",
    label: "Antigravity Quota",
    description:
      "Read the current model-specific Antigravity quota and reset information without spending a model turn.",
    promptSnippet: "Inspect Antigravity model quotas before choosing a model",
    parameters: Type.Object({
      model: Type.Optional(
        Type.Union(
          [
            Type.Literal("flash-low"),
            Type.Literal("flash-medium"),
            Type.Literal("flash-high"),
            Type.Literal("pro-low"),
            Type.Literal("pro-high"),
            Type.Literal("sonnet"),
            Type.Literal("opus"),
            Type.Literal("gpt-oss"),
          ],
          { description: "Optional model alias to place first in the report." },
        ),
      ),
      dir: Type.Optional(
        Type.String({
          description: "Working directory used for the agy CLI check. Defaults to current project root.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = params.dir ? path.resolve(ctx.cwd, params.dir) : ctx.cwd;
      const quota = await checkAgyUsage(cwd, signal);
      const selectedModel = params.model ? resolveAgyModelId(params.model) : undefined;
      const selectedEntries = selectedModel ? findAgyQuotaEntries(quota, selectedModel) : [];
      const quotaStatus = selectedModel
        ? selectedEntries.length === 0
          ? "unknown"
          : selectedEntries.some((entry) => isAgyQuotaExhausted(entry))
            ? "exhausted"
            : "available"
        : undefined;
      const quotaReport =
        formatAgyUsage(quota, selectedModel) ??
        "agy quota information is unavailable in this CLI version or account configuration";
      const report = quotaStatus
        ? `selected model ${selectedModel}: ${quotaStatus}\n\n${quotaReport}`
        : quotaReport;
      return {
        content: [{ type: "text", text: report }],
        details: {
          cwd,
          selected_model: selectedModel,
          quota_status: quotaStatus,
          quota,
        },
      };
    },
  });
}
