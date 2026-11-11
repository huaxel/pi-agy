import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
  type Provider,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { registerAgyCommand } from "./commands.js";
import { closeProviderDrivers } from "./lib/provider.js";
import { getBackgroundRunner, registerAgyTools } from "./tools.js";

export { getBackgroundRunner, resolveAgyMode } from "./tools.js";
import {
  AGY_PROVIDER_API,
  AGY_PROVIDER_ID,
  createAgyStreamSimple,
  type ProviderToolSource,
  type ProviderTranscriptMessage,
} from "./lib/provider.js";
import {
  areProviderCatalogsEqual,
  FALLBACK_PROVIDER_MODELS,
  parseProviderCatalog,
  toProviderModelDef,
  type AgyProviderModelEntry,
} from "./lib/provider-models.js";
import { runPreflightCommand } from "./lib/spawn.js";

export { truncate } from "./lib/output.js";

/**
 * Register agy-backed models in Pi's global `/model` picker as
 * `antigravity/*`.
 *
 * Registers a synchronous fallback and lets Pi refresh the catalog whenever
 * its model picker opens. Both picker definitions and turn resolution are
 * published atomically through Pi's generation-checked native refresh API.
 * Do not install `@estebanforge/pi-antigravity-bridge` alongside this package:
 * both register the `antigravity` provider id and an `/agy` command.
 */
function registerAgyProvider(pi: ExtensionAPI): void {
  if (typeof pi.registerProvider !== "function") return;
  // Keep one handler and catalog array for conversation/driver continuity.
  // Only a generation-checked publication may mutate these entries.
  const entries: AgyProviderModelEntry[] = [...FALLBACK_PROVIDER_MODELS];
  const shutdown = new AbortController();
  pi.on?.("session_shutdown", () => { shutdown.abort(); });
  const streamSimple = createAgyStreamSimple(
    {
      createStream: () => {
        const real = createAssistantMessageEventStream();
        // Keep the real stream object (async iteration, result()) and only
        // widen push: provider.ts emits protocol-shaped plain objects.
        // Bind first: after assign, real.push is the override itself.
        const push = real.push.bind(real);
        return Object.assign(real, {
          push: (event: Record<string, unknown>) =>
            push(event as unknown as AssistantMessageEvent),
        });
      },
      getSystemPrompt: (messages) =>
        getCurrentSystemPrompt(messages as unknown as Parameters<typeof getCurrentSystemPrompt>[0]),
    },
    { entries },
  );
  const baseUrl = "agy-provider://antigravity";
  const modelDefinitions = (catalog: readonly AgyProviderModelEntry[]): Model<any>[] =>
    catalog.map((entry) => ({
      ...toProviderModelDef(entry),
      api: AGY_PROVIDER_API,
      provider: AGY_PROVIDER_ID,
      baseUrl,
    }));
  let models = modelDefinitions(entries);
  const stream: Provider["streamSimple"] = (model, context, options) =>
    streamSimple(
      { id: model.id },
      context.messages as unknown as ProviderTranscriptMessage[],
      {
        signal: options?.signal,
        reasoning: options?.reasoning,
        tools: getCurrentTools(context.messages) as unknown as ProviderToolSource[],
      },
    ) as unknown as AssistantMessageEventStream;
  const provider: Provider = {
    id: AGY_PROVIDER_ID,
    name: "Antigravity (agy)",
    baseUrl,
    // agy owns authentication. Pi must regard this ambient CLI provider as
    // configured so refresh can recover after the user signs in to agy.
    auth: { apiKey: { name: "Antigravity CLI", resolve: async () => ({ auth: { apiKey: "not-used" } }) } },
    getModels: () => models,
    async refreshModels(context) {
      const signal = AbortSignal.any([context.signal, shutdown.signal]);
      signal.throwIfAborted();
      // Native refresh first calls a cache-only phase, even for network
      // refreshes. Never launch agy (which can contact its server) there.
      if (!context.allowNetwork) return;
      const raw = await runPreflightCommand(
        ["models"], process.cwd(), signal, "agy provider model discovery", true,
      );
      signal.throwIfAborted();
      const live = parseProviderCatalog(raw);
      if (live.length === 0) throw new Error("agy models returned no usable models");
      if (areProviderCatalogsEqual(entries, live)) return;
      const definitions = modelDefinitions(live);
      await context.publish({
        update: () => {
          // Pi checks its generation/signal immediately before this callback;
          // session shutdown also invalidates a still-live runtime's refresh.
          signal.throwIfAborted();
          entries.splice(0, entries.length, ...live);
          models = definitions;
        },
      });
    },
    stream: (model, context, options) => stream(model, context, options as SimpleStreamOptions),
    streamSimple: stream,
  };
  try {
    pi.registerProvider(provider);
  } catch {
    // Provider setup is additive; delegation tools must survive it.
    shutdown.abort();
    return;
  }
  pi.on?.("session_start", async (_event, ctx) => {
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]);
    const result = await ctx.modelRegistry.refresh({
      providers: [AGY_PROVIDER_ID], allowNetwork: true, signal,
    });
    if (!signal.aborted && result.errors.has(AGY_PROVIDER_ID)) {
      ctx.ui.notify("Could not refresh Antigravity models; showing cached models. Reopen /model to retry.", "warning");
    }
  });
}

export default function piAgyExtension(pi: ExtensionAPI) {
  registerAgyCommand(pi);
  registerAgyProvider(pi);
  // Persistent driver processes and background runs must not outlive the
  // session (a detached run editing files after exit would be a ghost).
  try {
    pi.on?.("session_shutdown", async () => {
      try {
        await closeProviderDrivers();
      } catch {
        // Shutdown disposal is best effort; turns still work without it.
      }
      try {
        await getBackgroundRunner().shutdown();
      } catch {
        // Best effort; the OS reaps anything left.
      }
    });
  } catch {
    // Shutdown disposal is best effort; turns still work without it.
  }

  registerAgyTools(pi);
}
