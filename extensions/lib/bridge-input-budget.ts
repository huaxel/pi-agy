/** Limits for the complete parsed bridge request, including JSON-RPC metadata. */
export const MAX_BRIDGE_INPUT_ELEMENTS = 10_000;
export const MAX_BRIDGE_INPUT_DEPTH = 64;

/**
 * Bounds structure before SDK validation. Input must come from JSON.parse:
 * this is not schema validation or a walker for arbitrary JS accessors/proxies.
 * Count object properties and array slots; only containers contribute depth.
 * The root container has depth 1. Strings remain subject to the byte reader.
 */
export function isBridgeInputWithinBudget(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  const pending: Array<{ node: object; depth: number }> = [{ node: value, depth: 1 }];
  let elements = 0;
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    const array = Array.isArray(node);
    if (array) {
      // Refuse wide arrays before reading or queuing any of their children.
      elements += node.length;
      if (elements > MAX_BRIDGE_INPUT_ELEMENTS) return false;
    }
    // Do not allocate Object.entries/values or flatten all descendants.
    for (const key in node) {
      if (!Object.hasOwn(node, key)) continue;
      if (!array && ++elements > MAX_BRIDGE_INPUT_ELEMENTS) return false;
      const child = (node as Record<string, unknown>)[key];
      if (child !== null && typeof child === "object") {
        if (depth >= MAX_BRIDGE_INPUT_DEPTH) return false;
        // Every queued child is charged to an already-counted property/slot:
        // the worklist cannot exceed the finite element budget.
        pending.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return true;
}
