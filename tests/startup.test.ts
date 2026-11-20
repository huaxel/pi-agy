import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";

it("registers the Antigravity provider, command and tools without loading the bridge", async () => {
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
    // agy models is the only source of model ids, so registration offers an
    // empty picker rather than a builtin list that can go stale.
    assert.deepEqual(providers[0].getModels(), []);
  } finally {
    hooks.deregister();
  }
});
