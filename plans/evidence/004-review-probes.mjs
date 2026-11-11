// Independent defensive review probes. No inference, real Pi tools, or credentials.
// Run in the executor worktree with its TypeScript resolution hook and a temporary
// HOME/PI_CODING_AGENT_DIR; pass that worktree as argv[2].
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
assert.ok(process.argv[2], "pass the task-owned executor worktree");
const root = path.resolve(process.argv[2]);
for (const name of ["HOME", "PI_CODING_AGENT_DIR"]) {
  assert.ok(process.env[name], `${name} must point into the worktree's ignored .pi directory`);
  const relative = path.relative(path.join(root, ".pi"), path.resolve(process.env[name]));
  assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative), `${name} must remain task-local`);
}
const { startMcpBridge, BRIDGE_TOKEN_HEADER } = await import(pathToFileURL(path.join(root, "extensions/lib/provider-mcp.ts")).href);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded(promise, ms = 2500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("review probe deadline exceeded")), ms); })]); }
  finally { clearTimeout(timer); }
}
async function withBridge(options, run) {
  const h = await startMcpBridge(root, options);
  assert.ok(h, "bridge starts");
  try {
    const cfg = JSON.parse(await readFile(path.join(h.configDir, ".agents/mcp_config.json"), "utf8"));
    const token = Object.values(cfg.mcpServers)[0].headers[BRIDGE_TOKEN_HEADER];
    await run({ h, token });
  } finally { await bounded(h.stop()); }
}
async function request(s, body, sid, method = "POST") {
  const response = await fetch(s.h.url, {
    method,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26", [BRIDGE_TOKEN_HEADER]: s.token, ...(sid ? { "mcp-session-id": sid } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(2500),
  });
  return { status: response.status, sid: response.headers.get("mcp-session-id"), text: await response.text() };
}
const initBody = (id = 1) => ({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "independent-review", version: "1" } } });
async function initialize(s, id = 1) {
  const response = await request(s, initBody(id));
  assert.equal(response.status, 200); assert.ok(response.sid);
  assert.equal((await request(s, { jsonrpc: "2.0", method: "notifications/initialized" }, response.sid)).status, 202);
  return response.sid;
}
const ping = (s, sid) => request(s, { jsonrpc: "2.0", id: 100, method: "ping" }, sid);
const call = (s, sid, name, args = {}) => request(s, { jsonrpc: "2.0", id: 101, method: "tools/call", params: { name, arguments: args } }, sid);
const tool = { name: "review_synthetic", piName: "review_synthetic", description: "Synthetic review response only", inputSchema: { type: "object", properties: {} } };

await withBridge({ sessionCap: 2 }, async (s) => {
  const a = await initialize(s, 1), b = await initialize(s, 2);
  assert.notEqual(a, b);
  assert.equal((await request(s, initBody(3))).status, 503);
  assert.equal((await request(s, undefined, a, "DELETE")).status, 200);
  const c = await initialize(s, 3);
  assert.notEqual(c, a);
  s.h.setTools([tool]);
  const listed = await request(s, { jsonrpc: "2.0", id: 4, method: "tools/list" }, c);
  assert.equal(listed.status, 200); assert.match(listed.text, /review_synthetic/);
  s.h.setParkHandler((park) => { s.h.completePark(park.callId, { text: "after reconnect", isError: false }); return true; });
  assert.match((await call(s, c, tool.name)).text, /after reconnect/);
  assert.equal((await ping(s, "unknown-session")).status, 404);
  console.log("PASS distinct sessions, cap, explicit DELETE, dynamic catalog and completed park after reconnect");
});

await withBridge({ sessionCap: 1, sessionIdleMs: 60, escalateAfterMs: 10 }, async (s) => {
  s.h.setTools([tool]); let callId;
  s.h.setParkHandler((park) => { callId = park.callId; return true; });
  const sid = await initialize(s);
  assert.match((await call(s, sid, tool.name)).text, /STILL RUNNING/);
  assert.ok(callId); await delay(180);
  assert.equal((await ping(s, sid)).status, 200);
  assert.match((await call(s, sid, "bridge_poll_result", { callId })).text, /STILL RUNNING/);
  assert.equal(s.h.completePark(callId, { text: "review final result", isError: false }), true);
  assert.match((await call(s, sid, "bridge_poll_result", { callId })).text, /review final result/);
  await delay(180); assert.equal((await ping(s, sid)).status, 404);
  await initialize(s, 2);
  console.log("PASS raw HTTP park survives early ACK and TTL, final polling works, completed idle slot is reclaimed");
});

for (const kind of ["synchronous", "declined", "throws"]) {
  await withBridge({ sessionCap: 1, sessionIdleMs: 60, escalateAfterMs: 10 }, async (s) => {
    s.h.setTools([tool]);
    s.h.setParkHandler((park) => {
      if (kind === "throws") throw new Error("synthetic refusal");
      if (kind === "declined") return false;
      assert.equal(s.h.completePark(park.callId, { text: "instant final result", isError: false }), true);
      return true;
    });
    const sid = await initialize(s); const result = await call(s, sid, tool.name);
    assert.equal(result.status, 200);
    if (kind === "synchronous") { assert.match(result.text, /instant final result/); assert.doesNotMatch(result.text, /STILL RUNNING/); }
    else assert.match(result.text, /isError/);
    await delay(180); assert.equal((await ping(s, sid)).status, 404);
    await initialize(s, 2);
    console.log(`PASS ${kind} callback releases park ownership and capacity`);
  });
}

await withBridge({ sessionCap: 2, escalateAfterMs: 5000 }, async (s) => {
  const a = await initialize(s, 1); await initialize(s, 2);
  s.h.setTools([tool]); let ready;
  const parked = new Promise((resolve) => { ready = resolve; });
  s.h.setParkHandler(() => { ready(); return true; });
  const pending = call(s, a, tool.name).then(() => "result", () => "connection closed");
  await bounded(parked, 1000);
  await bounded(s.h.stop());
  await bounded(pending);
  console.log("PASS shutdown closes two sessions and settles a pending synthetic park within deadline");
});
console.log("PASS all independent bridge lifecycle probes");
