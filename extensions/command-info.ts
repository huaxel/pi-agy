import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  checkAgyUsage,
  formatAgyUsage,
  inspectAgyAgents,
  resolveAgyModelId,
  type AgyModel,
} from "./lib/cli.js";
import { runAgyDoctor } from "./lib/doctor.js";
import { loadAgyConfig, saveAgyConfig } from "./lib/config.js";
import { describeProviderBridges, resetProviderBridges } from "./lib/provider.js";

/** `/agy doctor` — diagnose the CLI and local integration without inference. */
export async function showDoctor(ctx: ExtensionCommandContext): Promise<void> {
  try {
    await ctx.waitForIdle();
    ctx.ui.setStatus("agy", "agy: running diagnostics…");
    const report = await runAgyDoctor(ctx.cwd, ctx.signal);
    const type = report.status === "error" ? "error" : report.status === "warn" ? "warning" : "info";
    ctx.ui.notify(report.text, type);
  } catch (error) {
    if (ctx.signal?.aborted) {
      ctx.ui.notify("agy: doctor cancelled", "info");
    } else {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`agy doctor failed: ${message}`, "error");
    }
  } finally {
    ctx.ui.setStatus("agy", undefined);
  }
}

/** `/agy agents` — list configured custom agents without inference. */
export async function showAgents(ctx: ExtensionCommandContext): Promise<void> {
  try {
    await ctx.waitForIdle();
    ctx.ui.setStatus("agy", "agy: discovering custom agents…");
    const agents = await inspectAgyAgents(ctx.cwd, ctx.signal);
    ctx.ui.notify(
      agents.length ? `configured agy agents:\n${agents.map((agent) => `- ${agent}`).join("\n")}` : "No custom agy agents are configured.",
      "info",
    );
  } catch (error) {
    if (ctx.signal?.aborted) ctx.ui.notify("agy: agent discovery cancelled", "info");
    else {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`agy agent discovery failed: ${message}`, "error");
    }
  } finally {
    ctx.ui.setStatus("agy", undefined);
  }
}

/** `/agy usage` — show model quotas without starting an agent turn. */
export async function showUsage(
  ctx: ExtensionCommandContext,
  model?: AgyModel,
): Promise<void> {
  try {
    await ctx.waitForIdle();
    const snapshot = await checkAgyUsage(ctx.cwd, ctx.signal);
    const report = formatAgyUsage(snapshot, model ? resolveAgyModelId(model) : undefined);
    ctx.ui.notify(report ?? "agy quota information is unavailable in this CLI version", report ? "info" : "warning");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`agy usage check failed: ${message}`, "error");
  }
}

/** `/agy bridge [on|off|status]` — inspect or toggle the provider MCP bridge. */
export async function showBridge(ctx: ExtensionCommandContext, arg?: string): Promise<void> {
  const sub = (arg ?? "status").toLowerCase();
  if (sub !== "on" && sub !== "off" && sub !== "status") {
    ctx.ui.notify("agy: bridge takes on, off, or no argument (status)", "error");
    return;
  }
  try {
    await ctx.waitForIdle();
    if (sub === "on" || sub === "off") {
      ctx.ui.setStatus("agy", `agy: turning the provider bridge ${sub}…`);
      await saveAgyConfig({ providerBridge: sub === "on" });
      // Drop memoized servers so the next provider turn re-resolves;
      // drivers recycle on the bridge-dir change by themselves.
      await resetProviderBridges();
      ctx.ui.notify(
        sub === "on"
          ? "Provider bridge on: agy turns get Pi tools via localhost MCP (takes effect on the next turn)."
          : "Provider bridge off: agy turns run plain (takes effect on the next turn).",
        "info",
      );
      return;
    }
    const config = await loadAgyConfig().catch(() => ({ providerBridge: true as const }));
    const enabled = config.providerBridge !== false;
    const bridges = describeProviderBridges();
    const running = bridges.filter((bridge) => bridge.running);
    const lines = [
      `Provider bridge: ${enabled ? "on" : "off"} (agy-config.json${enabled ? "" : " — set providerBridge or run /agy bridge on"})`,
      running.length > 0
        ? `running servers (${running.length}):\n${running.map((bridge) => `- ${bridge.dir} · ${bridge.toolCount ?? 0} tools`).join("\n")}`
        : "no bridge servers running (one starts on the next provider turn)",
    ];
    ctx.ui.notify(lines.join("\n"), "info");
  } catch (error) {
    if (ctx.signal?.aborted) ctx.ui.notify("agy: bridge check cancelled", "info");
    else {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`agy bridge failed: ${message}`, "error");
    }
  } finally {
    ctx.ui.setStatus("agy", undefined);
  }
}
