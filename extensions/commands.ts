import path from "node:path";
import { inspectAgyModelIds } from "./lib/inspect.js";
import { storedModelSelection, type AgyModelSelection } from "./lib/model-selection.js";
import type { AgyModelId } from "./lib/provider-models.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  parseModelCatalog,
  updateModelCatalog,
  normalizeAgyAgentName,
  resolveAgyModelId,
} from "./lib/cli.js";
import { AGY_RUN_ENTRY_TYPE, renderAgyRunReceipt } from "./lib/render.js";
import { getSession } from "./lib/sessions.js";

import { MODEL_ALIASES, MODEL_KEYS, MODE_KEYS, parseAgyCommandArgs } from "./lib/command-args.js";
import { executeConfirmedRun, MODE_OPTIONS, optionKey, runSessionsPicker, type InteractiveRun } from "./command-run.js";
import { showAgents, showBridge, showDoctor, showUsage } from "./command-info.js";

export { parseAgyCommandArgs, type AgyCommandArgs } from "./lib/command-args.js";

/**
 * Register the human-callable `/agy` command. Missing parts are filled with
 * dialogs, write-capable runs are confirmed, and agy executes directly — the
 * confirmed parameters stay authoritative with no second LLM turn.
 */
export function registerAgyCommand(pi: ExtensionAPI): void {
  const rosters = new Map<string, { ids?: AgyModelId[]; request: number }>();
  let completionCwd: string | undefined;
  pi.registerEntryRenderer?.(AGY_RUN_ENTRY_TYPE, (entry, options, theme) =>
    renderAgyRunReceipt(entry.data, options, theme),
  );

  pi.registerCommand("agy", {
    description:
      "Run agy directly: /agy [mode] [model|model=id] [agent=name] [continue] [context=summary|recent] [timeout=10m] <prompt>; use /agy agents to list custom agents.",
    getArgumentCompletions: (prefix: string) => {
      const exactPrefix = /(?:^|\s)model=(\S*)$/.exec(prefix);
      if (exactPrefix) {
        // Pi replaces the whole argument prefix with item.value, not just
        // the current token. Preserve every preceding option and separator.
        const beforeId = prefix.slice(0, prefix.length - exactPrefix[1].length);
        return (rosters.get(completionCwd ?? "")?.ids ?? [])
          .filter(id => id.startsWith(exactPrefix[1]))
          .map(id => ({ value: `${beforeId}${id}`, label: `${id} (last successful discovery)` }));
      }
      const tokens = prefix.trim().split(/\s+/).filter(Boolean);
      const p = prefix.toLowerCase();

      if (
        tokens.length === 1 &&
        (MODE_KEYS.includes(tokens[0] as (typeof MODE_KEYS)[number]) ||
          tokens[0] === "usage" ||
          tokens[0] === "quota")
      ) {
        return [
          ...MODEL_KEYS.map((k) => ({ value: k, label: k })),
          ...(tokens[0] === "usage" || tokens[0] === "quota"
            ? []
            : [
                { value: "model=", label: "model=" },
                { value: "agent=", label: "agent=" },
                { value: "continue", label: "continue" },
                { value: "timeout=10m", label: "timeout=10m" },
              ]),
        ];
      }
      if (
        tokens.length === 2 &&
        (tokens[0] === "usage" || tokens[0] === "quota")
      ) {
        const partial = prefix.endsWith(" ") ? "" : tokens[1].toLowerCase();
        return MODEL_KEYS.filter((key) => key.startsWith(partial)).map((key) => ({
          value: key,
          label: key,
        }));
      }
      if (tokens.length <= 1) {
        const modes = MODE_KEYS.filter((m) => m.startsWith(tokens[0] ?? ""));
        const models = MODEL_KEYS.filter((k) => k.startsWith(p));
        const extras = [
          "continue",
          "sessions",
          "agents",
          "agent=",
          "doctor",
          "usage",
          "quota",
          "bridge",
          "context=summary",
          "context=recent",
          "timeout=10m",
          "model=",
        ].filter((k) => k.startsWith(p));
        return [
          ...modes.map((m) => ({ value: m, label: m })),
          ...models.map((m) => ({ value: m, label: m })),
          ...extras.map((k) => ({ value: k, label: k })),
        ];
      }
      return null;
    },
    handler: async (args, ctx) => {
      completionCwd = path.resolve(ctx.cwd);
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/agy requires interactive (TUI) mode", "error");
        return;
      }

      const command = args.trim().toLowerCase();
      if (command === "sessions") {
        await runSessionsPicker(pi, ctx);
        return;
      }
      const agentsMatch = /^agents(?:\s+(.+))?$/.exec(command);
      if (agentsMatch) {
        if (agentsMatch[1]) {
          ctx.ui.notify("agy: agents takes no arguments", "error");
          return;
        }
        await showAgents(ctx);
        return;
      }
      const doctorMatch = /^doctor(?:\s+(.+))?$/.exec(command);
      if (doctorMatch) {
        if (doctorMatch[1]) {
          ctx.ui.notify("agy: doctor takes no arguments", "error");
          return;
        }
        await showDoctor(ctx);
        return;
      }
      const usageMatch = /^(?:usage|quota)(?:\s+(\S+))?$/.exec(command);
      if (usageMatch) {
        const requestedModel = usageMatch[1] ? MODEL_ALIASES[usageMatch[1]] : undefined;
        if (usageMatch[1] && !requestedModel) {
          ctx.ui.notify(`agy: unknown model alias '${usageMatch[1]}'`, "error");
          return;
        }
        await showUsage(ctx, requestedModel);
        return;
      }
      const bridgeMatch = /^bridge(?:\s+(\S+))?$/.exec(command);
      if (bridgeMatch) {
        await showBridge(ctx, bridgeMatch[1]);
        return;
      }

      const parsed = parseAgyCommandArgs(args);
      if (parsed.error) {
        ctx.ui.notify(`agy: ${parsed.error}`, "error");
        return;
      }

      let mode: InteractiveRun["mode"] | undefined = parsed.mode;
      if (!mode) {
        const pick = await ctx.ui.select("agy mode", MODE_OPTIONS);
        if (!pick) {
          ctx.ui.notify("agy: cancelled", "info");
          return;
        }
        mode = optionKey(pick) as InteractiveRun["mode"];
      }

      let modelSelection: AgyModelSelection | undefined = parsed.model_id
        ? { model_id: parsed.model_id }
        : parsed.model ? { model: parsed.model } : undefined;
      let agent = parsed.agent;
      if (parsed.continue && (!modelSelection || !agent)) {
        const prior = await getSession(ctx.cwd);
        if (!modelSelection) modelSelection = storedModelSelection(prior?.last_model, prior?.last_raw_model_id);
        if (!agent && prior?.last_agent) {
          try { agent = normalizeAgyAgentName(prior.last_agent); } catch {
            // Ignore malformed legacy session metadata.
          }
        }
      }
      if (!modelSelection) {
        const key = path.resolve(ctx.cwd);
        let state = rosters.get(key);
        if (!state) {
          state = { request: 0 };
          rosters.set(key, state);
        }
        const request = ++state.request;
        let live = false;
        try {
          const ids = await inspectAgyModelIds(ctx.cwd, ctx.signal);
          if (ctx.signal?.aborted || state.request !== request) return;
          updateModelCatalog(parseModelCatalog(ids.join("\n")));
          state.ids = ids;
          live = true;
        } catch (error) {
          if (ctx.signal?.aborted || state.request !== request) return;
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`agy model discovery failed: ${message}. ${state.ids ? "Using last successful roster; availability is unverified." : "Using built-in alias fallback; availability is unverified."}`, "warning");
        }
        const choices: Array<{ label: string; selection: AgyModelSelection }> = [
          ...(state.ids ?? []).map(id => ({ label: id, selection: { model_id: id } })),
          ...Object.entries(MODEL_ALIASES).map(([alias, model]) => ({
            label: `${alias} — alias shortcut (${resolveAgyModelId(model)}; availability unverified)`,
            selection: { model },
          })),
        ];
        const title = live ? "agy model (discovered IDs; alias shortcuts below)"
          : state.ids ? "agy model (last successful roster; availability unverified)"
          : "agy model (built-in alias fallback; availability unverified)";
        const pick = await ctx.ui.select(title, choices.map(choice => choice.label));
        if (ctx.signal?.aborted || state.request !== request) return;
        modelSelection = choices.find(choice => choice.label === pick)?.selection;
        if (!modelSelection) {
          ctx.ui.notify("agy: cancelled", "info");
          return;
        }
      }

      let prompt = parsed.prompt;
      if (!prompt) {
        const text = await ctx.ui.editor("agy task", "");
        if (!text?.trim()) {
          ctx.ui.notify("agy: cancelled (empty task)", "info");
          return;
        }
        prompt = text.trim();
      }

      await executeConfirmedRun(pi, ctx, {
        mode,
        ...modelSelection,
        agent,
        prompt,
        continue: parsed.continue,
        timeout_ms: parsed.timeout_ms,
        context: parsed.context,
      });
    },
  });
}
