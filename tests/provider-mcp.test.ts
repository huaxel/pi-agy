import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { AgyProviderDriver } from "../extensions/lib/provider-driver.js";
import { withTimingFakeAgy, awaitWithWatchdog } from "./timing-helpers.js";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { BRIDGE_TOKEN_HEADER, startMcpBridge, type McpBridgeHandle } from "../extensions/lib/provider-mcp.js";

const handles: McpBridgeHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const handle = handles.pop()!;
    await handle.stop().catch(() => undefined);
  }
});

async function withIsolatedAgentDir<T>(fn: () => Promise<T>): Promise<T> {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await fn();
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
  }
}

async function startBridge(dir: string): Promise<McpBridgeHandle> {
  const handle = await startMcpBridge(dir);
  assert.ok(handle, "bridge failed to start");
  handles.push(handle);
  return handle;
}

async function readToken(configDir: string): Promise<string> {
  const raw = await readFile(path.join(configDir, ".agents", "mcp_config.json"), "utf8");
  const parsed = JSON.parse(raw) as {
    mcpServers: Record<string, { serverUrl: string; headers: Record<string, string> }>;
  };
  const servers = Object.values(parsed.mcpServers);
  assert.equal(servers.length, 1);
  assert.match(servers[0].serverUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  const token = servers[0].headers[BRIDGE_TOKEN_HEADER];
  assert.ok(token && token.length >= 32, "missing shared-secret header");
  return token;
}

async function connectClient(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { [BRIDGE_TOKEN_HEADER]: token } },
  });
  const client = new Client({ name: "test-client", version: "1" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

describe("MCP bridge", () => {
  it("writes a loopback config with a shared secret", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startBridge(dir);
      await stat(path.join(handle.configDir, ".agents", "mcp_config.json"));
      await readToken(handle.configDir);
    });
  });

  it("lists the built-in read-only tools and serves sessions", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startBridge(dir);
      const client = await connectClient(handle.url, await readToken(handle.configDir));
      try {
        const listed = await client.listTools();
        assert.deepEqual(
          listed.tools.map((tool) => tool.name).sort(),
          ["activate_skill", "agy_model_catalog", "agy_quota_report", "agy_sessions_list", "bridge_poll_result"],
        );
        const sessions = (await client.callTool({ name: "agy_sessions_list", arguments: { dir } })) as {
          content: Array<{ text: string }>;
        };
        assert.match(sessions.content[0].text, /No agy conversations recorded/);
        const unknown = (await client.callTool({ name: "nope", arguments: {} })) as {
          isError?: boolean;
        };
        assert.equal(unknown.isError, true);
      } finally {
        await client.close();
      }
    });
  });

  it("accepts fresh clients after an earlier MCP initialization", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startBridge(dir);
      const token = await readToken(handle.configDir);
      const clientA = await connectClient(handle.url, token);
      try {
        assert.equal((await clientA.listTools()).tools.length, 5);
      } finally {
        await clientA.close();
      }
      const clientB = await connectClient(handle.url, token);
      try {
        assert.equal((await clientB.listTools()).tools.length, 5);
        const sessions = (await clientB.callTool({ name: "agy_sessions_list", arguments: { dir } })) as {
          content: Array<{ text: string }>;
        };
        assert.match(sessions.content[0].text, /No agy conversations recorded/);
      } finally {
        await clientB.close();
      }

      const [clientC, clientD] = await Promise.all([
        connectClient(handle.url, token),
        connectClient(handle.url, token),
      ]);
      try {
        assert.equal((await clientC.listTools()).tools.length, 5);
        assert.equal((await clientD.listTools()).tools.length, 5);
      } finally {
        await Promise.all([clientC.close(), clientD.close()]);
      }
    });
  });

  it("bounds sessions and reclaims idle slots", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startMcpBridge(dir, { sessionCap: 1, sessionIdleMs: 50 });
      assert.ok(handle);
      handles.push(handle);
      const token = await readToken(handle.configDir);
      const malformed = await fetch(handle.url, {
        method: "POST",
        headers: { "content-type": "application/json", [BRIDGE_TOKEN_HEADER]: token },
        body: "not-json",
      });
      assert.equal(malformed.status, 400);
      await malformed.arrayBuffer();
      const unknown = await fetch(handle.url, {
        method: "POST",
        headers: { "content-type": "application/json", [BRIDGE_TOKEN_HEADER]: token, "mcp-session-id": "unknown" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      assert.equal(unknown.status, 404);
      await unknown.arrayBuffer();
      const clientA = await connectClient(handle.url, token);
      await assert.rejects(connectClient(handle.url, token), /503|Service Unavailable|Streamable HTTP error/);
      await clientA.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const clientB = await connectClient(handle.url, token);
      try {
        assert.equal((await clientB.listTools()).tools.length, 5);
      } finally {
        await clientB.close();
      }
    });
  });

  it("reuses a capped slot after explicit MCP termination", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startMcpBridge(dir, { sessionCap: 1 });
      assert.ok(handle);
      handles.push(handle);
      const token = await readToken(handle.configDir);
      const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", [BRIDGE_TOKEN_HEADER]: token };
      const initBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
      const first = await fetch(handle.url, { method: "POST", headers, body: initBody });
      assert.equal(first.status, 200);
      const sessionId = first.headers.get("mcp-session-id");
      assert.ok(sessionId);
      await first.arrayBuffer();
      const terminated = await fetch(handle.url, { method: "DELETE", headers: { [BRIDGE_TOKEN_HEADER]: token, "mcp-session-id": sessionId } });
      assert.equal(terminated.status, 200);
      await terminated.arrayBuffer();
      const second = await fetch(handle.url, { method: "POST", headers, body: initBody });
      assert.equal(second.status, 200);
      await second.arrayBuffer();
    });
  });

  it("serializes concurrent initialization at the session cap", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startMcpBridge(dir, { sessionCap: 1 });
      assert.ok(handle);
      handles.push(handle);
      const token = await readToken(handle.configDir);
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
      const responses = await Promise.all(Array.from({ length: 4 }, () => fetch(handle.url, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", [BRIDGE_TOKEN_HEADER]: token }, body,
      })));
      const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
      await Promise.all(responses.map((response) => response.arrayBuffer()));
      assert.deepEqual(statuses, [200, 503, 503, 503]);
    });
  });

  it("releases synchronous completed parks before accepting the callback", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startMcpBridge(dir, { sessionCap: 1, sessionIdleMs: 60, escalateAfterMs: 10 });
      assert.ok(handle);
      handles.push(handle);
      handle.setTools([{ name: "instant", piName: "instant", description: "Instant", inputSchema: { type: "object" } }]);
      let completed = false;
      handle.setParkHandler((park) => {
        completed = handle.completePark(park.callId, { text: "instant", isError: false });
        return true;
      });
      const token = await readToken(handle.configDir);
      const client = await connectClient(handle.url, token);
      try {
        const result = (await client.callTool({ name: "instant", arguments: {} })) as { content: Array<{ text: string }> };
        assert.equal(completed, true);
        assert.equal(result.content[0].text, "instant");
      } finally {
        await client.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      const fresh = await connectClient(handle.url, token);
      await fresh.close();
    });
  });

  it("keeps a raw HTTP escalated park alive past idle expiry", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startMcpBridge(dir, { sessionIdleMs: 60, escalateAfterMs: 10 });
      assert.ok(handle);
      handles.push(handle);
      handle.setTools([{ name: "slow", piName: "slow", description: "Slow", inputSchema: { type: "object" } }]);
      let parked: { callId: string } | undefined;
      handle.setParkHandler((park) => {
        parked = park;
        return true;
      });
      const token = await readToken(handle.configDir);
      const baseHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream", [BRIDGE_TOKEN_HEADER]: token };
      const init = await fetch(handle.url, { method: "POST", headers: baseHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "1" } } }) });
      assert.equal(init.status, 200);
      const sessionId = init.headers.get("mcp-session-id");
      assert.ok(sessionId);
      await init.arrayBuffer();
      const headers = { ...baseHeaders, "mcp-session-id": sessionId };
      const initialized = await fetch(handle.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) });
      assert.equal(initialized.status, 202);
      await initialized.arrayBuffer();
      const pending = await fetch(handle.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "slow", arguments: {} } }) });
      assert.equal(pending.status, 200);
      const pendingBody = await pending.text();
      assert.match(pendingBody, /STILL RUNNING/);
      assert.ok(parked);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const ping = await fetch(handle.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }) });
      assert.equal(ping.status, 200);
      await ping.arrayBuffer();
      const poll = await fetch(handle.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "bridge_poll_result", arguments: { callId: parked.callId } } }) });
      assert.equal(poll.status, 200);
      await poll.arrayBuffer();
      assert.equal(handle.completePark(parked.callId, { text: "done", isError: false }), true);
    });
  });

  it("falls back to the bundled catalog when discovery fails", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startBridge(dir);
      const client = await connectClient(handle.url, await readToken(handle.configDir));
      const previousPath = process.env.PATH;
      process.env.PATH = await mkdtemp(path.join(os.tmpdir(), "pi-agy-empty-path-"));
      try {
        const catalog = (await client.callTool({ name: "agy_model_catalog", arguments: {} })) as {
          content: Array<{ text: string }>;
        };
        assert.match(catalog.content[0].text, /fallback catalog/);
        assert.match(catalog.content[0].text, /gemini-3-8-flash/);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        await client.close();
      }
    });
  });

  it("rejects requests without the shared secret", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startBridge(dir);
      const response = await fetch(handle.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      assert.equal(response.status, 403);
      await response.arrayBuffer().catch(() => undefined);
    });
  });

  it("rejects complex initialization before allocating an MCP session", async (t) => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startMcpBridge(dir, { sessionCap: 1 });
      assert.ok(handle);
      handles.push(handle);
      const token = await readToken(handle.configDir);
      const delegated = t.mock.method(StreamableHTTPServerTransport.prototype, "handleRequest");
      // Valid metadata with benign values: not a constrained-array error amplifier.
      const body = JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: {
          protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "1" },
          _meta: { padding: Array(10_000).fill(null) },
        },
      });
      assert.ok(Buffer.byteLength(body) < 1024 * 1024);
      const response = await fetch(handle.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", [BRIDGE_TOKEN_HEADER]: token },
        body, signal: AbortSignal.timeout(10_000),
      });
      await response.arrayBuffer();
      assert.equal(response.status, 413);
      assert.equal(delegated.mock.callCount(), 0, "refused input must not reach the SDK transport");
      // No pending/session slot was consumed before the refusal.
      const fresh = await connectClient(handle.url, token);
      try {
        assert.equal((await fresh.listTools()).tools.length, 5);
      } finally {
        await fresh.close();
      }
    });
  });

  it("bounds complete tool requests while preserving strings and session recovery", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startBridge(dir);
      handle.setTools([{ name: "budget_probe", piName: "budget_probe", description: "Safe marker", inputSchema: { type: "object" } }]);
      let calls = 0;
      handle.setParkHandler((park) => {
        calls++;
        return handle.completePark(park.callId, { text: "budget-ok", isError: false });
      });
      const token = await readToken(handle.configDir);
      const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
        requestInit: { headers: { [BRIDGE_TOKEN_HEADER]: token } },
      });
      const client = new Client({ name: "budget-client", version: "1" }, { capabilities: {} });
      await client.connect(transport);
      assert.ok(transport.sessionId);
      const headers = {
        "content-type": "application/json", accept: "application/json, text/event-stream",
        [BRIDGE_TOKEN_HEADER]: token, "mcp-session-id": transport.sessionId,
      };
      let id = 10;
      const call = async (args: Record<string, unknown>): Promise<{ status: number; text: string }> => {
        const body = JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "budget_probe", arguments: args } });
        assert.ok(Buffer.byteLength(body) < 1024 * 1024, "all structural cases fit the byte limit");
        const response = await fetch(handle.url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
        return { status: response.status, text: await response.text() };
      };
      try {
        // 4 envelope keys + 2 params keys + 1 arguments key + 9993 slots.
        const items = Array(9993).fill(null);
        const exact = await call({ items });
        assert.equal(exact.status, 200);
        assert.match(exact.text, /budget-ok/);
        assert.equal(calls, 1);
        items.push(null);
        const wide = await call({ items });
        assert.equal(wide.status, 413);
        assert.equal(wide.text, '{"error":"Request structure exceeds bridge limits"}');
        assert.equal(calls, 1, "over-budget input must not park a tool");
        let nested: unknown = null;
        for (let i = 0; i < 61; i++) nested = [nested];
        // Envelope/params/arguments are the first 3 container levels.
        assert.equal((await call({ nested })).status, 200);
        assert.equal(calls, 2);
        assert.equal((await call({ nested: [nested] })).status, 413);
        assert.equal(calls, 2, "over-depth input must not park a tool");
        const largeString = await call({ content: "€".repeat(180_000) });
        assert.equal(largeString.status, 200);
        assert.match(largeString.text, /budget-ok/);
        assert.equal(calls, 3);
        assert.equal((await client.listTools()).tools.length, 6);
        assert.match(JSON.stringify(await client.callTool({ name: "budget_probe", arguments: {} })), /budget-ok/);
        assert.equal(calls, 4);
        const deleted = await fetch(handle.url, { method: "DELETE", headers, signal: AbortSignal.timeout(10_000) });
        assert.equal(deleted.status, 200);
        await deleted.arrayBuffer();
      } finally {
        await client.close();
      }
      const [freshA, freshB] = await Promise.all([connectClient(handle.url, token), connectClient(handle.url, token)]);
      try {
        assert.equal((await freshA.listTools()).tools.length, 6);
        assert.equal((await freshB.listTools()).tools.length, 6);
      } finally {
        await Promise.all([freshA.close(), freshB.close()]);
      }
    });
  });

  it("checks authentication and Host before structure and keeps malformed JSON at 400", async (t) => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startBridge(dir);
      const token = await readToken(handle.configDir);
      const delegated = t.mock.method(StreamableHTTPServerTransport.prototype, "handleRequest");
      const body = JSON.stringify({ padding: Array(10_000).fill(null) });
      const unsigned = await fetch(handle.url, {
        method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(10_000),
      });
      await unsigned.arrayBuffer();
      assert.equal(unsigned.status, 403);
      const { request } = await import("node:http");
      const target = new URL(handle.url);
      const foreignHost = await new Promise<number>((resolve, reject) => {
        const req = request({
          host: "127.0.0.1", port: Number(target.port), path: target.pathname, method: "POST",
          headers: { host: "foreign.invalid:80", "content-type": "application/json", [BRIDGE_TOKEN_HEADER]: token },
          signal: AbortSignal.timeout(10_000),
        }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
        req.on("error", reject);
        req.end(body);
      });
      assert.equal(foreignHost, 403);
      const malformed = await fetch(handle.url, {
        method: "POST", headers: { "content-type": "application/json", [BRIDGE_TOKEN_HEADER]: token },
        body: "not-json", signal: AbortSignal.timeout(10_000),
      });
      await malformed.arrayBuffer();
      assert.equal(malformed.status, 400);
      assert.equal(delegated.mock.callCount(), 0);
    });
  });

  it("rejects oversized bodies", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startBridge(dir);
      const token = await readToken(handle.configDir);
      const response = await fetch(handle.url, {
        method: "POST",
        headers: { "content-type": "application/json", [BRIDGE_TOKEN_HEADER]: token },
        body: "x".repeat(1024 * 1024 + 1),
      });
      assert.equal(response.status, 413);
      await response.arrayBuffer().catch(() => undefined);
    });
  });

  it("isolates concurrent bridges per workspace", async () => {
    await withIsolatedAgentDir(async () => {
      const dirA = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-a-"));
      const dirB = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-b-"));
      const bridgeA = await startBridge(dirA);
      const bridgeB = await startBridge(dirB);
      assert.notEqual(bridgeA.configDir, bridgeB.configDir);
      assert.notEqual(bridgeA.url, bridgeB.url);
      // Stopping one leaves the other serving.
      handles.splice(handles.indexOf(bridgeA), 1);
      await bridgeA.stop();
      await assert.rejects(stat(path.join(bridgeA.configDir, ".agents", "mcp_config.json")));
      const client = await connectClient(bridgeB.url, await readToken(bridgeB.configDir));
      try {
        const listed = await client.listTools();
        assert.equal(listed.tools.length, 5);
      } finally {
        await client.close();
      }
    });
  });

  it("denies session listing outside the workspace", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const outside = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-out-"));
      const handle = await startBridge(dir);
      const client = await connectClient(handle.url, await readToken(handle.configDir));
      try {
        const denied = (await client.callTool({
          name: "agy_sessions_list",
          arguments: { dir: outside },
        })) as { isError?: boolean; content: Array<{ text: string }> };
        assert.equal(denied.isError, true);
        assert.match(denied.content[0].text, /Access denied/);
      } finally {
        await client.close();
      }
    });
  });

  it("rejects requests with a foreign Host header", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startBridge(dir);
      const token = await readToken(handle.configDir);
      const { request } = await import("node:http");
      const status = await new Promise<number>((resolve, reject) => {
        const target = new URL(handle.url);
        const req = request(
          {
            host: "127.0.0.1",
            port: Number(target.port),
            path: target.pathname,
            method: "POST",
            headers: {
              host: "evil.example:80",
              "content-type": "application/json",
              [BRIDGE_TOKEN_HEADER]: token,
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
      });
      assert.equal(status, 403);
    });
  });

  it("stop() settles promptly with keep-alive connections open", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startBridge(dir);
      const { Agent, request } = await import("node:http");
      const agent = new Agent({ keepAlive: true });
      const target = new URL(handle.url);
      const token = await readToken(handle.configDir);
      // Park an open keep-alive socket on the server.
      await new Promise<void>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: Number(target.port),
            path: target.pathname,
            method: "GET",
            agent,
            headers: { [BRIDGE_TOKEN_HEADER]: token },
          },
          (res) => {
            res.resume();
          },
        );
        req.on("error", reject);
        req.end();
        setTimeout(resolve, 200);
      });
      handles.splice(handles.indexOf(handle), 1);
      const started = Date.now();
      await handle.stop();
      assert.ok(Date.now() - started < 5000, "stop() must not hang on open sockets");
      agent.destroy();
    });
  });

  it("parks bridged calls until completed", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startBridge(dir);
      handle.setTools([
        { name: "read", piName: "read", description: "Read a file", inputSchema: { type: "object" } },
      ]);
      const parks: Array<{ callId: string; toolName: string; args: Record<string, unknown> }> = [];
      handle.setParkHandler((park) => {
        parks.push(park);
        return true;
      });
      const client = await connectClient(handle.url, await readToken(handle.configDir));
      try {
        const listed = await client.listTools();
        assert.ok(listed.tools.some((tool) => tool.name === "read"));
        const pending = client.callTool({ name: "read", arguments: { path: "/tmp/x" } });
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(parks.length, 1);
        assert.equal(parks[0].toolName, "read");
        assert.deepEqual(parks[0].args, { path: "/tmp/x" });
        assert.equal(handle.completePark("unknown-id", { text: "x", isError: false }), false);
        assert.equal(handle.completePark(parks[0].callId, { text: "file contents", isError: false }), true);
        const result = (await pending) as { content: Array<{ text: string }>; isError?: boolean };
        assert.equal(result.content[0].text, "file contents");
        assert.equal(result.isError, undefined);
      } finally {
        await client.close();
      }
    });
  });

  it("fails parked calls when no turn awaits and on teardown", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startBridge(dir);
      handle.setTools([
        { name: "read", piName: "read", description: "Read a file", inputSchema: { type: "object" } },
      ]);
      const client = await connectClient(handle.url, await readToken(handle.configDir));
      try {
        // No park handler: the call fails instead of hanging.
        const refused = (await client.callTool({ name: "read", arguments: {} })) as {
          isError?: boolean;
        };
        assert.equal(refused.isError, true);
        // Parked then torn down: the waiter resolves with an error result.
        let interagency: { callId: string } | undefined;
        handle.setParkHandler((park) => {
          interagency = { callId: park.callId };
          return true;
        });
        const pending = client.callTool({ name: "read", arguments: {} });
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.ok(interagency);
        handle.failAllParks("teardown");
        const failed = (await pending) as { isError?: boolean; content: Array<{ text: string }> };
        assert.equal(failed.isError, true);
        assert.match(failed.content[0].text, /teardown/);
      } finally {
        await client.close();
      }
    });
  });

  it("describes tool counts for status surfaces", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startBridge(dir);
      assert.equal(handle.describe().toolCount, 5);
      handle.setTools([
        { name: "read", piName: "read", description: "Read", inputSchema: { type: "object" } },
      ]);
      assert.equal(handle.describe().toolCount, 6);
    });
  });

  it("serves activate_skill with skill body from discovered directories", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const skillDir = path.join(dir, ".pi", "skills", "test-skill");
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: test-skill\ndescription: A test skill for bridge testing\n---\n# Test Skill Instructions\nDo test things.",
      );
      const handle = await startBridge(dir);
      const client = await connectClient(handle.url, await readToken(handle.configDir));
      try {
        const listed = await client.listTools();
        const skillTool = listed.tools.find((t) => t.name === "activate_skill");
        assert.ok(skillTool);
        assert.match(skillTool.description ?? "", /test-skill/);

        // Call activate_skill
        const result = (await client.callTool({
          name: "activate_skill",
          arguments: { name: "test-skill" },
        })) as { content: Array<{ text: string }>; isError?: boolean };
        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /# Test Skill Instructions/);

        // Unknown skill
        const unknown = (await client.callTool({
          name: "activate_skill",
          arguments: { name: "nonexistent" },
        })) as { content: Array<{ text: string }>; isError?: boolean };
        assert.equal(unknown.isError, true);
        assert.match(unknown.content[0].text, /Unknown skill/);
      } finally {
        await client.close();
      }
    });
  });

  it("escalates long-running calls to STILL RUNNING and resolves via bridge_poll_result", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      // Escalate quickly after 50ms for testing
      const handle = await startMcpBridge(dir, { escalateAfterMs: 50, sessionIdleMs: 50 });
      assert.ok(handle);
      handles.push(handle);
      handle.setTools([
        { name: "slow_tool", piName: "slow_tool", description: "Slow tool", inputSchema: { type: "object" } },
      ]);
      let callIdCaptured = "";
      handle.setParkHandler((park) => {
        callIdCaptured = park.callId;
        return true;
      });
      const client = await connectClient(handle.url, await readToken(handle.configDir));
      try {
        // Initial call should early-ack with STILL RUNNING after ~50ms
        const earlyAck = (await client.callTool({
          name: "slow_tool",
          arguments: {},
        })) as { content: Array<{ text: string }>; isError?: boolean };
        assert.equal(earlyAck.isError, undefined);
        assert.match(earlyAck.content[0].text, /STILL RUNNING/);
        assert.match(earlyAck.content[0].text, new RegExp(callIdCaptured));

        // The HTTP request has already early-acked, but the accepted park keeps
        // the session alive beyond its idle TTL until completion.
        await new Promise((resolve) => setTimeout(resolve, 120));
        // Poll before completion
        const stillRunningPoll = (await client.callTool({
          name: "bridge_poll_result",
          arguments: { callId: callIdCaptured },
        })) as { content: Array<{ text: string }>; isError?: boolean };
        assert.equal(stillRunningPoll.isError, undefined);
        assert.match(stillRunningPoll.content[0].text, /STILL RUNNING/);

        // Complete the park
        const completed = handle.completePark(callIdCaptured, {
          text: "completed background computation",
          isError: false,
        });
        assert.equal(completed, true);

        // Poll after completion
        const finishedPoll = (await client.callTool({
          name: "bridge_poll_result",
          arguments: { callId: callIdCaptured },
        })) as { content: Array<{ text: string }>; isError?: boolean };
        assert.equal(finishedPoll.isError, undefined);
        assert.equal(finishedPoll.content[0].text, "completed background computation");

        // Subsequent poll should now report already finished / unknown
        const subsequentPoll = (await client.callTool({
          name: "bridge_poll_result",
          arguments: { callId: callIdCaptured },
        })) as { content: Array<{ text: string }>; isError?: boolean };
        assert.equal(subsequentPoll.isError, true);
        assert.match(subsequentPoll.content[0].text, /Error: no escalated bridge call/);
      } finally {
        await client.close();
      }
    });
  });

  it("removes its config dir on stop", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startBridge(dir);
      const configDir = handle.configDir;
      handles.pop();
      await handle.stop();
      await assert.rejects(stat(path.join(configDir, ".agents", "mcp_config.json")));
    });
  });
});


