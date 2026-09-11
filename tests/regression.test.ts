import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  stat as statFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execAsync = promisify(execFile);

import {
  buildAgyArgs,
  isStableModelId,
  killProcessTree,
  parseModelCatalog,
  resetModelCatalog,
} from "../extensions/lib/cli.js";
import { canonicalDir, withDirLock } from "../extensions/lib/lock.js";
import {
  captureGitBaseline,
  summarizeGitDiffSince,
} from "../extensions/lib/postflight.js";
import { accumulateRunResult } from "../extensions/lib/stream.js";
import { executeAgyTask } from "../extensions/lib/execute.js";
import { resetPreflightCache } from "../extensions/lib/preflight.js";

describe("process tree kill", () => {
  it("kills nested writers so no files change after cancellation", async () => {
    // Process groups are POSIX-only; Windows falls back to direct kill.
    if (process.platform === "win32") return;
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-treekill-"));
    const marker = path.join(dir, "writes.log");
    // A background grandchild appending to a file, with bash waiting
    // foreground — the shape of an agy tool call outliving its parent.
    // Bounded at ~10s so a failure cannot orphan a writer forever.
    const child = spawn("bash", [
      "-c",
      `for i in {1..200}; do echo x >> "${marker}"; sleep 0.05; done & wait`,
    ], { detached: true, stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok((await statFile(marker)).size > 0, "writer never started");
      killProcessTree(child);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("child did not exit after tree kill")),
          5000,
        );
        child.on("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      const sizeAtKill = (await statFile(marker)).size;
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(
        (await statFile(marker)).size,
        sizeAtKill,
        "grandchild kept writing after tree kill",
      );
      // The whole process group must be gone, not just the leader.
      assert.throws(() => process.kill(-child.pid!, 0), /ESRCH/);
    } finally {
      killProcessTree(child);
    }
  });

  it("is a no-op on an already-exited child", () => {
    const fakeChild = {
      exitCode: 0,
      signalCode: null,
      pid: 123456,
      kill: () => true,
    } as unknown as import("node:child_process").ChildProcess;
    assert.doesNotThrow(() => killProcessTree(fakeChild));
  });

  it("cancels a slow agy run via abort", async () => {
    const bin = await mkdtemp(path.join(os.tmpdir(), "pi-agy-cancel-"));
    await writeFile(
      path.join(bin, "agy"),
      `#!/usr/bin/env bash
set -eu
if [ "$1" = "--version" ]; then echo "agy fake"; exit 0; fi
if [ "$1" = "models" ]; then echo "gemini-3.8-flash-medium"; exit 0; fi
sleep 5
echo '{"event":"result","result":{"status":"SUCCESS","response":"late"}}'
`,
    );
    await chmod(path.join(bin, "agy"), 0o755);
    const originalPath = process.env.PATH;
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-cancel-agent-"));
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      resetPreflightCache();
      const controller = new AbortController();
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-cancel-dir-"));
      const pending = executeAgyTask(
        {
          prompt: "cancel me",
          mode: "plan",
          dir,
          timeout_ms: 60_000,
          new_session: true,
          stream: true,
        },
        controller.signal,
      );
      setTimeout(() => controller.abort(), 200);
      await assert.rejects(pending, /cancelled/);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      resetPreflightCache();
    }
  });

  it("times out a slow agy run", async () => {
    const bin = await mkdtemp(path.join(os.tmpdir(), "pi-agy-timeout-"));
    await writeFile(
      path.join(bin, "agy"),
      `#!/usr/bin/env bash
set -eu
if [ "$1" = "--version" ]; then echo "agy fake"; exit 0; fi
if [ "$1" = "models" ]; then echo "gemini-3.8-flash-medium"; exit 0; fi
sleep 5
echo '{"event":"result","result":{"status":"SUCCESS","response":"late"}}'
`,
    );
    await chmod(path.join(bin, "agy"), 0o755);
    const originalPath = process.env.PATH;
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-timeout-agent-"));
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      resetPreflightCache();
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-timeout-dir-"));
      await assert.rejects(
        executeAgyTask(
          {
            prompt: "timeout me",
            mode: "plan",
            dir,
            timeout_ms: 500,
            new_session: true,
            stream: true,
          },
          undefined,
        ),
        /timed out/,
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      resetPreflightCache();
    }
  });
});

