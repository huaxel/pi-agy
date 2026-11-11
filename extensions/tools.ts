import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type SchemaOptions } from "@sinclair/typebox";
import { stat } from "node:fs/promises";
import * as path from "node:path";

import {
  AGY_MODEL_ALIASES,
  checkAgyUsage,
  findAgyQuotaEntries,
  formatAgyUsage,
  inspectAgyAgents,
  isAgyQuotaExhausted,
  normalizeAgyAgentName,
  resolveAgyModelAlias,
  resolveAgyModelId,
  type AgyModel,
} from "./lib/cli.js";
import {
  buildAgyContextFromEntries,
  effectiveResumeContextMode,
  type AgyContextMode,
} from "./lib/context.js";
import { describePreRunDirt } from "./lib/postflight.js";
import { buildAcceptEditsConfirm } from "./lib/confirm.js";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "./lib/command-args.js";
import {
  executeAgyTask,
  validateAgyExecutionOptions,
  type AgyMode,
} from "./lib/execute.js";
import { describeWhen, truncate } from "./lib/output.js";
import { BackgroundTaskRunner, summarizeTaskPrompt } from "./lib/background.js";
import { renderAgyCall, renderAgyResult } from "./lib/render.js";
import { getHistory, getSession } from "./lib/sessions.js";
import { normalizeConversationSelection } from "./lib/request.js";

async function resolveToolDir(cwd: string, dir?: string): Promise<string> {
  const resolved = dir ? path.resolve(cwd, dir) : cwd;
  if (dir) {
    try {
      const info = await stat(resolved);
      if (!info.isDirectory()) throw new Error(`Working directory is not a directory: ${resolved}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Working directory does not exist: ${resolved}`);
      }
      throw error;
    }
  }
  return resolved;
}

export function resolveAgyMode(mode?: AgyMode): AgyMode {
  return mode ?? "accept-edits";
}

const backgroundRunner = new BackgroundTaskRunner();

export function getBackgroundRunner(): BackgroundTaskRunner {
  return backgroundRunner;
}

function modelAliasSchema(options: SchemaOptions) {
  return Type.Union(AGY_MODEL_ALIASES.map((alias) => Type.Literal(alias)), options);
}

