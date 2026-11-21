/** A Pi tool projected for agy: MCP-safe advertised name, real Pi identity. */
export interface BridgeToolDef {
  name: string;
  piName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP tool names: [a-zA-Z0-9_-]{1,64}. Pi names are sanitized into that. */
function toSafeBridgeName(name: string): string {
  const safe = name
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return safe || "tool";
}

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

const EMPTY_INPUT_SCHEMA = { type: "object", properties: {} } as const;

function isObjectSchema(value: Record<string, unknown>): boolean {
  return value.type === "object" && typeof value.properties === "object" && value.properties !== null;
}

/**
 * Normalize a Pi tool schema for MCP `inputSchema`, which must be an object.
 *
 * Root-level composition used to be discarded wholesale, which told the model a
 * tool took no arguments at all and made every call fail. Only the unambiguous
 * wrappers are unwrapped:
 *
 * - `oneOf`/`anyOf` with a single non-null branch → that branch;
 * - `allOf` of object schemas → merged properties and required lists.
 *
 * Anything else is passed through unchanged rather than replaced with an empty
 * schema: a genuinely ambiguous root (`oneOf` of two different objects) still
 * carries real information for the model, whereas `{properties: {}}` actively
 * misleads it. Only a non-object value becomes the empty form.
 */
export function normalizeBridgeInputSchema(value: unknown): Record<string, unknown> {
  const cloned = jsonClone(value);
  if (!cloned) return { ...EMPTY_INPUT_SCHEMA };
  const normalized = unwrapRootComposition(cloned, 0);
  return normalized ?? cloned;
}

function unwrapRootComposition(
  schema: Record<string, unknown>,
  depth: number,
): Record<string, unknown> | undefined {
  if (depth > 8) return undefined;
  if (isObjectSchema(schema)) return schema;
  const merge = (branches: unknown[]): Record<string, unknown> | undefined => {
    const properties: Record<string, unknown> = {};
    const required = new Set<string>();
    for (const branch of branches) {
      const record = jsonClone(branch);
      if (!record || !isObjectSchema(record)) return undefined;
      // Flatten only where it is provably equivalent. `type`, `properties` and
      // `required` are the keywords this merge carries over; a branch that also
      // states `additionalProperties`, `dependentRequired`, `patternProperties`
      // or anything else would have that constraint silently dropped, which
      // advertises arguments the real Pi tool rejects.
      for (const key of Object.keys(record)) {
        if (key !== "type" && key !== "properties" && key !== "required") return undefined;
      }
      // Two branches constraining one property are a conjunction, not a
      // last-one-wins assignment.
      for (const key of Object.keys(record.properties as Record<string, unknown>)) {
        if (Object.hasOwn(properties, key)) return undefined;
      }
      Object.assign(properties, record.properties as Record<string, unknown>);
      if (Array.isArray(record.required)) {
        for (const key of record.required) if (typeof key === "string") required.add(key);
      }
    }
    return {
      type: "object",
      properties,
      ...(required.size > 0 ? { required: [...required] } : {}),
    };
  };
  if (Array.isArray(schema.allOf)) {
    const merged = merge(schema.allOf);
    if (merged) return merged;
  }
  for (const key of ["oneOf", "anyOf"] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    // A nullable variant is the common case: one real object plus `null`.
    const concrete = branches.filter((branch) => {
      const record = jsonClone(branch);
      return !(record && record.type === "null");
    });
    if (concrete.length !== 1) continue;
    const only = jsonClone(concrete[0]);
    if (!only) continue;
    const unwrapped = unwrapRootComposition(only, depth + 1);
    if (unwrapped) return unwrapped;
  }
  return undefined;
}

/**
 * Project Pi tools into bridge definitions: exclude self-delegation,
 * sanitize MCP names, drop unserializable schemas. First-seen wins on
 * collisions so output is deterministic.
 */
/**
 * Names the bridge answers itself (sessions, quota, catalog, activate_skill,
 * bridge_poll_result). A projected Pi tool must never take one: `tools/list`
 * would advertise the Pi tool while dispatch routes the name to the built-in
 * first, leaving the advertised tool unreachable. Declared here rather than in
 * provider-mcp.ts so projection does not pull the MCP SDK onto the extension
 * startup path; `provider-mcp.test.ts` asserts the advertised built-ins are
 * exactly this set.
 */
export const BUILTIN_BRIDGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "agy_sessions_list",
  "agy_quota_report",
  "agy_model_catalog",
  "activate_skill",
  "bridge_poll_result",
]);

export function projectBridgeTools(
  sources: ProviderToolSource[],
  options?: {
    /**
     * Names owned by the bridge's own tools. A Pi tool that sanitizes onto one
     * of them is advertised under a distinct name instead of shadowing the
     * built-in — the built-ins win dispatch, so the Pi tool would otherwise be
     * listed and unreachable.
     */
    reserved?: ReadonlySet<string>;
  },
): BridgeToolDef[] {
  const defs: BridgeToolDef[] = [];
  const reserved = options?.reserved ?? new Set<string>();
  const seenNames = new Set<string>();
  const seenPiNames = new Set<string>();
  for (const source of sources) {
    if (defs.length >= MAX_BRIDGED_TOOLS) break;
    if (typeof source.name !== "string" || !isBridgableToolName(source.name)) continue;
    if (seenPiNames.has(source.name)) continue;
    const safe = toSafeBridgeName(source.name);
    if (seenNames.has(safe)) continue;
    const name = reserved.has(safe) ? freeReservedName(safe, seenNames, reserved) : safe;
    const inputSchema = normalizeBridgeInputSchema(source.parameters);
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
/** First `name_pi`, `name_pi2`, … that neither the bridge nor a prior tool owns. */
function freeReservedName(
  base: string,
  seenNames: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
): string {
  const taken = (candidate: string) => seenNames.has(candidate) || reserved.has(candidate);
  let candidate = `${base}_pi`;
  let suffix = 2;
  while (taken(candidate)) candidate = `${base}_pi${suffix++}`;
  return candidate;
}

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
