import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  areProviderCatalogsEqual,
  FALLBACK_PROVIDER_MODELS,
  parseProviderCatalog,
  slugifyProviderId,
  thinkingMapForEfforts,
  toProviderEffort,
  toProviderModelDef,
} from "../extensions/lib/provider-models.js";

const LIVE_MODELS = [
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
  "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)",
  "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
  "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
].join("\n");

describe("provider catalog", () => {
  it("collapses multi-tier Gemini bases and keeps fixed families qualified", () => {
    const entries = parseProviderCatalog(LIVE_MODELS);
    const flash = entries.find((entry) => entry.id === "gemini-3-8-flash");
    assert.ok(flash);
    assert.equal(flash.full, "gemini-3.8-flash");
    assert.deepEqual(flash.efforts, ["low", "medium", "high"]);

    const pro = entries.find((entry) => entry.id === "gemini-3-1-pro");
    assert.ok(pro);
    assert.deepEqual(pro.efforts, ["low", "high"]);

    // Fixed-thinking families keep agy's exact slug and never take --effort.
    for (const id of ["claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"]) {
      const entry = entries.find((candidate) => candidate.id === id);
      assert.ok(entry, `missing ${id}`);
      assert.equal(entry?.efforts, undefined);
    }
  });

  it("ignores banners, progress chatter, and flag-like tokens", () => {
    const entries = parseProviderCatalog(
      ["Fetching available models...", "Available", "-high", "", "gemini-3.8-flash-high\tLabel"].join("\n"),
    );
    assert.deepEqual(entries.map((entry) => entry.full), ["gemini-3.8-flash-high"]);
  });

  it("deduplicates entries that slugify identically", () => {
    const entries = parseProviderCatalog("gemini-3.8-flash-high\tA\ngemini-3.8-flash-high\tB");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].full, "gemini-3.8-flash-high");
  });

  it("detects effort-tier changes as catalog changes", () => {
    const base = parseProviderCatalog(LIVE_MODELS);
    assert.ok(areProviderCatalogsEqual(base, parseProviderCatalog(LIVE_MODELS)));
    const changed = base.map((entry) => ({ ...entry }));
    const flash = changed.find((entry) => entry.id === "gemini-3-8-flash");
    assert.ok(flash?.efforts);
    flash!.efforts = ["low", "high"];
    assert.equal(areProviderCatalogsEqual(base, changed), false);
    assert.equal(areProviderCatalogsEqual(base, base.slice(0, -1)), false);
  });

  it("returns no entries for empty output so the fallback engages", () => {
    assert.deepEqual(parseProviderCatalog(""), []);
    assert.deepEqual(parseProviderCatalog("Fetching models…\n"), []);
    assert.ok(FALLBACK_PROVIDER_MODELS.length > 0);
  });

  it("slugifies display-shaped ids", () => {
    assert.equal(slugifyProviderId("gemini-3.8-flash"), "gemini-3-8-flash");
    assert.equal(slugifyProviderId("claude-opus-4-6-thinking"), "claude-opus-4-6-thinking");
  });

  it("clamps thinking levels to tiers the base accepts", () => {
    // Pro has no medium: medium clamps up to high.
    assert.equal(toProviderEffort("medium", ["low", "high"]), "high");
    assert.equal(toProviderEffort("low", ["low", "high"]), "low");
    assert.equal(toProviderEffort("max", ["low", "medium", "high"]), "high");
    assert.equal(toProviderEffort(undefined, ["low", "high"]), "low");
  });

  it("hides unsupported levels including off/minimal", () => {
    assert.deepEqual(thinkingMapForEfforts(["low", "high"]), {
      off: null,
      minimal: null,
      medium: null,
    });
    assert.deepEqual(thinkingMapForEfforts(["low", "medium", "high"]), {
      off: null,
      minimal: null,
    });
  });

  it("projects bridge tools with exclusions and safe names", async () => {
    const { projectBridgeTools, bridgeToolsFingerprint, collectParkedDeliveries } = await import(
      "../extensions/lib/provider.js"
    );
    const defs = projectBridgeTools([
      { name: "read", description: "Read", parameters: { type: "object" } },
      { name: "agy_execute", description: "No recursion", parameters: { type: "object" } },
      { name: "AskAntigravity", description: "No recursion", parameters: { type: "object" } },
      { name: "weird name!", description: "", parameters: { type: "object" } },
      { name: "read", description: "Duplicate", parameters: { type: "object" } },
      { name: "broken", parameters: Object.create(null) },
    ]);
    const names = defs.map((def) => def.name);
    assert.ok(names.includes("read"));
    assert.ok(!names.includes("agy_execute"));
    assert.ok(!names.includes("AskAntigravity"));
    assert.ok(names.includes("weird_name"));
    assert.equal(names.filter((name) => name === "read").length, 1);
    const print = bridgeToolsFingerprint(defs);
    assert.ok(print.length > 0);
    assert.equal(bridgeToolsFingerprint(defs), print);
    assert.notEqual(
      bridgeToolsFingerprint([...defs, { name: "x", piName: "x", description: "", inputSchema: {} }]),
      print,
    );
    const deliveries = collectParkedDeliveries(
      [
        { role: "user", content: "hi" },
        { role: "toolResult", toolCallId: "a", toolName: "read", content: "text", isError: false },
        { role: "toolResult", toolCallId: "b", toolName: "read", content: "other", isError: true },
      ],
      "a",
    );
    assert.deepEqual(deliveries, [{ text: "text", isError: false }]);
  });

  it("projects defs with the custom API sentinel and zero cost", () => {
    const def = toProviderModelDef({ full: "gemini-3.8-flash", id: "gemini-3-8-flash", efforts: ["low", "medium", "high"] });
    assert.equal(def.api, "agy-provider");
    assert.equal(def.reasoning, true);
    assert.deepEqual(def.input, ["text", "image"]);
    assert.equal(def.contextWindow, 1_000_000);

    const fixed = toProviderModelDef({ full: "claude-sonnet-4-6", id: "claude-sonnet-4-6" });
    assert.equal(fixed.reasoning, false);
    assert.equal(fixed.thinkingLevelMap, undefined);
  });
});
