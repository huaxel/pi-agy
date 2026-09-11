import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat as statFile, utimes, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const execAsync = promisify(execFile);

import {
  buildAgyArgs,
  buildAgyPrompt,
  isAgyModel,
  isTransientAgyFailure,
  parseModelCatalog,
  resetModelCatalog,
  resolveAgyModelId,
  updateModelCatalog,
} from "../extensions/lib/cli.js";
import { resolveAgyMode, truncate } from "../extensions/index.js";
import piAgyExtension from "../extensions/index.js";
import { registerAgyCommand } from "../extensions/commands.js";
import { executeAgyTask } from "../extensions/lib/execute.js";
import { resetPreflightCache } from "../extensions/lib/preflight.js";
import { canonicalDir, getDirLockPath, withDirLock } from "../extensions/lib/lock.js";
import { detectVerifyCommand } from "../extensions/lib/verify.js";
import { summarizeGitDiff } from "../extensions/lib/postflight.js";
import { loadAgyConfig, resetDefaultModelCache, resolveDefaultModel } from "../extensions/lib/config.js";
import {
  accumulateRunResult,
  finalizeRunResult,
  formatStepProgress,
  parseStreamLine,
} from "../extensions/lib/stream.js";
import { parseJsonResponse } from "../extensions/lib/parse.js";
import { parseAgyCommandArgs } from "../extensions/commands.js";
import { createSessionStore, getDefaultStorePath } from "../extensions/lib/sessions.js";
describe("withDirLock", () => {
  it("normalizes equivalent directory paths", async () => {
    let release!: () => void;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const absolute = path.resolve("lock-alias-test");
    const running = withDirLock(absolute, async () => {
      started();
      await first;
    });
    await firstStarted;

    let secondStarted = false;
    const queued = withDirLock("lock-alias-test", async () => {
      secondStarted = true;
    });
    await Promise.resolve();
    assert.equal(secondStarted, false);

    release();
    await running;
    await queued;
    assert.equal(secondStarted, true);
  });

  it("keeps later callers queued after a middle waiter cancels", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const running = withDirLock("cancel-race-test", async () => {
      firstStarted();
      await first;
    });
    await started;

    const controller = new AbortController();
    const cancelled = withDirLock("cancel-race-test", async () => {}, controller.signal);
    controller.abort();
    await assert.rejects(cancelled, /cancelled while waiting/);

    let thirdStarted = false;
    const third = withDirLock("cancel-race-test", async () => {
      thirdStarted = true;
    });
    await Promise.resolve();
    assert.equal(thirdStarted, false);

    releaseFirst();
    await running;
    await third;
    assert.equal(thirdStarted, true);
  });

  it("allows a queued call to cancel without blocking later work", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const running = withDirLock("cancel-test", async () => {
      firstStarted();
      await first;
    });
    await started;

    const controller = new AbortController();
    const cancelled = withDirLock("cancel-test", async () => {}, controller.signal);
    controller.abort();
    await assert.rejects(cancelled, /cancelled while waiting/);

    releaseFirst();
    await running;
    await withDirLock("cancel-test", async () => {});
  });

  it("times out while waiting for a previous run", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const running = withDirLock("deadline-test", async () => {
      firstStarted();
      await first;
    });
    await started;

    await assert.rejects(
      withDirLock("deadline-test", async () => "never", undefined, 50),
      /timed out waiting/,
    );

    releaseFirst();
    await running;
    assert.equal(await withDirLock("deadline-test", async () => "ok"), "ok");
  });

  it("heartbeats a long-held lock so it never looks stale", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-lock-agent-"));
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-heartbeat-"));
      const lockPath = getDirLockPath(await canonicalDir(dir));
      await withDirLock(dir, async () => {
        const acquiredMtime = (await statFile(lockPath)).mtimeMs;
        // Longer than the 5s heartbeat: mtime must advance past acquisition.
        await new Promise((resolve) => setTimeout(resolve, 6000));
        const heldMtime = (await statFile(lockPath)).mtimeMs;
        assert.ok(
          heldMtime - acquiredMtime > 1000,
          `heartbeat did not refresh mtime (delta ${heldMtime - acquiredMtime}ms)`,
        );
      });
    } finally {
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    }
  });

  it("recovers a stale lock from a crashed holder", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-lock-agent-"));
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-stale-"));
      const lockPath = getDirLockPath(await canonicalDir(dir));
      await mkdir(lockPath, { recursive: true });
      await writeFile(path.join(lockPath, "owner"), "dead-process", "utf8");
      const ancient = new Date(Date.now() - 120_000);
      await utimes(lockPath, ancient, ancient);
      assert.equal(await withDirLock(dir, async () => "recovered"), "recovered");
    } finally {
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    }
  });

  it("does not delete a lock stolen while suspended", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-lock-agent-"));
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-owner-"));
      const lockPath = getDirLockPath(await canonicalDir(dir));
      await withDirLock(dir, async () => {
        // Simulate a stale recovery handing our directory to someone else.
        await writeFile(path.join(lockPath, "owner"), "foreign-owner", "utf8");
      });
      assert.equal(await readFile(path.join(lockPath, "owner"), "utf8"), "foreign-owner");
    } finally {
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    }
  });
});

