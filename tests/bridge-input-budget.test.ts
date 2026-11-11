import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isBridgeInputWithinBudget,
  MAX_BRIDGE_INPUT_DEPTH,
  MAX_BRIDGE_INPUT_ELEMENTS,
} from "../extensions/lib/bridge-input-budget.js";

function chain(depth: number, kind: "array" | "object" | "mixed"): unknown {
  let value: unknown = null;
  for (let i = 0; i < depth; i++) {
    value = kind === "array" || (kind === "mixed" && i % 2 === 0) ? [value] : { child: value };
  }
  return value;
}

// Independent, intentionally recursive reference: only small generated trees,
// never production request trees. Each child contributes one property/slot.
function reference(value: unknown): { elements: number; depth: number; nodes: number } {
  if (value === null || typeof value !== "object") return { elements: 0, depth: 0, nodes: 1 };
  const children = Object.values(value).map(reference);
  return {
    elements: children.length + children.reduce((sum, child) => sum + child.elements, 0),
    depth: 1 + Math.max(0, ...children.map((child) => child.depth)),
    nodes: 1 + children.reduce((sum, child) => sum + child.nodes, 0),
  };
}

describe("bridge input budget", () => {
  it("keeps the approved fixed policy", () => {
    assert.equal(MAX_BRIDGE_INPUT_ELEMENTS, 10_000);
    assert.equal(MAX_BRIDGE_INPUT_DEPTH, 64);
  });

  it("does not count scalar content as structure", () => {
    for (const value of [null, true, false, 0, -1, "", "€".repeat(180_000), [], {}]) {
      assert.equal(isBridgeInputWithinBudget(value), true);
    }
  });

  it("bounds array slots at exactly 10000", () => {
    const value = Array(10_000).fill(null);
    assert.equal(isBridgeInputWithinBudget(value), true);
    value.push(null);
    assert.equal(isBridgeInputWithinBudget(value), false);
  });

  it("bounds own object properties at exactly 10000", () => {
    const value: Record<string, unknown> = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [String(i), null]));
    assert.equal(isBridgeInputWithinBudget(value), true);
    value.extra = null;
    assert.equal(isBridgeInputWithinBudget(value), false);
  });

  it("shares one budget across nested containers and wrapper properties", () => {
    const left = Array(4999).fill(null);
    const right = Array(4999).fill(null);
    const value = { left, right }; // 2 properties + 9998 array slots
    assert.equal(isBridgeInputWithinBudget(value), true);
    right.push(null);
    assert.equal(isBridgeInputWithinBudget(value), false);
  });

  it("counts empty containers toward depth but not as extra elements", () => {
    for (const kind of ["array", "object", "mixed"] as const) {
      assert.equal(isBridgeInputWithinBudget(chain(64, kind)), true, kind);
      assert.equal(isBridgeInputWithinBudget(chain(65, kind)), false, kind);
    }
    let value: unknown = {};
    for (let i = 1; i < 64; i++) value = [value];
    assert.equal(isBridgeInputWithinBudget(value), true);
    assert.equal(isBridgeInputWithinBudget([value]), false);
  });

  it("counts prototype-like and Unicode own keys from parsed JSON", () => {
    const value = JSON.parse('{"__proto__":null,"constructor":null,"toString":null,"hasOwnProperty":null,"":null,"2":null,"é":null}') as Record<string, unknown>;
    const padding = Array(9992).fill(null);
    value.padding = padding; // 8 own keys + 9992 slots
    assert.equal(isBridgeInputWithinBudget(value), true);
    padding.push(null);
    assert.equal(isBridgeInputWithinBudget(value), false);
  });

  it("agrees with a bounded mixed-tree oracle at both policy frontiers", () => {
    const leaves = [null, 7, "✓", {}, []];
    let cases = 0;
    for (const kind of ["array", "object", "mixed"] as const) {
      for (let width = 0; width <= 3; width++) {
        for (let depth = 0; depth <= 7; depth++) {
          for (const [leafIndex, leaf] of leaves.entries()) {
            let shape: unknown = leaf;
            for (let i = 0; i < depth; i++) {
              const children = [shape, ...Array(width).fill(leaf)];
              shape = kind === "array" || (kind === "mixed" && i % 2 === 0)
                ? children
                : Object.fromEntries(children.map((child, j) => [`key${j}`, child]));
            }
            const stats = reference(shape);
            const label = `${kind}/width=${width}/depth=${depth}/leaf=${leafIndex}`;
            assert.ok(stats.depth <= 8 && stats.nodes <= 100, `generator domain: ${label}`);
            const padding = Array(10_000 - 2 - stats.elements).fill(null);
            const boundary = { shape, padding };
            assert.equal(isBridgeInputWithinBudget(boundary), true, `element boundary: ${label}`);
            padding.push(null);
            assert.equal(isBridgeInputWithinBudget(boundary), false, `element overflow: ${label}`);
            let deep = shape;
            for (let i = stats.depth; i < 64; i++) deep = [deep];
            assert.equal(isBridgeInputWithinBudget(deep), true, `depth boundary: ${label}`);
            assert.equal(isBridgeInputWithinBudget([deep]), false, `depth overflow: ${label}`);
            cases++;
          }
        }
      }
    }
    assert.equal(cases, 480);
  });
});
