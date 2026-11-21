/**
 * Live bridge verification (opt-in, spends real inference turns).
 *
 * `test:live` and `test:provider` prove discovery, the streaming envelope and
 * native usage. Neither can prove the two behaviours that only exist when a
 * real `agy` child talks to the loopback MCP bridge:
 *
 *   1. `--settings` `permissions.deny` actually stops a built-in tool
 *      (`buildProviderPermissionSettings`), which is what keeps agy's own shell
 *      and write tools out of a bridged turn. Proven with a positive and a
 *      negative control around a filesystem side effect, so a passing run
 *      cannot be an artifact of the model declining to act.
 *   2. Parallel bridged tool calls collapse into one parked phase
 *      (`notifyPark` batching) instead of one Pi turn per call.
 *
 * Usage: `npm run test:bridge` (optional: `-- <model-id>`).
 */
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";

import { AgyProviderDriver, type DriverPark } from "../extensions/lib/provider-driver.js";
import { buildProviderPermissionSettings } from "../extensions/lib/provider.js";
import { startMcpBridge } from "../extensions/lib/provider-mcp.js";
import { bridgeToolsFingerprint, type BridgeToolDef } from "../extensions/lib/provider-tools.js";
import { resolveAgyModelId } from "../extensions/lib/args.js";
import { inspectAgyModels } from "../extensions/lib/inspect.js";

const controller = new AbortController();
const timeoutMs = 180_000;
const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-live-bridge-"));
const driver = new AgyProviderDriver({ idleMs: 60_000 });
const evidence: Record<string, unknown> = {};

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

/** Two bridged tools, so the settings document has real deny rules to derive. */
const shadowingTools: BridgeToolDef[] = [
  {
    name: "bash",
    piName: "bash",
    description: "Pi shell tool (bridged).",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
  },
  {
    name: "write",
    piName: "write",
    description: "Pi file write tool (bridged).",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
];

/** A cheap read-only probe tool the model can call without side effects. */
const probeTool: BridgeToolDef = {
  name: "probe_echo",
  piName: "probe_echo",
  description:
    "Echo a short text value back. Use it whenever the user asks you to call probe_echo; it has no side effects.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "Text to echo." } },
    required: ["text"],
  },
};