export function registerAgyTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "agy_execute",
    label: "Antigravity CLI",
    description:
      "Run a task through the Antigravity CLI (agy) only when the user explicitly asks to use agy.",
    promptSnippet: "Use only when the user explicitly requests agy delegation",
    promptGuidelines: [
      "Call agy_execute only when the user explicitly asks to use agy; never delegate autonomously based on perceived benefit.",
      "Use flash-medium by default; choose flash-low for trivial work and higher-cost models only when the task warrants them or the user requests them.",
      "Keep context=none unless prior discussion is needed; prefer digest output and continue only genuinely unfinished work.",
      "Use background=true only for long runs, then collect or cancel the task; select custom agents only when requested.",
      "After edits, inspect the diff and run the project check. Never delegate irreversible production changes.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task instruction for agy.",
        minLength: 1,
      }),
      model: Type.Optional(
        modelAliasSchema({ description: "Model alias. Defaults to 'flash-medium'.", default: "flash-medium" }),
      ),
      effort: Type.Optional(
        Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
          description:
            "Reasoning effort passed to agy (--effort). Optional; mostly useful for sonnet/opus/gpt-oss since Gemini aliases encode effort in the model id.",
        }),
      ),
      agent: Type.Optional(
        Type.String({
          description: "Configured custom agy agent name. Use agy_agents to discover names.",
          minLength: 1,
          maxLength: 128,
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
      context: Type.Optional(
        Type.Union(
          [Type.Literal("none"), Type.Literal("summary"), Type.Literal("recent")],
          {
            description:
              "Optional bounded Pi conversation handoff. Defaults to none; excludes system prompts, thinking, tool arguments, tool results, images, and custom messages.",
            default: "none",
          },
        ),
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
          description:
            "Force a fresh agy conversation (default when no conversation_id/continue). Explicit false resumes the last recorded conversation for the directory.",
        }),
      ),
      stream: Type.Optional(
        Type.Boolean({
          description: "Stream agy progress via stream-json (default true).",
          default: true,
        }),
      ),
      background: Type.Optional(
        Type.Boolean({
          description:
            "Return immediately with a task handle instead of waiting; poll with agy_tasks status and collect the result. The run keeps its timeout_ms deadline; cancel via agy_tasks.",
          default: false,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = params.dir ? path.resolve(ctx.cwd, params.dir) : ctx.cwd;
      const abortSignal = signal ?? new AbortController().signal;
      const timeoutMs = Math.min(params.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      const mode = resolveAgyMode(params.mode);
      const model = params.model as AgyModel | undefined;
      const contextMode = (params.context ?? "none") as AgyContextMode;
      const selection = normalizeConversationSelection(params);
      let agent = normalizeAgyAgentName(params.agent);
      if (!agent && selection.kind === "resume") {
        agent = (await getHistory(cwd)).find(
          (entry) => entry.conversation_id === selection.id,
        )?.agent;
      } else if (!agent && selection.kind === "latest") {
        const storedAgent = (await getSession(cwd))?.last_agent;
        try {
          agent = normalizeAgyAgentName(storedAgent);
        } catch {
          // Ignore malformed legacy session metadata.
        }
      }
      const isResume = selection.kind !== "new";
      const effectiveContextMode = effectiveResumeContextMode(contextMode, isResume);
      const contextText =
        effectiveContextMode === "none"
          ? undefined
          : buildAgyContextFromEntries(
              ctx.sessionManager.buildContextEntries(),
              effectiveContextMode,
            );
      const executionOptions = {
        prompt: params.prompt,
        model,
        tier: params.tier,
        effort: params.effort,
        agent,
        mode,
        dir: cwd,
        digest: params.digest,
        timeout_ms: timeoutMs,
        conversation_id: params.conversation_id,
        continue: params.continue,
        new_session: params.new_session,
        stream: params.stream ?? true,
        context: effectiveContextMode,
        context_text: contextText,
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
        const { title, body } = buildAcceptEditsConfirm({
          modelLabel,
          agent,
          cwd,
          prompt: params.prompt,
          contextMode: effectiveContextMode,
          contextText,
          dirt,
        });
        const approved = await ctx.ui.confirm(title, body);
        if (!approved) throw new Error("agy accept-edits cancelled by user");
      }

      if (params.background) {
        const runner = getBackgroundRunner();
        const handle = runner.start({
          dir: cwd,
          summary: summarizeTaskPrompt(params.prompt),
          model,
          agent,
          timeoutMs,
          run: ({ onProgress, signal }) =>
            executeAgyTask(executionOptions, signal, (progress) => onProgress(progress)).then(
              (result) => ({
                text: result.text,
                conversationId: result.details.conversation_id,
                details: result.details,
              }),
            ),
        });
        return {
          content: [
            {
              type: "text",
              text:
                `started background task ${handle} (${mode}, ${model ?? "default model"}, timeout ${Math.round(timeoutMs / 1000)}s). ` +
                `Poll with agy_tasks status, collect the result with agy_tasks collect.`,
            },
          ],
          details: { handle, mode, model, dir: cwd, timeout_ms: timeoutMs },
        };
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

    renderCall(args, theme) {
      return renderAgyCall(args, theme);
    },

    renderResult(result, options, theme, context) {
      return renderAgyResult(result, options, theme, context);
    },
  });

  pi.registerTool({
    name: "agy_agents",
    label: "Antigravity Agents",
    description:
      "List configured custom agy agents without spending a model turn. Use the returned name as agy_execute agent.",
    promptSnippet: "Discover configured custom agy agents before selecting one",
    parameters: Type.Object({
      dir: Type.Optional(
        Type.String({
          description: "Working directory used for the agy CLI check. Defaults to current project root.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = await resolveToolDir(ctx.cwd, params.dir);
      const agents = await inspectAgyAgents(cwd, signal);
      const text = agents.length
        ? `configured agy agents:\n${agents.map((agent) => `- ${agent}`).join("\n")}`
        : "No custom agy agents are configured.";
      return {
        content: [{ type: "text", text }],
        details: { cwd, agents },
      };
    },
  });

  pi.registerTool({
    name: "agy_history",
    label: "Antigravity Conversations",
    description:
      "List recorded agy conversations for a working directory (most recent first) with ids, models, ages, and task summaries — find a conversation_id to resume with agy_execute. Read-only; no model turn is spent.",
    promptSnippet: "List recorded agy conversations before resuming one",
    parameters: Type.Object({
      dir: Type.Optional(
        Type.String({
          description: "Working directory. Defaults to current project root.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum conversations to list (default 10).",
          minimum: 1,
          maximum: 10,
          default: 10,
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = params.dir ? path.resolve(ctx.cwd, params.dir) : ctx.cwd;
      const history = await getHistory(cwd);
      const limited = history.slice(0, params.limit ?? 10);
      if (limited.length === 0) {
        return {
          content: [{
            type: "text",
            text: `No agy conversations are recorded for ${cwd} yet. They are recorded automatically when agy_execute completes or is interrupted with a conversation id.`,
          }],
          details: { dir: cwd, conversations: [] },
        };
      }
      const lines = limited.map((entry, index) => {
        const model = entry.model ?? "unknown model";
        const agent = entry.agent ? ` · agent ${entry.agent}` : "";
        const summary = entry.summary ? ` · ${entry.summary}` : "";
        return `${index + 1}. ${entry.conversation_id} · ${model}${agent} · ${describeWhen(entry.updated_at)}${summary}`;
      });
      const text =
        `agy conversations for ${cwd} (most recent first):\n${lines.join("\n")}\n\n` +
        "Resume with agy_execute conversation_id=<id>, or continue=true for the most recent; recorded agents are restored automatically.";
      return {
        content: [{ type: "text", text }],
        details: { dir: cwd, conversations: limited },
      };
    },
  });

  pi.registerTool({
    name: "agy_tasks",
    label: "Antigravity Background Tasks",
    description:
      "List, poll, collect, or cancel background agy tasks started with agy_execute background=true. Collecting returns the terminal result and frees the record.",
    promptSnippet: "Poll background agy tasks and collect finished results",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("list"),
          Type.Literal("status"),
          Type.Literal("collect"),
          Type.Literal("cancel"),
        ],
        { description: "Task action (default list).", default: "list" },
      ),
      handle: Type.Optional(
        Type.String({
          description: "Task handle from agy_execute (required for status, collect, cancel).",
        }),
      ),
      dir: Type.Optional(
        Type.String({
          description: "Filter listed tasks to a working directory. Defaults to current project root.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runner = getBackgroundRunner();
      const action = params.action ?? "list";
      // List/status carry summaries only: full response text and execution
      // details stay behind collect, so polling never bloats the transcript.
      const summarize = (task: {
        handle: string; dir: string; summary: string; model?: string; agent?: string;
        state: string; startedAt: number; updatedAt: number; progress: string[];
        error?: string; conversationId?: string;
      }) => ({
        handle: task.handle,
        dir: task.dir,
        summary: task.summary,
        model: task.model,
        agent: task.agent,
        state: task.state,
        startedAt: task.startedAt,
        updatedAt: task.updatedAt,
        progressTail: task.progress.slice(-3),
        error: task.error,
        conversationId: task.conversationId,
      });
      if (action === "list") {
        const cwd = await resolveToolDir(ctx.cwd, params.dir);
        const tasks = runner.list(cwd);
        if (tasks.length === 0) {
          return {
            content: [{ type: "text", text: `No background agy tasks for ${cwd}.` }],
            details: { dir: cwd, tasks: [] },
          };
        }
        const lines = tasks.map((task) => {
          const age = describeWhen(new Date(task.startedAt).toISOString());
          const latest = task.state === "running" && task.progress.length > 0
            ? ` · latest: ${task.progress[task.progress.length - 1]}`
            : "";
          return `${task.handle} · ${task.state}${task.model ? ` · ${task.model}` : ""} · ${age} · ${task.summary}${latest}`;
        });
        return {
          content: [{ type: "text", text: `background agy tasks for ${cwd}:\n${lines.join("\n")}` }],
          details: { dir: cwd, tasks: tasks.map(summarize) },
        };
      }
      if (!params.handle) throw new Error(`agy_tasks ${action} requires a handle`);
      if (action === "status") {
        const task = runner.get(params.handle);
        if (!task) throw new Error(`unknown background task '${params.handle}'`);
        const elapsed = `${Math.round((Date.now() - task.startedAt) / 1000)}s`;
        const progress = task.progress.length ? `\nrecent progress:\n${task.progress.slice(-5).join("\n")}` : "";
        const outcome = task.state === "running"
          ? ""
          : task.state === "done"
            ? "\nResult ready; use agy_tasks collect to retrieve it."
            : `\n${task.state}${task.error ? `: ${task.error}` : ""}`;
        const conversation = task.conversationId ? `\nconversation: ${task.conversationId}` : "";
        return {
          content: [{
            type: "text",
            text: `${task.handle} · ${task.state} · elapsed ${elapsed} · ${task.summary}${progress}${outcome}${conversation}`,
          }],
          details: { task: summarize(task) },
        };
      }
      if (action === "collect") {
        const task = runner.collect(params.handle);
        const body = task.state === "done"
          ? truncate(task.text ?? "(empty response)")
          : `${task.state}${task.error ? `: ${task.error}` : ""}`;
        const conversation = task.conversationId ? `\nconversation: ${task.conversationId}` : "";
        return {
          content: [{ type: "text", text: `${task.handle} · ${task.state}\n${body}${conversation}` }],
          details: { task },
        };
      }
      const cancelled = runner.cancel(params.handle);
      if (!cancelled) {
        const task = runner.get(params.handle);
        if (!task) throw new Error(`unknown background task '${params.handle}'`);
        return {
          content: [{ type: "text", text: `${task.handle} is already ${task.state}; nothing to cancel.` }],
          details: { task },
        };
      }
      return {
        content: [{ type: "text", text: `${params.handle} cancellation requested; poll status for settlement.` }],
        details: { handle: params.handle, cancelled: true },
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
        modelAliasSchema({ description: "Optional model alias to place first in the report." }),
      ),
      dir: Type.Optional(
        Type.String({
          description: "Working directory used for the agy CLI check. Defaults to current project root.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = await resolveToolDir(ctx.cwd, params.dir);
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
