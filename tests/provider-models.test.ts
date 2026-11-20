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
  it("accepts nonhyphen model ids and preserves exact values without effort", () => {
    for (const [full, id] of [["argon", "argon"], ["r2", "r2"], ["123", "123"], ["model_v2", "model-v2"], ["model.v2", "model-v2"]]) {
      for (const row of [full, `${full}\tDisplay Label`, `${full}  Display Label`, `${full} Display Label`]) {
        const entries = parseProviderCatalog(row);
        assert.deepEqual(entries, [{ full, id }], row);
        assert.equal(toProviderModelDef(entries[0]).reasoning, false);
        assert.equal(toProviderModelDef(entries[0]).thinkingLevelMap, undefined);
      }
    }
    assert.deepEqual(parseProviderCatalog("argon\tArgon"), [{ full: "argon", id: "argon" }]);
    assert.deepEqual(parseProviderCatalog("argon Argon"), [{ full: "argon", id: "argon" }]);
  });

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
      [
        "Fetching available models...", "Available", "-high", "Fetching models…", "",
        "Argon", "Argon Model", "fetching available models", "authentication required",
        "error: authentication required", "unauthorized", "error", "authentication",
        "model\tname", "id  label", "MODEL\tNAME", "models", "name", "status",
        "gemini-3.8-flash-high\tLabel",
      ].join("\n"),
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

  it("returns no entries for empty output and ships no builtin catalog", () => {
    assert.deepEqual(parseProviderCatalog(""), []);
    assert.deepEqual(parseProviderCatalog("Fetching models…\n"), []);
    // agy models is the only source of model names; a builtin list would offer
    // ids the installed CLI may no longer serve.
    assert.deepEqual(FALLBACK_PROVIDER_MODELS, []);
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
      xhigh: null,
      max: null,
    });
    assert.deepEqual(thinkingMapForEfforts(["low", "medium", "high"]), {
      off: null,
      minimal: null,
      xhigh: null,
      max: null,
    });
    // xhigh is a real stop on the Neon/Hydrogen families, so it must stay
    // visible there instead of collapsing onto high.
    assert.deepEqual(thinkingMapForEfforts(["low", "medium", "high", "xhigh"]), {
      off: null,
      minimal: null,
      max: null,
    });
  });

  it("folds an xhigh sibling into its family instead of a separate entry", () => {
    const entries = parseProviderCatalog(
      [
        "gemini-9-neon-high\tNeon (High)",
        "gemini-9-neon-xhigh\tNeon (XHigh)",
        "gemini-9-neon-medium\tNeon (Medium)",
        "gemini-9-neon-low\tNeon (Low)",
      ].join("\n"),
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].full, "gemini-9-neon");
    assert.deepEqual(entries[0].efforts, ["low", "medium", "high", "xhigh"]);
  });

  it("keeps a single-tier family qualified so --effort is never attached", () => {
    // agy: `--model gpt-oss-120b-medium --effort high` is a conflict.
    const entries = parseProviderCatalog("gpt-oss-9-9-medium\tGPT-OSS 9.9 (Medium)");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].full, "gpt-oss-9-9-medium");
    assert.equal(entries[0].efforts, undefined);
  });

  it("normalizes root schema composition instead of discarding arguments", async () => {
    const { projectBridgeTools } = await import("../extensions/lib/provider.js");
    const schemaOf = (parameters: unknown) =>
      projectBridgeTools([{ name: "probe", parameters }])[0].inputSchema;

    // A nullable wrapper is unambiguous: keep the real object branch.
    assert.deepEqual(
      schemaOf({ oneOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { type: "null" }] }),
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
    );
    assert.deepEqual(schemaOf({ anyOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "null" }] }), {
      type: "object",
      properties: { a: { type: "string" } },
    });
    // allOf of objects merges into one object schema.
    assert.deepEqual(
      schemaOf({
        allOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
        ],
      }),
      { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a", "b"] },
    );
    // A genuinely ambiguous root keeps its branches: emptying it would tell the
    // model the tool takes no arguments and make every call fail.
    const ambiguous = { oneOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { b: { type: "number" } } }] };
    assert.deepEqual(schemaOf(ambiguous), ambiguous);
    // Nested composition is a valid object root and is left untouched.
    const nested = { type: "object", properties: { x: { oneOf: [{ type: "string" }, { type: "null" }] } } };
    assert.deepEqual(schemaOf(nested), nested);
    // Non-object values still degrade to the safe no-arg form.
    assert.deepEqual(schemaOf("not-a-schema"), { type: "object", properties: {} });
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
