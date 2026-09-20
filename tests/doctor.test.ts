import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { runAgyDoctor } from "../extensions/lib/doctor.js";
import { withFakeAgy } from "./helpers.js";

describe("agy doctor", () => {
  it("reports CLI, models, quota, local state, and the repository gate", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-agy-doctor-project-"));
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-doctor-agent-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
    await writeFile(
      path.join(agentDir, "agy-sessions.json"),
      JSON.stringify({
        [cwd]: {
          history: [
            {
              conversation_id: "doctor-conversation",
              model: "flash-medium",
              updated_at: new Date().toISOString(),
            },
          ],
        },
      }),
    );

    const usage = JSON.stringify({
      groups: [
        {
          name: "Gemini Models",
          buckets: [{ window: "5h", remainingFraction: 0.75 }],
        },
      ],
    });
    await withFakeAgy("", async () => {
      const previousDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        const report = await runAgyDoctor(cwd);
        assert.equal(report.status, "ok");
        assert.match(report.text, /✓ CLI: agy 1\.2\.0/);
        assert.match(report.text, /✓ Models: 1 aliases discovered \(flash-medium\)/);
        assert.match(report.text, /✓ Quota: 1 windows across 1 model groups/);
        assert.match(report.text, /• Config: defaults/);
        assert.match(report.text, /✓ Sessions: 1 recorded for this workspace/);
        assert.match(report.text, /✓ Workspace lock: free/);
        assert.match(report.text, /✓ Verify: npm test/);
      } finally {
        if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousDir;
      }
    }, 0, 0, "", "", usage, 0, "gemini-3.8-flash-medium");
  });

  it("reports exhausted quota as unhealthy", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-agy-doctor-quota-"));
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-doctor-agent-"));
    const usage = JSON.stringify({
      groups: [
        {
          name: "Gemini Models",
          buckets: [{ window: "weekly", remainingFraction: 0, resetAt: "tomorrow" }],
        },
      ],
    });
    await withFakeAgy("", async () => {
      const previousDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        const report = await runAgyDoctor(cwd);
        assert.equal(report.status, "error");
        assert.match(report.text, /✗ Quota: exhausted: Gemini Models weekly; resets tomorrow/);
      } finally {
        if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousDir;
      }
    }, 0, 0, "", "", usage, 0, "gemini-3.8-flash-medium");
  });

  it("warns about invalid config and a corrupt session store", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-agy-doctor-state-"));
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-doctor-agent-"));
    await writeFile(
      path.join(agentDir, "agy-config.json"),
      JSON.stringify({ defaultModel: "not-a-model", skipPermissions: "yes" }),
    );
    await writeFile(path.join(agentDir, "agy-sessions.json"), "{broken");
    const usage = JSON.stringify({
      groups: [{ name: "Gemini Models", buckets: [{ remainingFraction: 0.5 }] }],
    });

    await withFakeAgy("", async () => {
      const previousDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        const report = await runAgyDoctor(cwd);
        assert.equal(report.status, "warn");
        assert.match(report.text, /! Config: .*unknown defaultModel 'not-a-model'/);
        assert.match(report.text, /skipPermissions must be boolean/);
        assert.match(report.text, /! Sessions: .*contains invalid JSON/);
      } finally {
        if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousDir;
      }
    }, 0, 0, "", "", usage, 0, "gemini-3.8-flash-medium");
  });

  it("propagates cancellation instead of reporting environmental failures", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-agy-doctor-cancel-"));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runAgyDoctor(cwd, controller.signal), /agy doctor was cancelled/);
  });

  it("returns an actionable error report when agy is unavailable", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-agy-doctor-missing-"));
    const previousPath = process.env.PATH;
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PATH = cwd;
    process.env.PI_CODING_AGENT_DIR = cwd;
    try {
      const report = await runAgyDoctor(cwd);
      assert.equal(report.status, "error");
      assert.match(report.text, /✗ CLI: Antigravity CLI is not installed/);
      assert.match(report.text, /• Models: skipped because the CLI check failed/);
      assert.match(report.text, /• Quota: skipped because the CLI check failed/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
    }
  });
});
