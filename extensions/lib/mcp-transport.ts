/**
 * Minimal MCP server over Streamable HTTP — the slice this bridge needs.
 *
 * The official SDK is one runtime dependency that declares seventeen of its
 * own (express *and* hono, ajv, jose, cors, eventsource, express-rate-limit,
 * pkce-challenge), which is 94 production packages and the source of every
 * advisory this package has ever carried. What the bridge actually uses is a
 * server object, a transport, and two request schemas. This file is that
 * slice: JSON-RPC 2.0 dispatch, the initialize handshake, `tools/list`,
 * `tools/call`, `ping`, session ids, and the two response framings.
 *
 * Deliberately out of scope, because nothing in this bridge uses them: server
 * initiated notifications or sampling, resource and prompt capabilities, SSE
 * stream resumption (`Last-Event-ID`), OAuth, and batch requests (removed from
 * the spec in 2025-06-18; a batch is answered per element anyway).
 *
 * The transport contract is the one `provider-mcp.ts` already depends on:
 * `sessionId`, `onclose`, `handleRequest(req, res, preParsedBody?)`, `close()`.
 * Compatibility is not assumed — the bridge's own tests drive this server with
 * the real SDK *client*, which stays a dev dependency precisely so the
 * acceptance criteria stay honest.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** Protocol revisions this server can answer. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"] as const;
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1]!;

export const SESSION_HEADER = "mcp-session-id";

/** JSON-RPC 2.0 error codes used here. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export interface JsonRpcId {
  id: string | number | null;
}

export interface JsonRpcRequest extends JsonRpcId {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CallToolRequest extends JsonRpcId {
  params: { name: string; arguments?: Record<string, unknown> };
}

export interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

type ToolListHandler = () => { tools: ToolDefinition[] } | Promise<{ tools: ToolDefinition[] }>;
type ToolCallHandler = (request: CallToolRequest) => CallToolResult | Promise<CallToolResult>;

interface JsonRpcError {
  code: number;
  message: string;
}

function errorResponse(id: JsonRpcId["id"], error: JsonRpcError): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error };
}

function resultResponse(id: JsonRpcId["id"], result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function isRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.jsonrpc === "2.0" && typeof record.method === "string";
}

/** A message with an `id` expects a response; one without is a notification. */
function hasId(message: JsonRpcRequest): boolean {
  return message.id !== undefined && message.id !== null;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

export interface McpServerInfo {
  name: string;
  version: string;
}

/**
 * Holds the tool handlers and answers dispatched requests. One instance per
 * session, matching how `provider-mcp.ts` already creates its servers.
 */
export class McpServer {
  private readonly info: McpServerInfo;
  private toolListHandler?: ToolListHandler;
  private toolCallHandler?: ToolCallHandler;
  private closed = false;

  constructor(
    info: McpServerInfo,
    _options?: { capabilities?: { tools?: Record<string, unknown> } },
  ) {
    this.info = info;
  }

  setToolListHandler(handler: ToolListHandler): void {
    this.toolListHandler = handler;
  }

  setToolCallHandler(handler: ToolCallHandler): void {
    this.toolCallHandler = handler;
  }

  /** Binds this server to its transport; the transport performs the I/O. */
  async connect(transport: StreamableHTTPServerTransport): Promise<void> {
    if (this.closed) throw new Error("server is closed");
    transport.attach(this);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Dispatch one JSON-RPC request. Notifications answer `undefined`. */
  async handle(message: JsonRpcRequest): Promise<Record<string, unknown> | undefined> {
    const id = hasId(message) ? message.id ?? null : undefined;
    const reply = (result: unknown): Record<string, unknown> | undefined =>
      id === undefined ? undefined : resultResponse(id, result);
    const fail = (code: number, text: string): Record<string, unknown> | undefined =>
      id === undefined ? undefined : errorResponse(id, { code, message: text });

    switch (message.method) {
      case "initialize": {
        const requested = message.params?.protocolVersion;
        const protocolVersion =
          typeof requested === "string" &&
          (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
            ? requested
            : LATEST_PROTOCOL_VERSION;
        return reply({
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: this.info.name, version: this.info.version },
        });
      }
      case "ping":
        return reply({});
      case "tools/list": {
        if (!this.toolListHandler) return reply({ tools: [] });
        const listed = await this.toolListHandler();
        return reply({ tools: listed.tools });
      }
      case "tools/call": {
        const params = message.params;
        const name = params?.name;
        if (typeof name !== "string" || !name) return fail(INVALID_PARAMS, "tools/call requires a tool name");
        if (!this.toolCallHandler) return fail(METHOD_NOT_FOUND, `unknown tool: ${name}`);
        const args = params?.arguments;
        const result = await this.toolCallHandler({
          id: message.id,
          params: {
            name,
            arguments:
              typeof args === "object" && args !== null && !Array.isArray(args)
                ? (args as Record<string, unknown>)
                : {},
          },
        });
        return reply(result);
      }
      default:
        // Notifications (initialized, cancelled, …) need no answer; anything
        // else naming an unknown method is an error the client should see.
        return fail(METHOD_NOT_FOUND, `method not found: ${message.method}`);
    }
  }
}

export interface StreamableHTTPServerTransportOptions {
  sessionIdGenerator?: () => string;
  onsessioninitialized?: (sessionId: string) => void;
  onsessionclosed?: (sessionId?: string) => void;
}

/**
 * Streamable-HTTP framing for one session.
 *
 * Request handling intentionally assumes the caller has already authenticated
 * the request, validated the Host header, capped the body, and resolved which
 * session it belongs to — `provider-mcp.ts` does all four before delegating,
 * and duplicating them here would create two sources of truth.
 */
export class StreamableHTTPServerTransport {
  sessionId?: string;
  onclose?: () => void;
  private readonly sessionIdGenerator?: () => string;
  private readonly onsessioninitialized?: (sessionId: string) => void;
  private readonly onsessionclosed?: (sessionId?: string) => void;
  private server?: McpServer;
  private closed = false;

  constructor(options?: StreamableHTTPServerTransportOptions) {
    this.sessionIdGenerator = options?.sessionIdGenerator;
    this.onsessioninitialized = options?.onsessioninitialized;
    this.onsessionclosed = options?.onsessionclosed;
  }

  /** Bind the server whose handlers answer this transport's requests. */
  attach(server: McpServer): void {
    this.server = server;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Callbacks run while `sessionId` is still set: the bridge removes the
    // session from its map by that id, and clearing it first left a closed
    // session occupying a cap slot.
    const id = this.sessionId;
    this.onsessionclosed?.(id);
    this.onclose?.();
    this.sessionId = undefined;
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> {
    if (this.closed) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      await this.close();
      return;
    }
    if (req.method !== "POST") {
      // No server-initiated messages, so no standing GET stream to offer.
      res.writeHead(405, { Allow: "POST, DELETE" }).end();
      return;
    }

    const body = parsedBody !== undefined ? parsedBody : await readBody(req);
    if (body === undefined) {
      this.respond(req, res, [errorResponse(null, { code: PARSE_ERROR, message: "invalid JSON body" })]);
      return;
    }
    const raw = Array.isArray(body) ? body : [body];
    const messages = raw.filter(isRequest);
    if (messages.length === 0) {
      this.respond(req, res, [errorResponse(null, { code: INVALID_REQUEST, message: "not a JSON-RPC request" })]);
      return;
    }

    const initializing = messages.some((message) => message.method === "initialize");
    if (initializing && this.sessionId === undefined) {
      const generated = this.sessionIdGenerator?.();
      if (generated) this.sessionId = generated;
    }

    const responses: Record<string, unknown>[] = [];
    for (const message of messages) {
      if (!this.server) {
        if (hasId(message)) responses.push(errorResponse(message.id ?? null, { code: INTERNAL_ERROR, message: "server not attached" }));
        continue;
      }
      try {
        const response = await this.server.handle(message);
        if (response) responses.push(response);
      } catch (error) {
        if (hasId(message)) {
          responses.push(
            errorResponse(message.id ?? null, {
              code: INTERNAL_ERROR,
              message: error instanceof Error ? error.message : "internal error",
            }),
          );
        }
      }
    }

    if (responses.length === 0) {
      // Notifications only: the spec wants an empty 202.
      res.writeHead(202, this.sessionHeaders()).end();
      if (initializing) this.onsessioninitialized?.(this.sessionId ?? "");
      return;
    }
    this.respond(req, res, responses);
    if (initializing) this.onsessioninitialized?.(this.sessionId ?? "");
  }

  private sessionHeaders(): Record<string, string> {
    return this.sessionId ? { [SESSION_HEADER]: this.sessionId } : {};
  }

  /**
   * Answer with JSON when the client accepts it, otherwise a one-message SSE
   * stream. Clients commonly send `Accept: application/json, text/event-stream`,
   * while a strict SSE-only client must not receive JSON.
   */
  private respond(req: IncomingMessage, res: ServerResponse, responses: Record<string, unknown>[]): void {
    if (res.headersSent) return;
    const accept = String(req.headers.accept ?? "");
    const acceptsJson = accept.includes("application/json") || accept === "" || accept === "*/*";
    const headers = this.sessionHeaders();
    if (acceptsJson) {
      res.writeHead(200, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(responses.length === 1 ? responses[0] : responses));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...headers,
    });
    for (const response of responses) {
      res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    }
    res.end();
  }
}