describe("bridge and driver terminal ownership", () => {
  for (const status of ["SUCCESS", "FAILED", "ORPHAN"]) {
    it(`handles an escalated parked ${status} without losing ownership`, { timeout: 7000 }, async () => {
      await withIsolatedAgentDir(async () => {
        await withTimingFakeAgy({ onSpawn: (_args, child) => { Object.assign(child, { stdin: new PassThrough() }); } }, async (children) => {
          const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-composed-"));
          const bridge = await startMcpBridge(dir, { escalateAfterMs: 5 });
          assert.ok(bridge);
          handles.push(bridge);
          const driver = new AgyProviderDriver();
          const client = await connectClient(bridge.url, await readToken(bridge.configDir));
          let orphaned = 0;
          driver.onParksOrphaned = (message) => { orphaned++; bridge.failAllParks(message); };
          bridge.setTools([{ name: "slow", piName: "slow", description: "Slow", inputSchema: { type: "object" } }]);
          bridge.setParkHandler((park) => driver.notifyPark(park));
          try {
            const first = driver.turn({ dir, fullModel: "fake", skipPermissions: false }, {
              prompt: "test", signal: new AbortController().signal, timeoutMs: 1000,
            });
            await Promise.resolve();
            const child = [...children][0];
            const call = client.callTool({ name: "slow", arguments: {} });
            const parked = await awaitWithWatchdog(first, "composed park");
            assert.equal(parked.kind, "parked");
            if (parked.kind !== "parked") throw new Error("expected park");
            const ack = await awaitWithWatchdog(call, "escalated MCP acknowledgement");
            assert.match(JSON.stringify(ack), /STILL RUNNING/);
            if (status === "ORPHAN") child.close(3);
            else child.stdout.write(JSON.stringify({ event: "result", result: { status, response: "canonical answer" } }) + "\n");
            const delivered = bridge.completePark(parked.park.callId, { text: "Pi tool output", isError: false });
            if (status === "ORPHAN") {
              assert.equal(orphaned, 1);
              assert.equal(delivered, false);
              assert.throws(() => driver.continueTurn(), /no suspended turn/);
            } else {
              assert.equal(delivered, true);
              assert.equal(orphaned, 0);
              const resumed = Promise.resolve().then(() => driver.continueTurn());
              if (status === "FAILED") await assert.rejects(awaitWithWatchdog(resumed, "composed terminal failure"), /FAILED/);
              else {
                const done = await awaitWithWatchdog(resumed, "composed terminal success");
                assert.equal(done.kind, "done");
                if (done.kind === "done") assert.equal(done.outcome.text, "canonical answer");
              }
              assert.throws(() => driver.continueTurn(), /no suspended turn/);
            }
            assert.equal(bridge.completePark(parked.park.callId, { text: "duplicate", isError: false }), false);
            const poll = await awaitWithWatchdog(client.callTool({ name: "bridge_poll_result", arguments: { callId: parked.park.callId } }), "ordinary bridge poll");
            assert.match(JSON.stringify(poll), status === "ORPHAN" ? /exited mid-turn/ : /Pi tool output/);
          } finally {
            await driver.close();
            await client.close();
            await bridge.stop();
          }
        });
      });
    });
  }
});