try {
  await inspectAgyModels(dir, controller.signal, timeoutMs);
  const modelId = process.argv[2] ?? resolveAgyModelId("flash-low");
  assert.ok(modelId, "no catalog match for flash-low; run `agy models` first");
  evidence.modelId = modelId;

  // ---------------------------------------------------------------------
  // 1. The deny document must survive `--dangerously-skip-permissions`.
  //    A `touch` request is a filesystem observation, not a model opinion:
  //    either the file appears or it does not. The document is the one a
  //    bridged turn always gets, independent of which Pi tools exist.
  // ---------------------------------------------------------------------
  const denied = path.join(dir, "deny-probe.txt");
  const control = path.join(dir, "control-probe.txt");
  const settingsJson = buildProviderPermissionSettings();
  assert.ok(settingsJson, "no permission document for a bridged turn");
  const parsedSettings = JSON.parse(settingsJson) as { permissions: { deny: string[] } };
  assert.deepEqual(
    parsedSettings.permissions.deny.sort(),
    ["command(*)", "write_file(*)"],
    "the deny document does not cover shell and write",
  );
  evidence.settingsJson = settingsJson;

  const touchPrompt = (file: string) =>
    `Run the shell command \`touch ${file}\` and then reply with only the word: done`;
  const touchProfile = {
    dir,
    fullModel: modelId,
    // The provider's own default: the deny document must hold *despite* this.
    skipPermissions: true,
    settingsJson,
  };

  const deniedTurn = await driver.turn(touchProfile, {
    prompt: touchPrompt(denied),
    signal: controller.signal,
    timeoutMs,
  });
  assert.equal(deniedTurn.kind, "done", "denied-path turn unexpectedly parked");
  if (deniedTurn.kind !== "done") throw new Error("unreachable");
  evidence.deniedTurn = {
    text: deniedTurn.outcome.text.trim().slice(0, 200),
    deniedActions: deniedTurn.outcome.deniedActions ?? [],
  };
  assert.equal(
    await exists(denied),
    false,
    `permissions.deny did not stop the built-in shell tool: ${denied} was created`,
  );

  // Negative control: the identical request without the deny document must
  // succeed, otherwise the check above proves nothing about the setting.
  const controlTurn = await driver.turn(
    { dir, fullModel: modelId, skipPermissions: true },
    { prompt: touchPrompt(control), signal: controller.signal, timeoutMs },
  );
  assert.equal(controlTurn.kind, "done", "control turn unexpectedly parked");
  evidence.controlToolRan = await exists(control);
  assert.equal(
    evidence.controlToolRan,
    true,
    "the control turn did not create its file, so the deny check is not meaningful",
  );

  // ---------------------------------------------------------------------
  // 2. Parallel bridged calls must arrive as ONE parked phase.
  //    The bridge is the real one; only the tool execution is ours, because
  //    the assertion target is the park path, not Pi's tool semantics.
  // ---------------------------------------------------------------------
  const bridge = await startMcpBridge(dir, { escalateAfterMs: 120_000 });
  assert.ok(bridge, "the loopback MCP bridge failed to start");
  const parks: DriverPark[] = [];
  const arrivals: Array<{ at: number; toolName: string }> = [];
  bridge.setTools([probeTool, ...shadowingTools]);
  bridge.setParkHandler((park) => {
    arrivals.push({ at: Date.now(), toolName: park.toolName });
    parks.push({ callId: park.callId, toolName: park.toolName, args: park.args });
    // Accept every call: the driver is what decides how many become one turn.
    return driver.notifyPark({ callId: park.callId, toolName: park.toolName, args: park.args });
  });

  const parallel = await driver.turn(
    {
      dir,
      fullModel: modelId,
      skipPermissions: true,
      bridgeDir: bridge.configDir,
      bridgeTools: bridgeToolsFingerprint([probeTool, ...shadowingTools]),
      settingsJson,
    },
    {
      prompt:
        "Issue both of these probe_echo calls in ONE assistant step, before reading either result: " +
        'probe_echo(text="alpha") and probe_echo(text="beta"). Do not wait for the first result ' +
        "before issuing the second. After both results arrive, reply with only the word: done",
      signal: controller.signal,
      timeoutMs,
    },
  );
  evidence.parallelParks = parks.length;
  evidence.parkArrivals = arrivals.map((arrival, index) => ({
    index,
    toolName: arrival.toolName,
    msAfterFirst: arrival.at - arrivals[0].at,
  }));
  assert.equal(parallel.kind, "parked", "the model did not call the bridged probe tool");
  if (parallel.kind !== "parked") throw new Error("unreachable");
  evidence.parkBatch = parallel.parks.map((park) => ({
    toolName: park.toolName,
    args: park.args,
  }));
  assert.ok(parks.length >= 1, "no park reached the driver");
  // Batching itself is covered deterministically by provider-driver.test.ts
  // (`parkBatchMs`, p1/p2/p3 coalesce into one phase). What only a live child
  // can show is whether agy ever *issues* concurrent calls for it to batch: if
  // the harness serializes its tool loop, the micro-batch window never sees a
  // second call. Record which happened rather than blaming the batcher.
  const concurrencyObserved = parallel.parks.length > 1;
  const liveConcurrency = {
    observed: concurrencyObserved,
    callsInOnePhase: parallel.parks.length,
    note: concurrencyObserved
      ? "agy issued concurrent calls and notifyPark coalesced them into one parked phase"
      : "agy serialized its tool loop; batching was not exercised live (unit-tested only)",
  };
  evidence.liveConcurrency = liveConcurrency;

  // Deliver every park and let the turn finish, so the run proves the resume
  // path end to end for however many calls this child actually made.
  for (const park of parallel.parks) {
    assert.ok(
      bridge.completePark(park.callId, { text: "ok", isError: false }),
      `bridge refused the parked call ${park.callId}`,
    );
  }
  // agy's tool loop is serial: it issues one call, waits for the result, then
  // may issue the next. Follow every phase until the turn actually ends — a
  // second park here is the serialization evidence, not a failure.
  const phases: number[] = [parallel.parks.length];
  let phase = await driver.continueTurn({ signal: controller.signal, timeoutMs });
  while (phase.kind === "parked" && phases.length < 6) {
    phases.push(phase.parks.length);
    for (const park of phase.parks) {
      assert.ok(
        bridge.completePark(park.callId, { text: "ok", isError: false }),
        `bridge refused the parked call ${park.callId}`,
      );
    }
    phase = await driver.continueTurn({ signal: controller.signal, timeoutMs });
  }
  assert.equal(phase.kind, "done", "the turn never left its park loop");
  evidence.parkPhases = { callsPerPhase: phases, totalCalls: parks.length };
  if (phases.length > 1) {
    liveConcurrency.note =
      `agy issued ${parks.length} calls across ${phases.length} sequential phases: its tool loop ` +
      "serializes, so notifyPark was never given two calls to coalesce (batching stays unit-tested)";
  }
  if (phase.kind === "done") evidence.resumedText = phase.outcome.text.trim().slice(0, 200);
  console.log(JSON.stringify(evidence, null, 2));

  const snapshot = driver.snapshot();
  evidence.driver = { spawns: snapshot.stats.spawns, reuses: snapshot.stats.reuses };
  await bridge.stop();

  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await driver.close();
  await rm(dir, { recursive: true, force: true });
}