describe("model catalog stability", () => {
  it("ignores preview ids unless explicitly allowed", () => {
    const output = [
      "gemini-3.8-flash-medium\tstable",
      "gemini-3.9-flash-medium-preview\tpreview",
      "claude-sonnet-4-6-beta\tbeta",
      "claude-sonnet-4-6\tstable",
    ].join("\n");
    const stable = parseModelCatalog(output);
    assert.equal(stable["flash-medium"], "gemini-3.8-flash-medium");
    assert.equal(stable.sonnet, "claude-sonnet-4-6");
    const preview = parseModelCatalog(output, true);
    assert.equal(preview["flash-medium"], "gemini-3.9-flash-medium-preview");
    assert.ok(!isStableModelId("gemini-3.9-flash-medium-preview"));
    assert.ok(isStableModelId("gemini-3.8-flash-medium"));
    resetModelCatalog();
  });

  it("passes task text without slash expansion", () => {
    const args = buildAgyArgs({
      prompt: "/dangerous --mode evil",
      mode: "plan",
      dir: "/tmp",
      timeout_ms: 60_000,
      stream: true,
    });
    assert.ok(args.includes("--disable-slash-commands"));
    assert.ok(args.includes("/dangerous --mode evil"));
  });
});

describe("stream bounds", () => {
  it("truncates pathological responses", () => {
    const huge = "x".repeat(1_000_005);
    const next = accumulateRunResult(
      { event: "result", result: { response: huge, status: "SUCCESS" } },
      { response: "" },
    );
    assert.ok(next.response.length <= 1_000_100);
    assert.ok(next.response.includes("(response truncated)"));
  });

  it("tolerates malformed JSONL without failing", async () => {
    const bin = await mkdtemp(path.join(os.tmpdir(), "pi-agy-malformed-"));
    await writeFile(
      path.join(bin, "agy"),
      `#!/usr/bin/env bash
set -eu
if [ "$1" = "--version" ]; then echo "agy fake"; exit 0; fi
if [ "$1" = "models" ]; then echo "gemini-3.8-flash-medium"; exit 0; fi
echo 'not json at all'
echo '{"event":"result","result":{"status":"SUCCESS","response":"recovered"}}'
`,
    );
    await chmod(path.join(bin, "agy"), 0o755);
    const originalPath = process.env.PATH;
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-malformed-agent-"));
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      resetPreflightCache();
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-malformed-dir-"));
      const result = await executeAgyTask(
        {
          prompt: "malformed test",
          mode: "plan",
          dir,
          timeout_ms: 30_000,
          new_session: true,
          stream: true,
        },
        undefined,
      );
      assert.equal(result.text, "recovered");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      resetPreflightCache();
    }
  });
});

describe("baseline-aware diff", () => {
  it("attributes only newly-dirty files to agy", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-baseline-"));
    await execAsync("git", ["init"], { cwd: dir });
    await execAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execAsync("git", ["config", "user.name", "test"], { cwd: dir });
    await writeFile(path.join(dir, "base.txt"), "base\n");
    await execAsync("git", ["add", "."], { cwd: dir });
    await execAsync("git", ["commit", "-m", "init"], { cwd: dir });
    await writeFile(path.join(dir, "pre.txt"), "dirty before\n");
    const baseline = await captureGitBaseline(dir);
    assert.ok(baseline.dirtyFiles.size >= 1);
    await writeFile(path.join(dir, "new.txt"), "dirty after\n");
    const diff = await summarizeGitDiffSince(baseline, dir);
    assert.ok(diff.newFiles.includes("new.txt"));
    assert.ok(!diff.newFiles.includes("pre.txt"));
    assert.ok(diff.preexistingFiles.includes("pre.txt"));
  });
});

describe("directory lock canonicalization", () => {
  it("shares one lock across symlinked paths", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-lock-agent-"));
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const real = await mkdtemp(path.join(os.tmpdir(), "pi-agy-real-"));
      const link = path.join(os.tmpdir(), `pi-agy-link-${Date.now()}`);
      await symlink(real, link);
      assert.equal(await canonicalDir(link), await canonicalDir(real));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = false;
      const firstStarted = (async () => {})();
      void firstStarted;
      const running = withDirLock(real, async () => {
        started = true;
        await gate;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(started, true);
      let secondStarted = false;
      const queued = withDirLock(link, async () => {
        secondStarted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(secondStarted, false);
      release();
      await running;
      await queued;
      assert.equal(secondStarted, true);
    } finally {
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    }
  });
});

describe("package artifacts", () => {
  it("ships a license and declares it for packing", async () => {
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    assert.ok((pkg.files as string[]).includes("LICENSE"));
    await readFile(new URL("../LICENSE", import.meta.url), "utf8");
    await readFile(new URL("../tsconfig.json", import.meta.url), "utf8");
  });
});
