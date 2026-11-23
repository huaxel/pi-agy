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
import { formatLiveBackgroundStatus } from "./lib/background.js";
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
import {
  loadProviderCatalogCache,
  recordProviderCatalogProvenance,
  saveProviderCatalogCache,
} from "./lib/provider-catalog-store.js";
import { runPreflightCommand } from "./lib/spawn.js";
import { createAgySetup } from "./lib/setup.js";

export { truncate } from "./lib/output.js";

type StatusUi = { setStatus?: (key: string, text: string | undefined) => void };

/**
 * Footer handle for background-run visibility. Doctor and provider turns use
 * their own keys, so this one only ever reports delegated work.
 */
let backgroundUi: StatusUi | undefined;
/**
 * The runner is a module singleton shared across extension instances; a
 * reload must detach the previous listener or every reload leaves another one
 * (each holding its own module graph) on the same set.
 */
let backgroundFooterUnsubscribe: (() => void) | undefined;

function attachBackgroundFooter(): void {
  try {
    backgroundFooterUnsubscribe?.();
    backgroundFooterUnsubscribe = getBackgroundRunner().subscribe(refreshBackgroundStatus);
  } catch {
    backgroundFooterUnsubscribe = undefined;
  }
}

function detachBackgroundFooter(): void {
  try {
    backgroundFooterUnsubscribe?.();
  } catch {
    // Detaching is best effort; a reload still re-attaches.
  }
  backgroundFooterUnsubscribe = undefined;
}

function setBackgroundStatus(text: string | undefined): void {
  try {
    backgroundUi?.setStatus?.("agy-bg", text);
  } catch {
    // Status updates are best effort and must never disrupt a run.
  }
}

/**
 * One running task is the honest summary; more than one says so and names the
 * newest. Terminal tasks leave the footer as soon as they settle, because a
 * finished run has nothing live to report.
 */
function refreshBackgroundStatus(): void {
  let running: ReturnType<ReturnType<typeof getBackgroundRunner>["list"]> = [];
  try {
    running = getBackgroundRunner().list().filter((task) => task.state === "running");
  } catch {
    setBackgroundStatus(undefined);
    return;
  }
  const newest = running[running.length - 1];
  if (!newest) {
    setBackgroundStatus(undefined);
    return;
  }
  const live = formatLiveBackgroundStatus(newest) ?? undefined;
  setBackgroundStatus(running.length > 1 ? `${live} (+${running.length - 1} more)` : live);
}

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
  // Only a generation-checked publication may mutate these entries. Start from
  // the last roster this machine actually observed: Pi resolves configured
  // model scopes during startup, and an empty catalog there reports a real
  // model as "No models match pattern" before discovery can answer.
  const cached = loadProviderCatalogCache();
  recordProviderCatalogProvenance("cache", cached.length);
  const entries: AgyProviderModelEntry[] = [
    ...(cached.length > 0 ? cached : FALLBACK_PROVIDER_MODELS),
  ];
  const shutdown = new AbortController();
  let activeUi: { setStatus?: (key: string, text: string | undefined) => void } | undefined;
  const setLiveStatus = (label: string | undefined): void => {
    try {
      activeUi?.setStatus?.(AGY_PROVIDER_ID, label);
    } catch {
      // Status updates are best effort and must never disrupt a turn.
    }
  };
  pi.on?.("session_shutdown", () => {
    setLiveStatus(undefined);
    activeUi = undefined;
    backgroundUi = undefined;
    detachBackgroundFooter();
    shutdown.abort();
  });
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
    { entries, onActivity: setLiveStatus },
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
    // agy owns authentication, and this provider is deliberately configured
    // unconditionally rather than gated on an availability probe.
    //
    // There is no cheap signed-in signal to gate on: unlike `claude auth
    // status`, agy exposes no auth subcommand, and it keeps credentials in an
    // opaque state file rather than anything meant to be read. The only probe
    // that proves a usable account is `agy models`, which is a network call.
    // Running that during provider enumeration would hide antigravity/* on a
    // transient failure — turning a working session into `No models match
    // pattern` — which is the exact failure the persisted roster exists to
    // prevent. A missing or signed-out CLI therefore surfaces where it belongs:
    // an empty picker, a `/agy doctor` line, and a turn error that names it.
    // `resolve` stays unconditional on purpose (see above), but `login` is
    // what makes `/login antigravity` exist: Pi lists providers that can
    // explain how to sign in. Antigravity's sign-in belongs to agy, so the flow
    // checks and waits — it never performs OAuth and never stores a token.
    auth: {
      apiKey: {
        name: "Antigravity CLI (sign in with agy)",
        login: async (interaction) =>
          createAgySetup().login(
            {
              signal: interaction.signal,
              notify: (event) => interaction.notify(event),
              // Pi renders this as an openable link. The URL comes from agy's
              // own handshake; nothing here performs OAuth.
              notifyUrl: (url) => interaction.notify({ type: "auth_url", url }),
              prompt: (prompt) => interaction.prompt(prompt),
            },
            { cwd: process.cwd() },
          ),
        resolve: async () => ({ auth: { apiKey: "not-used" } }),
      },
    },
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
      if (areProviderCatalogsEqual(entries, live)) {
        // Same roster, possibly only now confirmed on disk (first run after an
        // older version, or a cache cleared by hand).
        recordProviderCatalogProvenance("live", live.length);
        saveProviderCatalogCache(live);
        return;
      }
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
      recordProviderCatalogProvenance("live", live.length);
      saveProviderCatalogCache(live);
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
  pi.on?.("session_start", (_event, ctx) => {
    if (ctx.hasUI && typeof ctx.ui?.setStatus === "function") {
      activeUi = ctx.ui;
      backgroundUi = ctx.ui;
      attachBackgroundFooter();
      refreshBackgroundStatus();
    }
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]);
    // Keep provider discovery off Pi's session-start critical path. The model
    // picker also refreshes on demand, so startup can use the cached catalog.
    void ctx.modelRegistry.refresh({
      providers: [AGY_PROVIDER_ID], allowNetwork: true, signal,
    }).then((result) => {
      if (!signal.aborted && result.errors.has(AGY_PROVIDER_ID)) {
        ctx.ui.notify("Could not refresh Antigravity models; showing cached models. Reopen /model to retry.", "warning");
      }
    }).catch(() => {
      if (!signal.aborted) {
        ctx.ui.notify("Could not refresh Antigravity models; showing cached models. Reopen /model to retry.", "warning");
      }
    });
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
