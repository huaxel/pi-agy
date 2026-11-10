import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
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
 * Registers synchronously with the fallback catalog so provider setup can
 * never break extension load (or the delegation tools below); then refreshes
 * from live `agy models` in the background and re-registers when the catalog
 * changed — applied immediately, no `/reload` required. Refresh failures keep
 * the fallback. Do not install `@estebanforge/pi-antigravity-bridge`
 * alongside this package: both register the `antigravity` provider id and an
 * `/agy` command.
 */
function registerAgyProvider(pi: ExtensionAPI): void {
  if (typeof pi.registerProvider !== "function") return;
  // Shared mutable catalog: the turn handler closes over this array, so a
  // background refresh updates picker models without losing conversation
  // continuity or re-creating the handler.
  const entries: AgyProviderModelEntry[] = [...FALLBACK_PROVIDER_MODELS];
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
  const register = (): void => {
    pi.registerProvider(AGY_PROVIDER_ID, {
      name: "Antigravity (agy)",
      baseUrl: "agy-provider://antigravity",
      apiKey: "not-used",
      api: AGY_PROVIDER_API,
      models: entries.map((entry) => ({
        ...toProviderModelDef(entry),
        api: AGY_PROVIDER_API,
      })),
      streamSimple: (
        model: Model<any>,
        context: TranscriptContext,
        options?: SimpleStreamOptions,
      ): AssistantMessageEventStream =>
        streamSimple(
          { id: model.id },
          context.messages as unknown as ProviderTranscriptMessage[],
          options
            ? {
                signal: options.signal,
                reasoning: options.reasoning,
                tools: getCurrentTools(context.messages) as unknown as ProviderToolSource[],
              }
            : undefined,
        ) as unknown as AssistantMessageEventStream,
    });
  };
  try {
    register();
  } catch {
    // Provider setup is additive; delegation tools must survive it.
    return;
  }
  void (async () => {
    try {
      const raw = await runPreflightCommand(
        ["models"],
        process.cwd(),
        undefined,
        "agy provider model discovery",
        true,
      );
      const live = parseProviderCatalog(raw);
      if (live.length === 0) return;
      if (areProviderCatalogsEqual(entries, live)) return;
      entries.splice(0, entries.length, ...live);
      register();
    } catch {
      // Refresh failures keep the fallback catalog.
    }
  })();
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
