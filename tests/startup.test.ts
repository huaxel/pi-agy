import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { it, mock } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { saveProviderCatalogCache } from "../extensions/lib/provider-catalog-store.js";

it("registers the Antigravity provider, command and tools without loading the bridge", async () => {
  // Isolate the agent dir: registration legitimately reads the last observed
  // roster from disk, and that must not depend on the developer's own machine.
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-startup-"));
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      assert.doesNotMatch(specifier, /(?:^|\/)provider-mcp\.[jt]s$|^@modelcontextprotocol\/sdk(?:\/|$)/,
        `extension startup must not load ${specifier}`);
      return nextResolve(specifier, context);
    },
  });
  try {
    const { default: activate } = await import("../extensions/index.js");
    const commands: string[] = [];
    const tools: string[] = [];
    const providers: Provider[] = [];
    activate({
      registerCommand: (name: string) => commands.push(name),
      registerTool: ({ name }: { name: string }) => tools.push(name),
      registerProvider: (provider: Provider) => providers.push(provider),
      on() {},
    } as unknown as ExtensionAPI);
    assert.ok(commands.includes("agy"));
    assert.ok(tools.includes("agy_execute"));
    assert.equal(providers[0]?.id, "antigravity");
    // Pi lists a provider in /login when it can explain how to sign in. The
    // flow here delegates to agy rather than performing OAuth.
    const login = (providers[0] as { auth?: { apiKey?: { login?: unknown; resolve?: unknown } } })
      .auth?.apiKey?.login;
    assert.equal(typeof login, "function");
    assert.equal(typeof (providers[0] as { auth?: { apiKey?: { resolve?: unknown } } }).auth?.apiKey?.resolve, "function");
    // agy models is the only source of model ids: with nothing observed yet
    // and no cache, registration offers an empty picker rather than a builtin
    // list that can go stale.
    assert.deepEqual(providers[0].getModels(), []);

    // With a previously observed roster cached, a cold registration offers it,
    // so configured scopes such as `antigravity/<id>` resolve before discovery
    // runs. The cache holds only ids agy models returned.
    saveProviderCatalogCache([
      { full: "gemini-9-neon", id: "gemini-9-neon", efforts: ["low", "high"] },
    ]);
    const second: Provider[] = [];
    activate({
      registerCommand: () => {},
      registerTool: () => {},
      registerProvider: (provider: Provider) => second.push(provider),
      on() {},
    } as unknown as ExtensionAPI);
    assert.deepEqual(
      second[0].getModels().map((model) => model.id),
      ["gemini-9-neon"],
    );
  } finally {
    hooks.deregister();
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

it("keeps one background footer listener across session reloads", async () => {
  const { default: activate } = await import("../extensions/index.js");
  const { getBackgroundRunner } = await import("../extensions/tools.js");
  const runner = getBackgroundRunner();
  let live = 0;
  const subscribe = mock.method(runner, "subscribe", () => {
    live += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      live -= 1;
    };
  });
  try {
    const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
    activate({
      registerCommand: () => {},
      registerTool: () => {},
      registerProvider: () => {},
      on(name: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    } as unknown as ExtensionAPI);
    const ui = { setStatus: () => {}, notify: () => {} };
    const fire = async (name: string): Promise<void> => {
      for (const handler of handlers.get(name) ?? []) {
        await handler({}, { hasUI: true, ui, modelRegistry: { refresh: async () => ({ errors: new Map() }) } });
      }
    };

    await fire("session_start");
    assert.equal(live, 1, "a session attaches the footer listener");
    await fire("session_shutdown");
    assert.equal(live, 0, "shutdown detaches it so a reload cannot stack another");
    await fire("session_start");
    assert.equal(live, 1, "re-subscribing replaces instead of adding");
    await fire("session_shutdown");
    assert.equal(live, 0);
  } finally {
    subscribe.mock.restore();
  }
});
