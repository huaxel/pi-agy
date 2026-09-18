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
  checkAgyUsage,
  findAgyQuotaEntries,
  formatAgyUsage,
  isAgyQuotaExhausted,
  isStableModelId,
  killProcessTree,
  parseAgyUsage,
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
  it("rejects release-candidate ids as unstable", () => {
    assert.ok(!isStableModelId("claude-sonnet-4-6-rc1"));
    assert.ok(!isStableModelId("gemini-3.8-flash-medium-next"));
  });

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

describe("model quota discovery", () => {
  it("normalizes model-specific remaining quota and reset time", () => {
    const snapshot = parseAgyUsage(
      JSON.stringify({
        quotas: [
          {
            model: "gemini-3.8-flash-medium",
            window: "five-hour",
            remainingFraction: 0.25,
            resetTime: "2030-01-02T03:04:05Z",
          },
          {
            model: "gemini-3.8-flash-medium",
            window: "weekly",
            remainingRequests: 12,
            resetTime: 1_900_000_000,
          },
        ],
      }),
    );
    assert.equal(snapshot?.models.length, 2);
    assert.equal(snapshot?.models[0]?.remaining_fraction, 0.25);
    assert.equal(snapshot?.models[0]?.reset_at, "2030-01-02T03:04:05Z");
    assert.equal(snapshot?.models[1]?.remaining_requests, 12);
    const percentSnapshot = parseAgyUsage(
      JSON.stringify({ model: "claude-sonnet-4-6", remainingPercent: 0.5 }),
    );
    assert.equal(percentSnapshot?.models[0]?.remaining_fraction, 0.005);
    assert.match(formatAgyUsage(snapshot, "gemini-3.8-flash-medium") ?? "", /25% remaining/);
    assert.match(formatAgyUsage(snapshot) ?? "", /weekly window/);
    assert.equal(
      findAgyQuotaEntries(snapshot, "gemini-3.8-flash-medium").length,
      2,
    );
    const tiered = parseAgyUsage(
      JSON.stringify([
        { model: "gemini-3.8-flash-low", remainingPercent: 20 },
        { model: "gemini-3.8-flash-high", remainingPercent: 80 },
      ]),
    );
    assert.equal(findAgyQuotaEntries(tiered, "gemini-3.8-flash-medium").length, 0);
    const thinking = parseAgyUsage(
      JSON.stringify({ model: "Claude Sonnet 4.6 (thinking)", remainingPercent: 25 }),
    );
    assert.equal(findAgyQuotaEntries(thinking, "claude-sonnet-4-6").length, 1);
    const labeled = parseAgyUsage(
      JSON.stringify({ label: "Gemini 3.8 Flash", remainingFraction: 0.75 }),
    );
    assert.equal(labeled?.models[0]?.remaining_fraction, 0.75);
    const groupedField = parseAgyUsage(
      JSON.stringify({ group: "GEMINI MODELS", is_exhausted: true, resetsInSeconds: 7_200 }),
    );
    assert.equal(groupedField?.models[0]?.remaining_fraction, 0);
    assert.equal(groupedField?.models[0]?.reset_at, "in 2h");
    const grouped = parseAgyUsage(
      JSON.stringify({ groups: { "GEMINI MODELS": { weekly: { remainingFraction: 0 } } } }),
    );
    assert.equal(findAgyQuotaEntries(grouped, "gemini-3.8-flash-medium").length, 1);
    assert.equal(findAgyQuotaEntries(grouped, "gemini-3.8-flash-medium")[0]?.window, "weekly");
    assert.equal(findAgyQuotaEntries(grouped, "claude-sonnet-4-6").length, 0);
  });

  it("parses the real agy 1.2.6 usage schema (command.data.groups[].buckets)", () => {
    // Verbatim structure from a live agy 1.2.6 `--output-format json -p /usage`
    // run: quota records live under groups whose family name is in `name`.
    const snapshot = parseAgyUsage(
      JSON.stringify({
        conversation_id: "",
        status: "SUCCESS",
        response: "Gemini Models\tWeekly Limit Remaining\t75%\t2026-09-23T04:33:47Z",
        duration_seconds: 0,
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
        command: {
          name: "usage",
          data: {
            description: "Within each group, models share a weekly limit and a 5-hour limit.",
            groups: [
              {
                name: "Gemini Models",
                description: "Models within this group: Gemini Flash, Gemini Pro",
                buckets: [
                  {
                    id: "gemini-weekly",
                    name: "Weekly Limit Remaining",
                    description: "You have used some of your weekly limit.",
                    window: "weekly",
                    remaining_fraction: 0.7515648603439331,
                    reset_time: "2026-09-23T04:33:47Z",
                  },
                  {
                    id: "gemini-5h",
                    name: "Five Hour Limit Remaining",
                    description: "You have used some of your 5-hour limit.",
                    window: "5h",
                    remaining_fraction: 0.5208387970924377,
                    reset_time: "2026-09-18T17:15:07Z",
                  },
                ],
              },
              {
                name: "Claude and GPT models",
                description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
                buckets: [
                  {
                    id: "3p-weekly",
                    name: "Weekly Limit Remaining",
                    description: "You have hit your weekly limit.",
                    window: "weekly",
                    remaining_fraction: 0,
                    reset_time: "2026-09-22T15:41:44Z",
                  },
                  {
                    id: "3p-5h",
                    name: "Five Hour Limit Remaining",
                    description: "The 5-hour limit does not currently apply.",
                    window: "5h",
                    disabled: true,
                    remaining_fraction: 1,
                  },
                ],
              },
            ],
          },
        },
      }),
    );

    // Disabled buckets carry no availability signal and are skipped.
    assert.equal(snapshot?.models.length, 3);
    const gemini = snapshot?.models.filter((entry) => entry.model === "Gemini Models") ?? [];
    assert.equal(gemini.length, 2);
    assert.equal(gemini[0]?.window, "weekly");
    assert.ok(Math.abs((gemini[0]?.remaining_fraction ?? 0) - 0.7516) < 0.0001);
    assert.equal(gemini[0]?.reset_at, "2026-09-23T04:33:47Z");
    assert.equal(gemini[1]?.window, "five-hour");

    const forFlash = findAgyQuotaEntries(snapshot, "gemini-3.8-flash-low");
    assert.equal(forFlash.length, 2);
    assert.ok(!forFlash.some((entry) => isAgyQuotaExhausted(entry)), "flash group is available");
    const forSonnet = findAgyQuotaEntries(snapshot, "claude-sonnet-4-6");
    assert.equal(forSonnet.length, 1);
    assert.ok(forSonnet.some((entry) => isAgyQuotaExhausted(entry)), "claude weekly limit is exhausted");

    const report = formatAgyUsage(snapshot) ?? "";
    assert.match(report, /Gemini Models: weekly window, 75\.2% remaining/);
    assert.match(report, /resets 2026-09-22T15:41:44Z/);
    assert.doesNotMatch(report, /Five Hour Limit Remaining/);
  });

  it("parses quota records from JSONL output", () => {
    const snapshot = parseAgyUsage(
      `diagnostic\n${JSON.stringify({ model: "claude-sonnet-4-6", remainingRequests: 3 })}`,
    );
    assert.equal(snapshot?.models[0]?.remaining_requests, 3);
  });

  it("parses model quotas from plain-text output", () => {
    const snapshot = parseAgyUsage(
      "Gemini 3.8 Flash-medium: 0% remaining (five-hour), resets in 2h\n" +
        "Claude Sonnet 4.6: 12 requests remaining",
    );
    assert.equal(snapshot?.models.length, 2);
    assert.equal(snapshot?.models[0]?.remaining_fraction, 0);
    assert.equal(snapshot?.models[0]?.window, "five-hour");
    assert.equal(snapshot?.models[1]?.remaining_requests, 12);
    const embeddedWindow = parseAgyUsage(
      "Gemini 3.8 Flash-medium (weekly): 10% remaining",
    );
    assert.equal(embeddedWindow?.models[0]?.model, "Gemini 3.8 Flash-medium");
    assert.equal(embeddedWindow?.models[0]?.window, "weekly");
    assert.match(formatAgyUsage(snapshot) ?? "", /resets 2h/);
  });

  it("preserves quota probe failures for diagnostics", () => {
    assert.match(
      formatAgyUsage({ fetched_at: new Date().toISOString(), models: [], error: "unsupported" }) ?? "",
      /quota unavailable: unsupported/,
    );
  });

  it("refuses unsafe usage prompts on older agy versions", async () => {
    const bin = await mkdtemp(path.join(os.tmpdir(), "pi-agy-usage-version-"));
    const agy = path.join(bin, "agy");
    await writeFile(
      agy,
      `#!/usr/bin/env bash
set -eu
if [ "$1" = "--version" ]; then
  echo "agy 1.1.10"
  exit 0
fi
if [ "$2" = "/usage" ]; then
  echo "unsafe usage prompt invoked" >&2
  exit 99
fi
exit 1
`,
    );
    await chmod(agy, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    try {
      const snapshot = await checkAgyUsage(bin);
      assert.match(snapshot?.error ?? "", /requires agy >= 1\.1\.11/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("ignores ordinary run envelopes", () => {
    assert.equal(
      parseAgyUsage(JSON.stringify({ event: "result", result: { response: "done" } })),
      undefined,
    );
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
