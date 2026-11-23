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
import { AGY_PROVIDER_ID, describeProviderBridges, resetProviderBridges } from "./lib/provider.js";
import { createAgySetup } from "./lib/setup.js";
import { INSTALL_HINT } from "./lib/spawn.js";

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

/**
 * The command's own wait bound. Shorter than the library default because a
 * command blocks the TUI and has no cancellation while the agent is idle;
 * measured sign-ins completed in well under a minute.
 */
const SETUP_COMMAND_WAIT_MS = 2 * 60_000;

/**
 * `/agy setup` — guided install/sign-in check. Signing in still happens in
 * agy; this names the exact state, the exact command, and then watches for the
 * sign-in so the picker fills in without a restart.
 */
export async function showSetup(ctx: ExtensionCommandContext): Promise<void> {
  const setup = createAgySetup();
  try {
    await ctx.waitForIdle();
    ctx.ui.setStatus("agy", "agy: checking installation and sign-in…");
    const status = await setup.detect({ cwd: ctx.cwd, signal: ctx.signal });
    if (status.state === "ready") {
      ctx.ui.notify(`${status.detail}. Open /model and pick antigravity/*.`, "info");
      await refreshModels(ctx);
      return;
    }
    if (status.state === "missing-cli") {
      ctx.ui.notify(`${INSTALL_HINT}, then run \`agy\` once to sign in, then /agy setup again.`, "warning");
      return;
    }
    if (status.state === "error") {
      ctx.ui.notify(`agy setup could not verify the CLI: ${status.detail}`, "error");
      return;
    }

    // Signed out. Start agy's own sign-in rather than sending the user to a
    // second terminal: `agy acp` opens the browser and performs the exchange,
    // and this only watches. The command context has no abort signal while the
    // agent is idle, so the wait is bounded and says so instead of promising a
    // key that does not exist.
    const relay = setup.startSignIn({
      cwd: ctx.cwd,
      signal: ctx.signal,
      onUrl: (url) =>
        ctx.ui.notify(`agy asked for this sign-in link: ${url}`, "info"),
    });
    ctx.ui.notify(
      relay
        ? "Starting agy's sign-in — finish it in the browser window agy opens. If no window appears, run `agy` in a terminal; this keeps waiting either way."
        : "agy is not signed in. Run `agy` in a terminal and finish the browser sign-in; this keeps waiting either way.",
      "info",
    );
    let relayHintShown = false;
    const final = await setup.waitForSignIn({
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutMs: SETUP_COMMAND_WAIT_MS,
      onProgress: (elapsedMs) => {
        ctx.ui.setStatus(
          "agy",
          `agy: waiting for sign-in (${Math.round(elapsedMs / 1000)}s, up to ${Math.round(SETUP_COMMAND_WAIT_MS / 60_000)}m)…`,
        );
        // One nudge, not a stream of them: the browser path can legitimately
        // take a while, and the manual command is the only other way in.
        if (relay && !relayHintShown && elapsedMs > 20_000) {
          relayHintShown = true;
          ctx.ui.notify("Still waiting for agy's sign-in. If no browser opened, run `agy` in a terminal — this picks it up.", "info");
        }
      },
    });
    relay?.stop();
    if (final.state !== "ready") {
      ctx.ui.notify(
        `agy setup: still not signed in after ${Math.round(SETUP_COMMAND_WAIT_MS / 60_000)} minutes. Run \`agy\` in a terminal to sign in, then /agy setup again. ${final.detail}`,
        "warning",
      );
      return;
    }
    ctx.ui.notify(`${final.detail}. Open /model and pick antigravity/*.`, "info");
    await refreshModels(ctx);
  } catch (error) {
    if (ctx.signal?.aborted) ctx.ui.notify("agy: setup cancelled", "info");
    else ctx.ui.notify(`agy setup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    ctx.ui.setStatus("agy", undefined);
  }
}

async function refreshModels(ctx: ExtensionCommandContext): Promise<void> {
  try {
    const result = await ctx.modelRegistry.refresh({
      providers: [AGY_PROVIDER_ID],
      allowNetwork: true,
      signal: ctx.signal,
    });
    if (result.errors.has(AGY_PROVIDER_ID)) {
      ctx.ui.notify("Antigravity models did not refresh; open /model to retry.", "warning");
    }
  } catch {
    // A refresh failure is not a setup failure: the picker retries on open.
  }
}
