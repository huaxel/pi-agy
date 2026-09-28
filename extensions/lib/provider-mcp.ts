/**
 * Localhost MCP bridge: exposes Pi-side read-only context to agy turns.
 *
 * agy reads `.agents/mcp_config.json` from its `--add-dir` directories, so
 * the provider passes a bridge-controlled dir as an extra `--add-dir` — the
 * user's global agy config is never touched. Each Pi process owns one
 * config dir (`pi-agy-bridge-<pid>`); stale dirs from crashed sessions are
 * swept on start.
 *
 * Phase 1 tools are all read-only and served synchronously (no Pi-turn
 * round-trip needed): recorded sessions, quota report, model catalog. They
 * let an agy agent inspect Pi-side state itself instead of guessing.
 * Mutating Pi-tool bridging (park + shadow toolUse + approval gates) builds
 * on this transport later.
 *
 * Hardening: 127.0.0.1 only, per-process shared-secret header (blocks
 * browser CSRF — a simple cross-origin POST cannot set a custom header),
 * 1 MiB body cap, atomic config writes with restrictive modes, and a
 * request handler that degrades to error results instead of ever crashing
 * Pi. Startup never throws: failure returns `undefined` and turns proceed
 * without `--add-dir`.
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { getDefaultConfigPath } from "./config.js";
import { checkAgyUsage, formatAgyUsage } from "./cli.js";
import {
  FALLBACK_PROVIDER_MODELS,
  parseProviderCatalog,
  type AgyProviderModelEntry,
} from "./provider-models.js";
import { getHistory } from "./sessions.js";
import { runPreflightCommand } from "./spawn.js";

export const BRIDGE_MCP_KEY = "pi-agy-tools";
/** Built-in read-only tools (sessions, quota, catalog), plus dynamic bridged Pi tools. */
const BUILTIN_TOOL_COUNT = 3;
export const BRIDGE_TOKEN_HEADER = "x-pi-agy-token";
const BRIDGE_MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 1024 * 1024;
const CATALOG_TTL_MS = 5 * 60_000;
const HISTORY_LIMIT = 10;

function agentDir(): string {
  // Mirror getDefaultConfigPath(): $PI_CODING_AGENT_DIR/agy-config.json.
  return path.dirname(getDefaultConfigPath());
}

function bridgeBaseDir(): string {
  return path.join(agentDir(), "pi-agy-bridge");
}

let bridgeSequence = 0;

/**
 * Unique config dir per bridge instance. Per-pid alone collides: one Pi
 * process serves many workspace dirs, and the second bridge would overwrite
 * the first bridge's port/token (and stop() would delete both).
 */
function allocateBridgeConfigDir(): string {
  bridgeSequence += 1;
  return path.join(bridgeBaseDir(), `bridge-${process.pid}-${bridgeSequence}`);
}

