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
  /** Tool names the server actually dispatched, in order. */
  calls: string[];
}

async function startHarness(options?: { closeOn?: string }): Promise<Harness> {
  const sessions: string[] = [];
  const closed: string[] = [];
  const calls: string[] = [];
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
    mcp.setToolCallHandler(async (request) => {
      calls.push(request.params.name);
      if (options?.closeOn === request.params.name) {
        // The client DELETEs the session while this call is in flight.
        const sid = sessions.at(-1);
        if (sid) await transports.get(sid)?.close();
      }
      return { content: [{ type: "text", text: `echo: ${String(request.params.arguments?.text ?? "")}` }] };
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    sessions,
    closed,
    calls,
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

  it("stops dispatching a batch once the session closes mid-batch", async () => {
    const harness = await startHarness({ closeOn: "first" });
    try {
      const init = await post(harness.url, INITIALIZE);
      const sid = init.headers.get(SESSION_HEADER)!;
      await init.arrayBuffer();

      await (
        await post(
          harness.url,
          [
            { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "first" } },
            { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "second" } },
          ],
          sid,
        )
      ).text();

      // Both messages were resolved before the first handler ran; only the one
      // that was already executing may have run.
      assert.deepEqual(harness.calls, ["first"]);
    } finally {
      await harness.stop();
    }
  });

  it("rejects a tools/call that carries no id instead of running it silently", async () => {
    const harness = await startHarness();
    try {
      const init = await post(harness.url, INITIALIZE);
      const sid = init.headers.get(SESSION_HEADER)!;
      await init.arrayBuffer();

      // A notification-shaped call cannot be correlated with a result, and the
      // park/approval flow keys on that id — so nothing may run.
      const notification = (await (
        await post(harness.url, { jsonrpc: "2.0", method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } }, sid)
      ).json()) as { error?: { code: number; message: string }; result?: unknown };
      assert.equal(notification.error?.code, -32600);
      assert.match(notification.error?.message ?? "", /requires a string or numeric id/);
      assert.deepEqual(harness.calls, []);
    } finally {
      await harness.stop();
    }
  });

  it("rejects ids that JSON-RPC cannot echo", async () => {
    const harness = await startHarness();
    try {
      const init = await post(harness.url, INITIALIZE);
      const sid = init.headers.get(SESSION_HEADER)!;
      await init.arrayBuffer();

      for (const id of [{ nested: 1 }, true, [7]]) {
        const response = (await (
          await post(harness.url, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "echo" } }, sid)
        ).json()) as { error?: { code: number; message: string } };
        assert.equal(response.error?.code, -32600, JSON.stringify(id));
        assert.match(response.error?.message ?? "", /string or a number/);
      }
      assert.deepEqual(harness.calls, []);
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

  it("stops spending a batch once its replies exceed the byte budget", async () => {
    const harness = await startHarness();
    try {
      const init = await post(harness.url, INITIALIZE);
      const sid = init.headers.get(SESSION_HEADER)!;
      await init.arrayBuffer();
      // Each call echoes ~1 MiB back. The entry cap allows 32 of these; without
      // an aggregate budget they are all dispatched and all retained before
      // anything is serialized.
      const payload = "x".repeat(1024 * 1024);
      const call = (id: number) => ({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: TOOLS[0].name, arguments: { text: payload } },
      });
      const batch = await post(harness.url, [call(1), call(2), call(3), call(4)], sid);
      const body = (await batch.json()) as Array<Record<string, unknown>>;
      assert.deepEqual(
        body.map((entry) => entry.id),
        [1, 2, 3, 4],
      );
      const results = body.slice(0, 2) as Array<{ result?: unknown }>;
      assert.ok(results.every((entry) => entry.result !== undefined), "early calls still answer");
      const refused = body.slice(2) as Array<{ error?: { message?: string } }>;
      assert.ok(
        refused.every((entry) => /batch response exceeds/.test(entry.error?.message ?? "")),
        JSON.stringify(refused.map((entry) => entry.error)),
      );
      // The work is refused, not just the reply: calls 3 and 4 never dispatch.
      assert.deepEqual(harness.calls, [TOOLS[0].name, TOOLS[0].name]);
    } finally {
      await harness.stop();
    }
  });

  it("refuses an oversized batch instead of executing it", async () => {
    const harness = await startHarness();
    try {
      const init = await post(harness.url, INITIALIZE);
      const sid = init.headers.get(SESSION_HEADER)!;
      await init.arrayBuffer();
      // 33 entries is one past the cap. Each `tools/call` would do real work, so
      // the request has to be refused before the first one dispatches.
      const batch = await post(
        harness.url,
        Array.from({ length: 33 }, (_, index) => ({ jsonrpc: "2.0", id: index, method: "ping" })),
        sid,
      );
      const body = (await batch.json()) as { error: { code: number; message: string } };
      assert.equal(body.error.code, -32600);
      assert.match(body.error.message, /exceeds 32 entries/);

      // The largest accepted batch still works.
      const ok = await post(
        harness.url,
        Array.from({ length: 32 }, (_, index) => ({ jsonrpc: "2.0", id: index, method: "ping" })),
        sid,
      );
      assert.equal(((await ok.json()) as unknown[]).length, 32);
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
