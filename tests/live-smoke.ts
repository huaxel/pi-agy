import assert from "node:assert/strict";
import * as path from "node:path";

import {
  AGY_MODEL_ALIASES,
  checkAgyUsage,
  inspectAgyAgents,
  inspectAgyModelIds,
  inspectAgyModels,
  inspectAgyVersion,
} from "../extensions/lib/cli.js";
import { runAgyDoctor } from "../extensions/lib/doctor.js";

const cwd = path.resolve(process.argv[2] ?? process.cwd());
// Generous: four parallel cold agy spawns can serialize behind one OAuth
// refresh and blow past tighter caps on first run.
const timeoutMs = 60_000;

// Every probe is read-only. In particular, /usage is the guarded zero-token
// print-mode command; this script never submits an inference task.
const [version, models, roster, agents, usage] = await Promise.all([
  inspectAgyVersion(cwd, undefined, timeoutMs),
  inspectAgyModels(cwd, undefined, timeoutMs),
  inspectAgyModelIds(cwd, undefined, timeoutMs),
  inspectAgyAgents(cwd, undefined, timeoutMs),
  checkAgyUsage(cwd, undefined, timeoutMs),
]);

assert.ok(version, "agy did not report a version");
assert.ok(Object.keys(models).length > 0, "agy models resolved no aliases");
// The invariant is that resolution never invents an id: every alias must map to
// a model the CLI actually serves. An alias the vendor retired (e.g. a dropped
// pro tier) is simply unresolved, which is correct and reported below.
const served = new Set<string>(roster);
for (const alias of AGY_MODEL_ALIASES) {
  const id = models[alias];
  if (id === undefined) continue;
  assert.ok(served.has(id), `alias ${alias} resolved to unserved id ${id}`);
}
const unresolved = AGY_MODEL_ALIASES.filter((alias) => models[alias] === undefined);
assert.ok(Array.isArray(agents), "agy agents did not return a roster");
assert.ok(usage, "agy /usage returned no recognized snapshot");
assert.equal(usage.error, undefined, `agy /usage failed: ${usage.error}`);
assert.ok(usage.models.length > 0, "agy /usage returned no recognized quota windows");

const doctor = await runAgyDoctor(cwd);
for (const name of ["CLI", "Models", "Custom agents", "Quota"]) {
  assert.ok(doctor.checks.some((check) => check.name === name), `doctor omitted ${name}`);
}
assert.equal(
  doctor.checks.find((check) => check.name === "CLI")?.status,
  "ok",
  "doctor CLI check failed",
);
assert.equal(
  doctor.checks.find((check) => check.name === "Models")?.status,
  "ok",
  "doctor model check failed",
);

console.log(
  JSON.stringify(
    {
      version,
      models,
      unresolvedAliases: unresolved,
      agentCount: agents.length,
      quotaWindows: usage.models.length,
      doctorStatus: doctor.status,
      doctorChecks: doctor.checks.map(({ name, status }) => ({ name, status })),
    },
    null,
    2,
  ),
);
