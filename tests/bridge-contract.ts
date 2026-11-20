import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Provider } from "@earendil-works/pi-ai";
import { mock } from "node:test";

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals) => boolean;
  close: (code?: number | null, signal?: NodeJS.Signals | null) => void;
}

const TOTAL_BUDGET_MS = 10_000;
const startedAt = performance.now();
const deadline = startedAt + TOTAL_BUDGET_MS - 2_000;
const cleanupDeadline = startedAt + TOTAL_BUDGET_MS;
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "pi-agy-bridge-contract-"));
const workspace = path.join(fixtureRoot, "workspace");
const agentDir = path.join(fixtureRoot, "agent");
const previousCwd = process.cwd();
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const controller = new AbortController();
const simulatedLaunches: Array<{ command: string; args: string[] }> = [];
const forbiddenLaunches: string[] = [];
const children = new Set<FakeChild>();
const clients = new Set<Client>();
const observedLists: string[][] = [];
const observedSchemas: unknown[] = [];
let provider: Provider | undefined;
let firstToolResult = "";
// A failure inside the simulated agy loop closes the fake child, so the provider
// phase then fails on a downstream assertion. Keep the real cause to rethrow.
let loopFailure: unknown;

function remainingMs(label: string): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw new Error(`bridge contract deadline exceeded during ${label}`);
  return remaining;
}

async function withinBudget<T>(
  promise: Promise<T>,
  label: string,
  until = deadline,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const remaining = Math.floor(until - performance.now());
    if (remaining <= 0) throw new Error(`bridge contract deadline exceeded during ${label}`);
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`bridge contract deadline exceeded during ${label}`)), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function makeChild(command: string, args: string[]): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  let closed = false;
  child.close = (code = 0, signal = null) => {
    if (closed) return;
    closed = true;
    child.exitCode = code;
    child.signalCode = signal;
    child.stdin.end();
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code, signal);
    children.delete(child);
  };
  child.kill = (signal = "SIGTERM") => {
    child.close(null, signal);
    return true;
  };
  children.add(child);
  simulatedLaunches.push({ command, args });
  return child;
}

async function connectFixtureClient(configDir: string, name: string): Promise<Client> {
  const configPath = path.join(configDir, ".agents", "mcp_config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    mcpServers: Record<string, { serverUrl: string; headers: Record<string, string> }>;
  };
  const server = config.mcpServers["pi-agy-tools"];
  assert.ok(server, "task-owned bridge configuration is missing");
  const client = new Client({ name, version: "1" }, { capabilities: {} });
  clients.add(client);
  const transport = new StreamableHTTPClientTransport(new URL(server.serverUrl), {
    requestInit: { headers: server.headers },
  });
  await withinBudget(client.connect(transport), `${name} initialize`);
  return client;
}

async function simulateAgyToolLoop(child: FakeChild, args: string[]): Promise<void> {
  const configDir = args.flatMap((arg, index) => arg === "--add-dir" ? [args[index + 1]] : [])
    .find((candidate) => candidate && candidate.startsWith(path.join(agentDir, "pi-agy-bridge")));
  assert.ok(configDir, "the real provider runner did not pass its private bridge directory");

  const clientA = await connectFixtureClient(configDir, "agy-contract-client-a");
  const listedA = await withinBudget(clientA.listTools(), "client A tools/list");
  observedLists.push(listedA.tools.map((tool) => tool.name));
  assert.equal(listedA.tools.length, 6, "expected five bridge builtins plus the selected Pi tool");
  const dynamicA = listedA.tools.filter((tool) => tool.name === "diagnostic_marker");
  assert.equal(dynamicA.length, 1);
  assert.deepEqual(dynamicA[0]?.inputSchema, {
    type: "object",
    properties: { marker: { type: "string" } },
    required: ["marker"],
  });
  observedSchemas.push(dynamicA[0]?.inputSchema);
  assert.ok(!listedA.tools.some((tool) => tool.name === "askantigravity"));

  // This is the only simulated agy tool invocation. Its arguments and result
  // are fixture constants; no user's tool implementation is called.
  const called = await withinBudget(
    clientA.callTool({ name: "diagnostic_marker", arguments: { marker: "fixture" } }),
    "synthetic marker call",
  );
  const toolResult = called as unknown as { content: Array<{ type: string; text?: string }> };
  firstToolResult = toolResult.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  assert.match(firstToolResult, /bridge-contract-ok/);
  await withinBudget(clientA.close(), "client A close");
  clients.delete(clientA);

  // A second independent transport session must initialize on the same bridge.
  const clientB = await connectFixtureClient(configDir, "agy-contract-client-b");
  const listedB = await withinBudget(clientB.listTools(), "client B tools/list");
  observedLists.push(listedB.tools.map((tool) => tool.name));
  const dynamicB = listedB.tools.filter((tool) => tool.name === "diagnostic_marker");
  assert.equal(dynamicB.length, 1);
  assert.deepEqual(dynamicB[0]?.inputSchema, observedSchemas[0]);
  assert.equal(listedB.tools.length, 6);
  await withinBudget(clientB.close(), "client B close");
  clients.delete(clientB);

  child.stdout.write(JSON.stringify({
    event: "result",
    result: { status: "SUCCESS", response: "bridge-contract-ok", conversation_id: "fixture-conversation" },
  }) + "\n");
}

const cp = createRequire(import.meta.url)("node:child_process") as Record<string, (...args: unknown[]) => unknown>;
const stubs: Array<{ restore: () => void }> = [];