function bridgeConfigPath(configDir: string): string {
  return path.join(configDir, ".agents", "mcp_config.json");
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive but not ours to signal. ESRCH: no such process.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Best-effort sweep of config dirs left by crashed sessions. */
async function sweepStaleBridgeDirs(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(bridgeBaseDir());
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith("bridge-")) continue;
    // bridge-<pid>[-<seq>]: only the leading segment is the owner pid.
    // pid 0 is never a real owner (kill(0) tests the process group).
    const pid = Number(name.slice("bridge-".length).split("-", 1)[0]);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (isPidAlive(pid)) continue;
    try {
      await rm(path.join(bridgeBaseDir(), name), { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
}

async function writeBridgeConfig(configDir: string, port: number, token: string): Promise<void> {
  const configPath = bridgeConfigPath(configDir);
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const config = {
    mcpServers: {
      [BRIDGE_MCP_KEY]: {
        serverUrl: `http://127.0.0.1:${port}${BRIDGE_MCP_PATH}`,
        headers: { [BRIDGE_TOKEN_HEADER]: token },
      },
    },
  };
  // Unique dir per bridge instance: no tmp-name contention, and `wx` fails
  // closed instead of following a planted symlink.
  const tmp = `${configPath}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await chmod(tmp, 0o600);
    await rename(tmp, configPath);
  } catch (error) {
    try {
      await rm(tmp, { force: true });
    } catch {
      // Best effort.
    }
    throw error;
  }
}

function toolText(text: string, isError = false): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  return isError ? { content: [{ type: "text", text }], isError } : { content: [{ type: "text", text }] };
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export interface McpBridgeHandle {
  /** Directory to pass as extra agy `--add-dir`. */
  configDir: string;
  /** Local server URL (debugging only; agy reads it from the config file). */
  url: string;
  stop: () => Promise<void>;
  /** Replace the bridged Pi-tool catalog (refreshed per turn). */
  setTools: (tools: BridgeToolDef[]) => void;
  /** Parked-call handler: return true to hold the MCP response open. */
  setParkHandler: (handler: BridgeParkHandler | undefined) => void;
  /** Deliver a Pi tool result to a parked call. False when unknown. */
  completePark: (callId: string, result: BridgeToolResult) => boolean;
  /** Fail every parked call (teardown, cancelled turns). */
  failAllParks: (message: string) => void;
  /** Point-in-time description for status surfaces. */
  describe: () => { configDir: string; url: string; toolCount: number };
}

/** A Pi tool projected for agy: MCP-safe advertised name, real Pi identity. */
export interface BridgeToolDef {
  /** MCP-safe name as advertised to agy. */
  name: string;
  /** Real Pi tool name (invoked via shadow toolUse). */
  piName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface BridgePark {
  callId: string;
  /** Real Pi tool name. */
  toolName: string;
  args: Record<string, unknown>;
}

export interface BridgeToolResult {
  text: string;
  isError: boolean;
}

export type BridgeParkHandler = (park: BridgePark) => boolean;

/** MCP tool names: [a-zA-Z0-9_-]{1,64}. Pi names are sanitized into that. */
export function toSafeBridgeName(name: string): string {
  const safe = name
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return safe || "tool";
}

interface CatalogCache {
  raw: string;
  at: number;
}

/**
 * Start the bridge for a workspace directory. Never throws: any failure
 * cleans up and resolves `undefined` so provider turns proceed plain.
 */
export async function startMcpBridge(dir: string): Promise<McpBridgeHandle | undefined> {
  const token = randomBytes(32).toString("hex");
  let catalogCache: CatalogCache | undefined;

  const mcp = new McpServer(
    { name: "pi-agy-bridge", version: "1" },
    { capabilities: { tools: {} } },
  );

  let bridgedTools: BridgeToolDef[] = [];
  let parkHandler: BridgeParkHandler | undefined;
  const parks = new Map<string, (result: BridgeToolResult) => void>();

  mcp.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      ...bridgedTools.map((tool) => ({
        name: tool.name,
        description: `${tool.description} (Pi tool: runs with Pi permissions and review.)`,
        inputSchema: tool.inputSchema,
      })),
      {
        name: "agy_sessions_list",
        description:
          "List recorded agy conversations for a directory (ids, models, ages, summaries) to find a conversation to resume. Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            dir: { type: "string", description: "Directory to list. Defaults to the current workspace." },
            limit: { type: "number", description: "Maximum entries (default 10, max 10)." },
          },
        },
      },
      {
        name: "agy_quota_report",
        description:
          "Read current Antigravity model quotas and reset times without spending a model turn. Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            model: { type: "string", description: "Optional agy model slug to focus the report." },
          },
        },
      },
      {
        name: "agy_model_catalog",
        description:
          "List agy models available to this workspace as Pi picker entries (id, agy --model value, effort tiers). Read-only.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      if (name === "agy_sessions_list") {
        // Constrain overrides to the bound workspace: session summaries
        // must not wander across directories on an agent's say-so.
        const requested = path.resolve(stringArg(args.dir) ?? dir);
        const root = path.resolve(dir);
        if (requested !== root && !requested.startsWith(root + path.sep)) {
          return toolText(`Access denied: sessions outside the workspace (${dir}) are not visible.`, true);
        }
        const target = requested;
        const limit = Math.min(Math.max(Math.floor(Number(args.limit) || HISTORY_LIMIT), 1), HISTORY_LIMIT);
        const history = (await getHistory(target)).slice(0, limit);
        if (history.length === 0) return toolText(`No agy conversations recorded for ${target} yet.`);
        const lines = history.map(
          (entry) =>
            `- ${entry.conversation_id} · ${entry.model ?? "unknown model"}${entry.agent ? ` · agent ${entry.agent}` : ""} · ${entry.updated_at}${entry.summary ? ` · ${entry.summary}` : ""}`,
        );
        return toolText(`agy conversations for ${target} (most recent first):\n${lines.join("\n")}`);
      }
      if (name === "agy_quota_report") {
        const model = stringArg(args.model);
        const quota = await checkAgyUsage(dir, undefined);
        const report = formatAgyUsage(quota, model) ?? "agy quota information is unavailable";
        return toolText(report);
      }
      if (name === "agy_model_catalog") {
        const entries = await readCatalog(dir, catalogCache);
        catalogCache = entries.cache;
        const lines = entries.models.map(
          (entry) =>
            `- ${entry.id} (--model ${entry.full}${entry.efforts ? `; effort: ${entry.efforts.join("/")}` : "; fixed thinking"})`,
        );
        return toolText(
          `agy models${entries.fallback ? " (fallback catalog — live discovery unavailable)" : ""}:\n${lines.join("\n")}`,
        );
      }
      const bridged = bridgedTools.find((tool) => tool.name === name);
      if (bridged) {
        const callArgs =
          args && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {};
        const callId = randomUUID();
        const handler = parkHandler;
        if (!handler) {
          return toolText("Pi tool bridge is not awaiting calls right now; retry shortly.", true);
        }
        const parked = await new Promise<BridgeToolResult | undefined>((resolve) => {
          parks.set(callId, resolve);
          let accepted = false;
          try {
            accepted = handler({ callId, toolName: bridged.piName, args: callArgs });
          } catch {
            accepted = false;
          }
          if (!accepted) {
            parks.delete(callId);
            resolve(undefined);
          }
        });
        if (!parked) {
          return toolText("Pi turn is not awaiting tool calls; the call was not executed.", true);
        }
        return {
          content: [{ type: "text" as const, text: parked.text }],
          ...(parked.isError ? { isError: true as const } : {}),
        };
      }
      return toolText(`Unknown tool: ${name}`, true);
    } catch (error) {
      // Tool failures degrade to error results; the transport stays up.
      return toolText(
        `Bridge tool failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  });

  // Stateful: one transport serves many agy sessions, routed by the
  // session id header. The default (no generator) is stateless and rejects
  // any second request on the same transport.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  const configDir = allocateBridgeConfigDir();
  // Filled after bind; the request handler validates Host against it
  // (defense-in-depth against DNS rebinding past the loopback bind).
  const bound = { port: 0 };
  const http = createServer((req, res) => {
    void handleBridgeRequest(req, res, transport, token, bound.port).catch(() => {
      // handleBridgeRequest guards every response path; this is unreachable
      // belt-and-braces so a client error can never crash Pi.
      if (!res.headersSent) {
        try {
          res.writeHead(500).end();
        } catch {
          // Ignore.
        }
      }
    });
  });

  // A server with zero error listeners throws uncaught on socket-level
  // failures and kills Pi; per-request paths already settle themselves.
  http.on("error", () => {
    // Never crash the host on loopback transport noise.
  });
  http.on("clientError", (_error, socket) => {
    try {
      socket.destroy();
    } catch {
      // Ignore.
    }
  });

  const failAllParks = (message: string): void => {
    if (parks.size === 0) return;
    const pending = [...parks.values()];
    parks.clear();
    for (const resolve of pending) {
      try {
        resolve({ text: message, isError: true });
      } catch {
        // Ignore settle races.
      }
    }
  };

  const completePark = (callId: string, result: BridgeToolResult): boolean => {
    const resolve = parks.get(callId);
    if (!resolve) return false;
    parks.delete(callId);
    try {
      resolve(result);
    } catch {
      // Ignore settle races.
    }
    return true;
  };

  const stop = async (): Promise<void> => {
    failAllParks("Pi tool bridge stopped.");
    try {
      await transport.close();
    } catch {
      // Best effort.
    }
    try {
      await mcp.close();
    } catch {
      // Best effort.
    }
    // close() alone waits out keep-alive/SSE sockets; destroy them and
    // bound the wait so session shutdown can never hang on a lingerer.
    try {
      http.closeAllConnections?.();
    } catch {
      // Best effort (older Node typings).
    }
    await Promise.race([
      new Promise<void>((resolve) => http.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);
    try {
      await rm(configDir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  };

  try {
    await sweepStaleBridgeDirs();
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(0, "127.0.0.1", () => {
        http.off("error", reject);
        resolve();
      });
    });
    const address = http.address();
    const port = typeof address === "object" && address ? address.port : 0;
    if (!port) throw new Error("bridge bound no port");
    await mcp.connect(transport);
    await writeBridgeConfig(configDir, port, token);
    bound.port = port;
    return {
      configDir,
      url: `http://127.0.0.1:${port}${BRIDGE_MCP_PATH}`,
      stop,
      describe: () => ({
        configDir,
        url: `http://127.0.0.1:${port}${BRIDGE_MCP_PATH}`,
        toolCount: bridgedTools.length + BUILTIN_TOOL_COUNT,
      }),
      setTools: (tools: BridgeToolDef[]) => {
        bridgedTools = tools;
      },
      setParkHandler: (handler: BridgeParkHandler | undefined) => {
        parkHandler = handler;
      },
      completePark,
      failAllParks,
    };
  } catch {
    try {
      await stop();
    } catch {
      // Best effort.
    }
    return undefined;
  }
}

async function readCatalog(
  dir: string,
  cache: CatalogCache | undefined,
): Promise<{ models: AgyProviderModelEntry[]; fallback: boolean; cache: CatalogCache | undefined }> {
  if (cache && Date.now() - cache.at < CATALOG_TTL_MS) {
    const models = parseProviderCatalog(cache.raw);
    if (models.length > 0) return { models, fallback: false, cache };
  }
  try {
    const raw = await runPreflightCommand(["models"], dir, undefined, "agy bridge model catalog", true);
    const models = parseProviderCatalog(raw);
    if (models.length > 0) return { models, fallback: false, cache: { raw, at: Date.now() } };
  } catch {
    // Fall through to the fallback catalog.
  }
  return { models: [...FALLBACK_PROVIDER_MODELS], fallback: true, cache };
}

async function readBody(req: IncomingMessage): Promise<{ body?: unknown; tooLarge: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return { body: undefined, tooLarge: true };
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return { body: undefined, tooLarge: false };
  try {
    return { body: JSON.parse(text), tooLarge: false };
  } catch {
    return { body: undefined, tooLarge: false };
  }
}

async function handleBridgeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transport: StreamableHTTPServerTransport,
  token: string,
  port: number,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== BRIDGE_MCP_PATH) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      res.writeHead(405).end();
      return;
    }
    // Shared secret: exact match only (duplicated headers parse as arrays
    // and never equal the token). Compared in constant time.
    const presented = req.headers[BRIDGE_TOKEN_HEADER];
    const expected = Buffer.from(token);
    const actual = typeof presented === "string" ? Buffer.from(presented) : undefined;
    if (!actual || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.writeHead(403).end();
      return;
    }
    // Defense-in-depth against DNS rebinding past the loopback bind.
    const host = req.headers.host ?? "";
    if (port > 0 && host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === "POST") {
      const { body, tooLarge } = await readBody(req);
      if (tooLarge) {
        try {
          req.destroy();
        } catch {
          // Ignore.
        }
        try {
          res.writeHead(413, { Connection: "close" }).end();
        } catch {
          // Socket already gone.
        }
        return;
      }
      if (body === undefined) {
        res.writeHead(400).end();
        return;
      }
      await transport.handleRequest(req, res, body);
      return;
    }
    await transport.handleRequest(req, res);
  } catch {
    if (!res.headersSent) {
      try {
        res.writeHead(500).end();
      } catch {
        // Ignore.
      }
    }
  }
}
