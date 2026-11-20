/**
 * Protocol-level tests for the dependency-free MCP transport.
 *
 * The rest of the bridge suite drives this server with the real SDK *client*,
 * which is the compatibility proof. These cases cover the framing decisions a
 * well-behaved client hides: SSE-only acceptance, notifications, unsupported
 * methods, malformed bodies, batches, and session lifecycle.
 */

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { describe, it } from "node:test";

import {
  McpServer,
  StreamableHTTPServerTransport,
  SESSION_HEADER,
} from "../extensions/lib/mcp-transport.js";
import type { ToolDefinition } from "../extensions/lib/mcp-transport.js";

const TOOLS: ToolDefinition[] = [
  {
    name: "echo",
    description: "Echo text back.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
];

interface Harness {
  url: string;
  stop: () => Promise<void>;
  closed: string[];
  sessions: string[];
}

async function startHarness(): Promise<Harness> {
  const sessions: string[] = [];
  const closed: string[] = [];
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const sid = req.headers[SESSION_HEADER];
    if (typeof sid === "string") {
      const existing = transports.get(sid);
      if (!existing) {
        res.writeHead(404).end();
        return;
      }
      await existing.handleRequest(req, res);
      return;
    }
    let sequence = 0;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => `session-${++sequence}-${Math.random().toString(16).slice(2, 8)}`,
      onsessioninitialized: (id) => {
        sessions.push(id);
        transports.set(id, transport);
      },
      onsessionclosed: (id) => {
        if (id) {
          closed.push(id);
          transports.delete(id);
        }
      },
    });
    const mcp = new McpServer({ name: "test-server", version: "1" });
    mcp.setToolListHandler(() => ({ tools: TOOLS }));
    mcp.setToolCallHandler((request) => ({
      content: [{ type: "text", text: `echo: ${String(request.params.arguments?.text ?? "")}` }],
    }));
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    sessions,
    closed,
    stop: () =>
      new Promise<void>((resolve) => {
        (server as Server).closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

const post = (url: string, body: unknown, sid?: string, accept = "application/json, text/event-stream") =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept,
      ...(sid ? { [SESSION_HEADER]: sid } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
};

describe("dependency-free MCP transport", () => {
  it("completes the handshake and echoes a supported protocol revision", async () => {
    const harness = await startHarness();
    try {
      const response = await post(harness.url, INITIALIZE);
      assert.equal(response.status, 200);
      const sid = response.headers.get(SESSION_HEADER);
      assert.ok(sid, "initialize must assign a session id");
      const body = (await response.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
      assert.equal(body.result.protocolVersion, "2025-03-26");
      assert.equal(body.result.serverInfo.name, "test-server");

      // A revision this server does not know falls back to the latest it speaks
      // instead of echoing something it cannot honour.
      const unknown = await post(harness.url, {
        ...INITIALIZE,
        params: { ...INITIALIZE.params, protocolVersion: "1999-01-01" },
      });
      const unknownBody = (await unknown.json()) as { result: { protocolVersion: string } };
      assert.equal(unknownBody.result.protocolVersion, "2025-06-18");
    } finally {
      await harness.stop();
    }
  });

  it("answers notifications with an empty 202", async () => {
    const harness = await startHarness();
    try {
      const init = await post(harness.url, INITIALIZE);
      const sid = init.headers.get(SESSION_HEADER)!;
      await init.arrayBuffer();
      const notified = await post(harness.url, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
      assert.equal(notified.status, 202);
      const text = await notified.text();
      assert.equal(text, "");
    } finally {
      await harness.stop();
    }
  });

  it("frames an SSE-only client with a single message event", async () => {
    const harness = await startHarness();
    try {
      const init = await post(harness.url, INITIALIZE, undefined, "text/event-stream");
      assert.equal(init.headers.get("content-type"), "text/event-stream");
      const sid = init.headers.get(SESSION_HEADER)!;
      const raw = await init.text();
      assert.match(raw, /^event: message\ndata: /);
      const payload = JSON.parse(raw.replace(/^event: message\ndata: /, "").trim()) as { result: { serverInfo: { name: string } } };
      assert.equal(payload.result.serverInfo.name, "test-server");

      const list = await post(harness.url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid, "text/event-stream");
      const listRaw = await list.text();
      assert.match(listRaw, /tools/);
    } finally {
      await harness.stop();
    }
  });

  it("dispatches tools/call and reports unknown methods as JSON-RPC errors", async () => {
    const harness = await startHarness();
    try {
      const init = await post(harness.url, INITIALIZE);
      const sid = init.headers.get(SESSION_HEADER)!;
      await init.arrayBuffer();

      const list = (await (await post(harness.url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid)).json()) as {
        result: { tools: Array<{ name: string }> };
      };
      assert.deepEqual(list.result.tools.map((tool) => tool.name), ["echo"]);

      const call = (await (
        await post(harness.url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } }, sid)
      ).json()) as { result: { content: Array<{ text: string }> } };
      assert.equal(call.result.content[0].text, "echo: hi");

      const missing = (await (
        await post(harness.url, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "" } }, sid)
      ).json()) as { error: { code: number } };
      assert.equal(missing.error.code, -32602);

      const unknownMethod = (await (
        await post(harness.url, { jsonrpc: "2.0", id: 5, method: "resources/list" }, sid)
      ).json()) as { error: { code: number } };
      assert.equal(unknownMethod.error.code, -32601);

      const ping = (await (await post(harness.url, { jsonrpc: "2.0", id: 6, method: "ping" }, sid)).json()) as { result: unknown };
      assert.deepEqual(ping.result, {});
    } finally {
      await harness.stop();
    }
  });

  it("rejects malformed bodies and surfaces handler failures as JSON-RPC errors", async () => {
    const harness = await startHarness();
    try {
      const malformed = await post(harness.url, "not-json");
      assert.equal(malformed.status, 200);
      const body = (await malformed.json()) as { error: { code: number } };
      assert.equal(body.error.code, -32700);

      const notJsonRpc = await post(harness.url, { hello: "world" });
      const notJsonRpcBody = (await notJsonRpc.json()) as { error: { code: number } };
      assert.equal(notJsonRpcBody.error.code, -32600);
    } finally {
      await harness.stop();
    }
  });

  it("answers a batch per element rather than failing the whole request", async () => {
    const harness = await startHarness();
    try {
      const init = await post(harness.url, INITIALIZE);
      const sid = init.headers.get(SESSION_HEADER)!;
      await init.arrayBuffer();
      const batch = await post(
        harness.url,
        [
          { jsonrpc: "2.0", id: 10, method: "ping" },
          { jsonrpc: "2.0", id: 11, method: "tools/list" },
        ],
        sid,
      );
      const body = (await batch.json()) as Array<{ id: number }>;
      assert.deepEqual(body.map((entry) => entry.id), [10, 11]);
    } finally {
      await harness.stop();
    }
  });

  it("closes the session on DELETE and refuses server-initiated streams", async () => {
    const harness = await startHarness();
    try {
      const init = await post(harness.url, INITIALIZE);
      const sid = init.headers.get(SESSION_HEADER)!;
      await init.arrayBuffer();

      const get = await fetch(harness.url, {
        method: "GET",
        headers: { accept: "text/event-stream", [SESSION_HEADER]: sid },
      });
      assert.equal(get.status, 405, "this server never pushes unsolicited messages");

      const deleted = await fetch(harness.url, { method: "DELETE", headers: { [SESSION_HEADER]: sid } });
      assert.equal(deleted.status, 200);
      assert.deepEqual(harness.closed, [sid]);

      const afterClose = await post(harness.url, { jsonrpc: "2.0", id: 20, method: "ping" }, sid);
      assert.equal(afterClose.status, 404, "a closed session is not routable");
    } finally {
      await harness.stop();
    }
  });
});
