import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeContext, type Provider, type ModelsRefreshOptions, type RefreshModelsContext, type AssistantMessage } from "@earendil-works/pi-ai";
import { describe, it, mock } from "node:test";
import { ModelRuntime, ModelRegistry, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piAgyExtension from "../extensions/index.js";
import { getProviderRunner, type ProviderTurnRequest, type ProviderRunEnd } from "../extensions/lib/provider.js";
import { withTimingFakeAgy, awaitWithWatchdog, type FakeChild } from "./timing-helpers.js";

type Lifecycle = { start: () => Promise<void>; stop: () => Promise<void>; notices: string[] };
async function withRuntime(fn: (runtime: ModelRuntime, registry: ModelRegistry, lifecycle: Lifecycle) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pi-agy-refresh-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const shutdown: Array<() => unknown> = [];
  const startup: Array<(...args: any[]) => unknown> = [];
  const notices: string[] = [];
  const stop = async () => { for (const handler of shutdown) await handler(); };
  try {
    const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(dir, "auth.json"), refreshOnCreate: false });
    const registry = new ModelRegistry(runtime);
    piAgyExtension({
      registerCommand() {}, registerTool() {},
      on(name: string, handler: (...args: any[]) => unknown) {
        if (name === "session_shutdown") shutdown.push(handler);
        if (name === "session_start") startup.push(handler);
      },
      registerProvider(provider: any, config: any) {
        if (typeof provider === "string") registry.registerProvider(provider, config);
        else registry.registerProvider(provider);
      },
    } as unknown as ExtensionAPI);
    // Drain the registration-triggered cache refresh before exercising the picker.
    await registry.refresh({ allowNetwork: false, providers: ["antigravity"] });
    await fn(runtime, registry, {
      start: async () => { for (const handler of startup) await handler({}, { modelRegistry: registry, ui: { notify: (s: string) => notices.push(s) } }); },
      stop, notices,
    });
  } finally {
    await stop();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

describe("native provider catalog refresh", () => {
  it("registers the supported refreshModels hook", async () => {
    await withTimingFakeAgy({}, async () => withRuntime(async (_runtime, registry) => {
      assert.equal(typeof registry.getProvider("antigravity")?.refreshModels, "function");
    }));
  });

  it("discovers new models through the installed ModelRuntime refresh", async () => {
    let output = "old-model Old\n";
    await withTimingFakeAgy({
      hangModels: true,
      onSpawn(args, child) {
        assert.deepEqual(args, ["models"], "catalog refresh must never infer");
        queueMicrotask(() => {
          child.stdout.end(output);
          child.close();
        });
      },
    }, async () => withRuntime(async (runtime, registry) => {
      output = "claude-sonnet-5-5 Sonnet\nclaude-opus-5-5-thinking Opus\nargon Argon\nfuture.model Future\n";
      const result = await awaitWithWatchdog(runtime.refresh({ allowNetwork: true, providers: ["antigravity"] }), "native refresh", 5000);
      assert.equal(result.errors.size, 0);
      assert.deepEqual(registry.getAll().filter((m) => m.provider === "antigravity").map((m) => m.id), [
        "claude-sonnet-5-5", "claude-opus-5-5-thinking", "argon", "future-model",
      ]);
    }));
  });
});

const providerId = "antigravity";
const refreshOptions = { providers: [providerId], allowNetwork: true };
const representativeCatalog = "claude-sonnet-5-5 Sonnet\nclaude-opus-5-5-thinking Opus\nargon Argon\nfuture.model Future\ngemini-9.1-flash-low Low\ngemini-9.1-flash-high High\n";
const ids = (registry: ModelRegistry) => registry.getAll().filter((m) => m.provider === providerId).map((m) => m.id);
const bounded = <T>(p: Promise<T>) => awaitWithWatchdog(p, "catalog operation", 5000);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function finish(child: FakeChild, output: string, code = 0) {
  if (code) child.stderr.end(output);
  else child.stdout.end(output);
  child.close(code);
}

// All process work is intercepted. onSpawn rejects anything except discovery;
// provider turns below use a recording runner, never a CLI inference process.
async function withDiscovery(
  respond: (child: FakeChild, call: number) => void,
  fn: (runtime: ModelRuntime, registry: ModelRegistry, lifecycle: Lifecycle, calls: () => number) => Promise<void>,
) {
  let calls = 0;
  await withTimingFakeAgy({
    hangModels: true,
    onSpawn(args, child) {
      assert.deepEqual(args, ["models"]);
      const call = ++calls;
      queueMicrotask(() => respond(child, call));
    },
  }, async (_children, _signal, track) => {
    await track(withRuntime(async (runtime, registry, lifecycle) => {
      assert.equal(calls, 0, "factory and native cache-only registration must not probe agy");
      await fn(runtime, registry, lifecycle, () => calls);
    }));
  });
}

async function recordTurn(registry: ModelRegistry, id: string, text = "hello", prior?: AssistantMessage) {
  const model = registry.find(providerId, id)!;
  assert.ok(model);
  return bounded(registry.streamSimple(model, {
    messages: [...(prior ? [prior] : []), { role: "user", content: text, timestamp: 0 }],
  }, { reasoning: "high" }).result());
}

// Use Pi's installed model selector and coordinator. Restrict only the provider
// selection on the real runtime call, so unrelated built-in catalogs cannot
// contact their servers. Discovery/publication/auth/snapshot remain native.
async function openPicker(runtime: ModelRuntime) {
  const root = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const { initTheme } = await import(pathToFileURL(join(root, "modes/interactive/theme/theme.js")).href);
  const { ModelSelectorComponent } = await import(pathToFileURL(join(root, "modes/interactive/components/model-selector.js")).href);
  initTheme("dark", false);
  const original = runtime.refresh.bind(runtime);
  const refresh = mock.method(runtime, "refresh", (options?: ModelsRefreshOptions) => original({ ...options, providers: [providerId] }));
  let renders = 0;
  const ready = deferred<void>();
  const picker = new ModelSelectorComponent({ requestRender() { if (++renders >= 2) ready.resolve(); } }, undefined, runtime, [], () => {}, () => {});
  try {
    await bounded(ready.promise);
    return picker.render(120).join("\n");
  } finally {
    picker.dispose();
    refresh.mock.restore();
  }
}

describe("catalog lifecycle through native Pi", { timeout: 15000 }, () => {
  it("discovers on session_start, refreshes each picker open, and preserves exact runner slugs", async () => {
    let output = representativeCatalog;
    await withDiscovery((child) => finish(child, output), async (runtime, registry, lifecycle, calls) => {
      await bounded(lifecycle.start());
      assert.equal(calls(), 1);
      assert.deepEqual(ids(registry), ["claude-sonnet-5-5", "claude-opus-5-5-thinking", "argon", "future-model", "gemini-9-1-flash"]);
      const provider = registry.getProvider(providerId)!;
      const handler = provider.streamSimple;
      const modelList = provider.getModels();
      const seen: ProviderTurnRequest[] = [];
      const runner = getProviderRunner(process.cwd());
      const stub = mock.method(runner, "run", async (request: ProviderTurnRequest): Promise<ProviderRunEnd> => {
        seen.push(request);
        return { kind: "done", result: { text: "ok", truncated: false, activity: [], conversationId: "fixture-conversation" } };
      });
      try {
        let argonReply: AssistantMessage | undefined;
        for (const id of ["claude-sonnet-5-5", "claude-opus-5-5-thinking", "argon", "future-model"]) {
          const reply = await recordTurn(registry, id);
          assert.equal(reply.stopReason, "stop");
          if (id === "argon") argonReply = reply;
        }
        assert.deepEqual(seen.map((r) => [r.fullModel, r.effort]), [
          ["claude-sonnet-5-5", undefined], ["claude-opus-5-5-thinking", undefined], ["argon", undefined], ["future.model", undefined],
        ]);
        const rendered = await openPicker(runtime);
        assert.match(rendered, /argon/);
        assert.match(rendered, /claude-sonnet-5-5/);
        assert.equal(calls(), 2);
        assert.equal(registry.getProvider(providerId)!.streamSimple, handler);
        assert.equal(provider.getModels(), modelList, "identical refresh keeps model objects stable");
        assert.equal((await recordTurn(registry, "argon", "again", argonReply)).stopReason, "stop");
        assert.equal(seen.at(-1)!.resumeConversationId, "fixture-conversation");
        assert.equal(getProviderRunner(process.cwd()), runner);
        output = "argon Argon\ngemini-9.1-flash-low Low\ngemini-9.1-flash-medium Medium\nnewcomer New\n";
        await openPicker(runtime);
        assert.equal(calls(), 3);
        assert.deepEqual(ids(registry), ["argon", "gemini-9-1-flash", "newcomer"]);
        assert.equal(registry.find(providerId, "gemini-9-1-flash")!.thinkingLevelMap?.high, null);
        assert.equal(registry.find(providerId, "gemini-9-1-flash")!.thinkingLevelMap?.medium, undefined);
        await recordTurn(registry, "gemini-9-1-flash");
        assert.equal(seen.at(-1)!.fullModel, "gemini-9.1-flash");
        assert.equal(seen.at(-1)!.effort, "medium");
        await registry.refresh({ ...refreshOptions, allowNetwork: false });
        assert.equal(calls(), 3);
        assert.deepEqual(ids(registry), ["argon", "gemini-9-1-flash", "newcomer"]);
      } finally { stub.mock.restore(); }
    });
  });

  it("reports initial auth failure, recovers on picker open, and retains last-good on later errors", async () => {
    let output = "sign-in required";
    let code = 1;
    await withDiscovery((child) => finish(child, output, code), async (runtime, registry, lifecycle) => {
      const fallback = ids(registry);
      await bounded(lifecycle.start());
      assert.deepEqual(ids(registry), fallback);
      assert.match(lifecycle.notices[0], /Could not refresh/);
      assert.match(await openPicker(runtime), /Could not refresh antigravity/);
      code = 0;
      output = representativeCatalog;
      assert.match(await openPicker(runtime), /Model catalogs refreshed/);
      const good = ids(registry);
      for (const malformed of ["", "Fetching models…\nID Name\n{broken json", "ERROR: authentication required"]) {
        output = malformed;
        const result = await bounded(runtime.refresh(refreshOptions));
        assert.match(result.errors.get(providerId)!.message, /no usable models/);
        assert.deepEqual(ids(registry), good);
      }
      code = 1;
      output = "sign-in required";
      const failed = await bounded(registry.refresh(refreshOptions));
      assert.match(failed.errors.get(providerId)!.message, /sign-in required/);
      assert.deepEqual(ids(registry), good);
      code = 0;
      output = "future-v2 Future";
      await openPicker(runtime);
      assert.deepEqual(ids(registry), ["future-v2"]);
    });
  });

  it("keeps fallback entries until generation-checked publication accepts the new catalog", async () => {
    await withDiscovery((child) => finish(child, "argon Argon"), async (runtime, registry) => {
      const fallback = ids(registry);
      const provider = registry.getProvider(providerId)! as Provider & Required<Pick<Provider, "refreshModels">>;
      const original = provider.refreshModels!.bind(provider);
      const reached = deferred<void>();
      const release = deferred<void>();
      const wrapper = mock.method(provider, "refreshModels", async (context: RefreshModelsContext) => original({
        ...context,
        publish: async (publication) => {
          reached.resolve();
          await release.promise;
          return context.publish(publication);
        },
      }));
      const controller = new AbortController();
      const refresh = runtime.refresh({ ...refreshOptions, signal: controller.signal });
      try {
        await bounded(reached.promise);
        assert.deepEqual(ids(registry), fallback);
        const stub = mock.method(getProviderRunner(process.cwd()), "run", async (): Promise<ProviderRunEnd> => ({ kind: "done", result: { text: "ok", truncated: false, activity: [] } }));
        try {
          // Direct handler call also uses the unpublished fallback, independently
          // of the registry snapshot that correctly hides Argon.
          const candidate = { ...provider.getModels()[0], id: "argon" };
          const result = await bounded(provider.streamSimple(candidate, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] })).result());
          assert.equal(result.stopReason, "error");
          assert.match(result.errorMessage!, /Unknown antigravity model/);
          assert.equal(stub.mock.calls.length, 0);
        } finally { stub.mock.restore(); }
        controller.abort();
        assert.equal((await bounded(refresh)).aborted, true);
        release.resolve();
        await bounded(registry.refresh({ ...refreshOptions, allowNetwork: false }));
        assert.deepEqual(ids(registry), fallback);
      } finally {
        release.resolve();
        controller.abort();
        await bounded(refresh);
        wrapper.mock.restore();
      }
    });
  });

  it("supersedes in-flight discovery and rejects its late result", async () => {
    const first = deferred<FakeChild>();
    await withDiscovery((child, call) => {
      if (call === 1) {
        child.kill = () => { child.killRequested = true; return true; };
        first.resolve(child);
      } else finish(child, "new-model New");
    }, async (runtime, registry) => {
      const older = runtime.refresh(refreshOptions);
      const child = await bounded(first.promise);
      try {
        await bounded(runtime.refresh(refreshOptions));
        assert.equal(child.killRequested, true);
        finish(child, "stale-model Stale");
        await bounded(older);
        assert.deepEqual(ids(registry), ["new-model"]);
      } finally { child.forceClose(); await bounded(older); }
    });
  });

  it("bounds discovery with the existing preflight timeout", async (t) => {
    const spawned = deferred<FakeChild>();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await withDiscovery((child) => spawned.resolve(child), async (runtime) => {
        const refresh = runtime.refresh(refreshOptions);
        const child = await bounded(spawned.promise);
        t.mock.timers.tick(9_999);
        assert.equal(child.killRequested, false);
        t.mock.timers.tick(1);
        assert.equal(child.killRequested, true);
        const result = await bounded(refresh);
        assert.match(result.errors.get(providerId)!.message, /timed out/);
      });
    } finally { t.mock.timers.reset(); }
  });

  it("cancels native refresh and shuts down startup discovery without late publication", async () => {
    const pending: FakeChild[] = [];
    let spawned = deferred<FakeChild>();
    await withDiscovery((child) => {
      child.kill = () => { child.killRequested = true; return true; };
      pending.push(child);
      spawned.resolve(child);
    }, async (runtime, registry, lifecycle) => {
      const fallback = ids(registry);
      const controller = new AbortController();
      const refresh = runtime.refresh({ ...refreshOptions, signal: controller.signal });
      const child = await bounded(spawned.promise);
      controller.abort();
      assert.equal((await bounded(refresh)).aborted, true);
      assert.equal(child.killRequested, true);
      finish(child, "late-model Late");
      spawned = deferred<FakeChild>();
      const startup = lifecycle.start();
      const startupChild = await bounded(spawned.promise);
      await lifecycle.stop();
      assert.equal(startupChild.killRequested, true);
      finish(startupChild, "old-runtime Old");
      await bounded(startup);
      assert.deepEqual(ids(registry), fallback);
      assert.equal(lifecycle.notices.length, 0);
      const result = await bounded(runtime.refresh(refreshOptions));
      assert.ok(result.errors.has(providerId), "a shut-down provider cannot restart discovery");
      assert.equal(pending.length, 2);
    });
  });
});