try {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  process.chdir(workspace);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const spawnStub = mock.method(cp, "spawn", ((command: string, rawArgs: readonly string[]) => {
    if (command !== "agy") {
      forbiddenLaunches.push(`spawn:${command}`);
      throw new Error(`unexpected process launch: ${command}`);
    }
    const args = [...rawArgs];
    const child = makeChild(command, args);
    if (args[0] === "models") {
      queueMicrotask(() => {
        child.stdout.end("gemini-3.8-flash-medium\tFixture model\n");
        child.close(0);
      });
      return child;
    }
    if (!args.includes("--input-format") || !args.includes("stream-json")) {
      forbiddenLaunches.push(`agy:${args.join(" ")}`);
      throw new Error("unexpected agy launch shape in bridge contract fixture");
    }
    child.stdout.write('{"event":"init","init":{"model":"fixture"}}\n');
    let input = "";
    child.stdin.on("data", (chunk: Buffer) => {
      input += chunk.toString("utf8");
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      const event = JSON.parse(line) as { event?: string; message?: { content?: string } };
      if (event.event !== "user" || typeof event.message?.content !== "string") {
        forbiddenLaunches.push("unexpected-driver-input");
        child.close(1);
        return;
      }
      void simulateAgyToolLoop(child, args).catch((error) => {
        loopFailure = error;
        child.stderr.write(String(error));
        console.error(error);
        child.close(1);
      });
    });
    return child;
  }) as typeof cp.spawn);
  stubs.push({ restore: () => spawnStub.mock.restore() });

  for (const name of ["exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"]) {
    const stub = mock.method(cp, name, (...args: unknown[]) => {
      forbiddenLaunches.push(`${name}:${String(args[0] ?? "")}`);
      throw new Error(`forbidden OS process API called: ${name}`);
    });
    stubs.push({ restore: () => stub.mock.restore() });
  }

  const { default: piAgyExtension } = await import("../extensions/index.js");
  const pi = {
    registerCommand() {},
    registerTool() {},
    registerProvider(value: Provider) { provider = value; },
  };
  piAgyExtension(pi as unknown as ExtensionAPI);
  assert.ok(provider, "provider registration did not occur");

  await withinBudget(provider.refreshModels!({
    allowNetwork: true,
    signal: controller.signal,
    publish: async ({ update }) => { update?.(); return true; },
  }), "catalog refresh");
  const model = provider.getModels()[0];
  assert.ok(model, "fixture catalog did not register a model");

  const markerTool = {
    name: "diagnostic_marker",
    description: "Task-owned no-op marker tool used only by the isolated contract gate.",
    parameters: Type.Object({ marker: Type.String() }),
  };
  const selfTool = {
    name: "askantigravity",
    description: "Self-delegation tool excluded from the provider bridge.",
    parameters: Type.Object({ prompt: Type.String() }),
  };
  const initialMessages = [
    { role: "system", content: "isolated contract fixture", timestamp: 0, toolsAdded: [markerTool, selfTool] },
    { role: "user", content: "invoke only the fixed marker fixture", timestamp: 1 },
  ];
  const first = await withinBudget(
    provider.streamSimple(model, { messages: initialMessages } as never, { signal: controller.signal } as never).result(),
    "first provider phase",
  );
  if (loopFailure) throw loopFailure;
  assert.equal(first.stopReason, "toolUse");
  const toolCall = first.content.find((block) => block.type === "toolCall") as
    | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
    | undefined;
  assert.ok(toolCall, "provider did not produce the parked synthetic tool call");
  assert.equal(toolCall.name, "diagnostic_marker");
  assert.deepEqual(toolCall.arguments, { marker: "fixture" });

  // Execute only a fixed fixture function, then deliver its constant marker
  // through the normal Pi transcript resume adapter.
  const markerResult = (args: Record<string, unknown>): string => {
    assert.deepEqual(args, { marker: "fixture" });
    return "bridge-contract-ok";
  };
  const delivered = markerResult(toolCall.arguments);
  const resumedMessages = [
    ...initialMessages,
    { role: "assistant", content: [toolCall] },
    { role: "toolResult", toolCallId: toolCall.id, toolName: toolCall.name, content: delivered, isError: false },
    { role: "user", content: "finish the fixture", timestamp: 2 },
  ];
  const final = await withinBudget(
    provider.streamSimple(model, { messages: resumedMessages } as never, { signal: controller.signal } as never).result(),
    "resumed provider phase",
  );
  assert.equal(final.stopReason, "stop");
  assert.ok(JSON.stringify(final.content).includes("bridge-contract-ok"));
  assert.equal(firstToolResult, "bridge-contract-ok");
  assert.equal(observedLists.length, 2);
  assert.deepEqual(observedLists[0], observedLists[1]);
  assert.equal(forbiddenLaunches.length, 0, `unexpected launch/API use: ${forbiddenLaunches.join(", ")}`);
  assert.ok(simulatedLaunches.every((launch) => launch.command === "agy"));
  console.log("bridge contract verified (synthetic local integration; no agy process or inference launched)");
} finally {
  controller.abort();
  const cleanupErrors: string[] = [];
  for (const client of [...clients]) {
    try {
      await withinBudget(client.close(), "owned MCP client close", cleanupDeadline);
      clients.delete(client);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    const { closeProviderDrivers } = await import("../extensions/lib/provider.js");
    await withinBudget(closeProviderDrivers(), "owned provider/bridge shutdown", cleanupDeadline);
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
  for (const child of [...children]) child.kill("SIGTERM");
  if (children.size !== 0) cleanupErrors.push(`${children.size} in-memory child fixture(s) remain`);
  for (const stub of stubs.reverse()) stub.restore();
  process.chdir(previousCwd);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(fixtureRoot, { recursive: true, force: true });
  if (cleanupErrors.length > 0) {
    throw new Error(`bridge contract cleanup failed: ${cleanupErrors.join("; ")}`);
  }
}
