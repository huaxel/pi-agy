import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  inspectAgyModels,
  isAgyModel,
  normalizeAgyAgentName,
  resolveAgyModelId,
} from "./lib/cli.js";
import { truncate } from "./lib/output.js";
import { AGY_RUN_ENTRY_TYPE, renderAgyRunReceipt } from "./lib/render.js";
import { getSession } from "./lib/sessions.js";

import { MODEL_ALIASES, MODEL_KEYS, MODE_KEYS, parseAgyCommandArgs } from "./lib/command-args.js";
import { executeConfirmedRun, MODE_OPTIONS, optionKey, runSessionsPicker, type InteractiveRun } from "./command-run.js";
import { showAgents, showBridge, showDoctor, showUsage } from "./command-info.js";
import { buildAcceptEditsConfirm } from "./lib/confirm.js";

function modelOptions(): string[] {
  return Object.keys(MODEL_ALIASES).map((alias) =>
    `${alias} — ${resolveAgyModelId(MODEL_ALIASES[alias])}`,
  );
}

export { parseAgyCommandArgs, type AgyCommandArgs } from "./lib/command-args.js";

/**
 * Register the human-callable `/agy` command. Missing parts are filled with
 * dialogs, write-capable runs are confirmed, and agy executes directly — the
 * confirmed parameters stay authoritative with no second LLM turn.
 */
export function registerAgyCommand(pi: ExtensionAPI): void {
  pi.registerEntryRenderer?.(AGY_RUN_ENTRY_TYPE, (entry, options, theme) =>
    renderAgyRunReceipt(entry.data, options, theme),
  );

  pi.registerCommand("agy", {
    description:
      "Run agy directly: /agy [mode] [model] [agent=name] [continue] [context=summary|recent] [timeout=10m] <prompt>; use /agy agents to list custom agents.",
    getArgumentCompletions: (prefix: string) => {
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

      let model = parsed.model;
      let agent = parsed.agent;
      if (parsed.continue && (!model || !agent)) {
        const prior = await getSession(ctx.cwd);
        if (!model && prior?.last_model && isAgyModel(prior.last_model)) model = prior.last_model;
        if (!agent && prior?.last_agent) {
          try {
            agent = normalizeAgyAgentName(prior.last_agent);
          } catch {
            // Ignore malformed legacy session metadata.
          }
        }
      }
      if (!model) {
        // Refresh once when opening the picker so labels show the concrete IDs
        // exposed by this account, while retaining the stable alias interface.
        try {
          await inspectAgyModels(ctx.cwd, ctx.signal);
        } catch {
          // Keep the picker usable with the built-in fallback aliases.
        }
        const pick = await ctx.ui.select("agy model", modelOptions());
        if (!pick) {
          ctx.ui.notify("agy: cancelled", "info");
          return;
        }
        model = MODEL_ALIASES[optionKey(pick)] ?? "flash-medium";
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
        model,
        agent,
        prompt,
        continue: parsed.continue,
        timeout_ms: parsed.timeout_ms,
        context: parsed.context,
      });
    },
  });
}
