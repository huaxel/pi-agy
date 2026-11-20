import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { it } from "node:test";
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
