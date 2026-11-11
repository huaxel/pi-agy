import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TObject } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { AGY_MODEL_ALIASES } from "../extensions/lib/cli.js";
import { registerAgyTools } from "../extensions/tools.js";

interface CapturedTool {
  name: string;
  parameters: TObject;
}

function captureTools(): CapturedTool[] {
  const tools: CapturedTool[] = [];
  registerAgyTools({
    registerTool: (tool: CapturedTool) => tools.push(tool),
  } as unknown as ExtensionAPI);
  return tools;
}

const expectedAliases = [
  "flash-low",
  "flash-medium",
  "flash-high",
  "pro-low",
  "pro-high",
  "sonnet",
  "opus",
  "gpt-oss",
];

describe("registered model schemas", () => {
  it("keeps the canonical alias inventory in its exact order", () => {
    assert.deepEqual(AGY_MODEL_ALIASES, expectedAliases);
  });

  for (const name of ["agy_execute", "agy_usage"]) {
    it(`${name} preserves aliases, metadata, and optional validation`, () => {
      const tool = captureTools().find((candidate) => candidate.name === name);
      assert.ok(tool, `missing tool: ${name}`);
      const model = tool.parameters.properties.model;
      assert.deepEqual(model.anyOf.map((literal: { const: string }) => literal.const), expectedAliases);
      assert.deepEqual(model.anyOf.map((literal: { const: string }) => literal.const), AGY_MODEL_ALIASES);
      assert.equal(model.description, name === "agy_execute"
        ? "Model alias. Defaults to 'flash-medium'."
        : "Optional model alias to place first in the report.");
      if (name === "agy_execute") {
        assert.equal(model.default, "flash-medium");
      } else {
        assert.equal(Object.hasOwn(model, "default"), false);
      }

      const required = name === "agy_execute" ? { prompt: "test" } : {};
      assert.equal(Value.Check(tool.parameters, required), true);
      for (const alias of expectedAliases) {
        assert.equal(Value.Check(tool.parameters, { ...required, model: alias }), true, alias);
      }
      for (const value of ["unknown", "", "FLASH-LOW", null, 1, {}]) {
        assert.equal(Value.Check(tool.parameters, { ...required, model: value }), false);
      }
    });
  }
});
