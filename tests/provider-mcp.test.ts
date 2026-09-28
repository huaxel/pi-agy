import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

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

  it("lists the three read-only tools and serves sessions", async () => {
    await withIsolatedAgentDir(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-mcp-dir-"));
      const handle = await startBridge(dir);
      const client = await connectClient(handle.url, await readToken(handle.configDir));
      try {
        const listed = await client.listTools();
        assert.deepEqual(
          listed.tools.map((tool) => tool.name).sort(),
          ["agy_model_catalog", "agy_quota_report", "agy_sessions_list"],
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
        assert.equal(listed.tools.length, 3);
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
      assert.equal(handle.describe().toolCount, 3);
      handle.setTools([
        { name: "read", piName: "read", description: "Read", inputSchema: { type: "object" } },
      ]);
      assert.equal(handle.describe().toolCount, 4);
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
