import { toSafeBridgeName, type BridgeToolDef } from "./provider-mcp.js";

/** Pi tool source shape (structural subset of Pi's ToolInfo). */
export interface ProviderToolSource {
  name: string;
  description?: string;
  parameters?: unknown;
}

/**
 * Tools that must never be bridged back into agy: self-delegation loops
 * burn quota and nest conversations, they are not capabilities agy lacks.
 */
const BRIDGE_EXCLUDED_TOOL_NAMES = new Set(["askantigravity"]);
const MAX_BRIDGED_TOOLS = 100;

function isBridgableToolName(name: string): boolean {
  const lowered = name.toLowerCase();
  if (lowered === "agy" || lowered.startsWith("agy_") || lowered.startsWith("agy-")) return false;
  return !BRIDGE_EXCLUDED_TOOL_NAMES.has(lowered);
}

function jsonClone(value: unknown): Record<string, unknown> | undefined {
  try {
    const cloned: unknown = JSON.parse(JSON.stringify(value));
    if (cloned && typeof cloned === "object" && !Array.isArray(cloned)) {
      return cloned as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Project Pi tools into bridge definitions: exclude self-delegation,
 * sanitize MCP names, drop unserializable schemas. First-seen wins on
 * collisions so output is deterministic.
 */
export function projectBridgeTools(sources: ProviderToolSource[]): BridgeToolDef[] {
  const defs: BridgeToolDef[] = [];
  const seenNames = new Set<string>();
  const seenPiNames = new Set<string>();
  for (const source of sources) {
    if (defs.length >= MAX_BRIDGED_TOOLS) break;
    if (typeof source.name !== "string" || !isBridgableToolName(source.name)) continue;
    if (seenPiNames.has(source.name)) continue;
    const name = toSafeBridgeName(source.name);
    if (seenNames.has(name)) continue;
    // MCP requires an object root; anything else degrades to no-arg form
    // instead of shipping a schema agy cannot validate against.
    const cloned = jsonClone(source.parameters);
    const inputSchema =
      cloned && (cloned as { type?: unknown }).type === "object" && typeof (cloned as { properties?: unknown }).properties === "object"
        ? (cloned as Record<string, unknown>)
        : { type: "object", properties: {} };
    seenPiNames.add(source.name);
    seenNames.add(name);
    defs.push({
      name,
      piName: source.name,
      description:
        typeof source.description === "string" && source.description.trim()
          ? source.description.trim().slice(0, 500)
          : `Pi tool ${source.name}`,
      inputSchema,
    });
  }
  return defs;
}

/** Fingerprint the bridged catalog: changes recycle the driver (fresh ListTools). */
export function bridgeToolsFingerprint(tools: BridgeToolDef[]): string {
  const canonical = JSON.stringify(
    tools.map((tool) => [tool.name, tool.piName, tool.description, tool.inputSchema]),
  );
  let hash = 5381;
  for (let i = 0; i < canonical.length; i++) {
    hash = ((hash << 5) + hash + canonical.charCodeAt(i)) | 0;
  }
  return `n${tools.length}-h${(hash >>> 0).toString(16)}`;
}
