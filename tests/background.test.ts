import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { BackgroundTaskRunner } from "../extensions/lib/background.js";
import piAgyExtension, { getBackgroundRunner } from "../extensions/index.js";
import { resetPreflightCache } from "../extensions/lib/preflight.js";
import { withFakeAgy } from "./helpers.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForTerminal(runner: BackgroundTaskRunner, handle: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (runner.get(handle)?.state !== "running") return;
    await settle();
  }
  throw new Error(`background task '${handle}' did not settle`);
}

describe("background task runner", () => {
  it("runs detached and collects the outcome", async () => {
    const runner = new BackgroundTaskRunner();
    const gate = deferred<{ text: string }>();
    const dir = await tempDir("pi-agy-bg-");
    const handle = runner.start({
      dir,
      summary: "do work",
      model: "flash-medium",
      timeoutMs: 30_000,
      run: () => gate.promise,
    });
    assert.match(handle, /^agybg-[0-9a-f]+$/);
    assert.equal(runner.get(handle)?.state, "running");
    assert.equal(runner.list(dir).length, 1);
    assert.equal(runner.list(await tempDir("pi-agy-bg-other-")).length, 0);
    gate.resolve({ text: "finished work" });
    await settle();
    const collected = runner.collect(handle);
    assert.equal(collected.state, "done");
    assert.equal(collected.text, "finished work");
    assert.equal(runner.get(handle), undefined);
  });

  it("collect requires terminal state and known handles", async () => {
    const runner = new BackgroundTaskRunner();
    const gate = deferred<{ text: string }>();
    const dir = await tempDir("pi-agy-bg-");
    const handle = runner.start({ dir, summary: "work", timeoutMs: 30_000, run: () => gate.promise });
    assert.throws(() => runner.collect(handle), /still running/);
    assert.throws(() => runner.collect("agybg-nope"), /unknown background task/);
    assert.equal(runner.cancel("agybg-nope"), false);
    gate.resolve({ text: "ok" });
    await settle();
    runner.collect(handle);
  });

  it("records failures with messages", async () => {
    const runner = new BackgroundTaskRunner();
    const dir = await tempDir("pi-agy-bg-");
    const handle = runner.start({
      dir,
      summary: "work",
      timeoutMs: 30_000,
      run: async () => {
        throw new Error("boom happened");
      },
    });
    await settle();
    const collected = runner.collect(handle);
    assert.equal(collected.state, "error");
    assert.match(collected.error ?? "", /boom happened/);
  });

  it("times out hanging runs", async () => {
    const runner = new BackgroundTaskRunner();
    const dir = await tempDir("pi-agy-bg-");
    const handle = runner.start({
      dir,
      summary: "work",
      timeoutMs: 300,
      run: ({ signal }) =>
        new Promise<{ text: string }>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted by manager")), { once: true });
        }),
    });
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await settle();
    const collected = runner.collect(handle);
    assert.equal(collected.state, "timeout");
    assert.ok(Date.now() - started < 10_000);
  });

  it("cancels running tasks", async () => {
    const runner = new BackgroundTaskRunner();
    const dir = await tempDir("pi-agy-bg-");
    let aborted = false;
    const handle = runner.start({
      dir,
      summary: "work",
      timeoutMs: 30_000,
      run: ({ signal }) =>
        new Promise<{ text: string }>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("agy was cancelled"));
            },
            { once: true },
          );
        }),
    });
    assert.equal(runner.cancel(handle), true);
    await settle();
    assert.equal(runner.cancel(handle), false);
    const collected = runner.collect(handle);
    assert.equal(collected.state, "cancelled");
    assert.equal(aborted, true);
  });

  it("bounds progress lines", async () => {
    const runner = new BackgroundTaskRunner();
    const dir = await tempDir("pi-agy-bg-");
    const handle = runner.start({
      dir,
      summary: "work",
      timeoutMs: 30_000,
      run: async ({ onProgress }) => {
        for (let i = 0; i < 30; i++) onProgress(`line ${i}`);
        return { text: "ok" };
      },
    });
    await settle();
    const collected = runner.collect(handle);
    assert.equal(collected.progress.length, 20);
    assert.equal(collected.progress[19], "line 29");
  });

  it("keeps uncollected records instead of evicting them", async () => {
    const runner = new BackgroundTaskRunner({ maxTasks: 2 });
    const dir = await tempDir("pi-agy-bg-");
    const first = runner.start({
      dir,
      summary: "one",
      timeoutMs: 30_000,
      run: async () => ({ text: "one" }),
    });
    await waitForTerminal(runner, first);
    runner.start({
      dir,
      summary: "two",
      timeoutMs: 30_000,
      run: async () => ({ text: "two" }),
    });
    assert.throws(
      () => runner.start({ dir, summary: "three", timeoutMs: 30_000, run: async () => ({ text: "x" }) }),
      /collect finished tasks first/,
    );
    // Nothing was evicted behind our back: the payload still collects.
    assert.equal(runner.collect(first).text, "one");
  });

  it("refuses new tasks when full of live runs", async () => {
    const runner = new BackgroundTaskRunner({ maxTasks: 1 });
    const dir = await tempDir("pi-agy-bg-");
    const gate = deferred<{ text: string }>();
    runner.start({ dir, summary: "one", timeoutMs: 30_000, run: () => gate.promise });
    assert.throws(
      () => runner.start({ dir, summary: "two", timeoutMs: 30_000, run: async () => ({ text: "x" }) }),
      /cancel running tasks first/,
    );
    gate.resolve({ text: "one" });
    await settle();
    runner.collect(runner.list(dir)[0].handle);
  });

  it("reports cancelled even when the timeout fires during teardown", async () => {
    const runner = new BackgroundTaskRunner();
    const dir = await tempDir("pi-agy-bg-");
    const handle = runner.start({
      dir,
      summary: "work",
      timeoutMs: 400,
      run: ({ signal }) =>
        new Promise<{ text: string }>((_resolve, reject) => {
          // Settle just after the timeout fires: the earlier cancel wins.
          signal.addEventListener("abort", () => setTimeout(() => reject(new Error("torn down")), 300), {
            once: true,
          });
        }),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(runner.cancel(handle), true);
    // Teardown settles 300ms after the abort; the 400ms timeout must not
    // overwrite the earlier cancel.
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(runner.collect(handle).state, "cancelled");
  });

  it("shutdown aborts running tasks", async () => {
    const runner = new BackgroundTaskRunner();
    const dir = await tempDir("pi-agy-bg-");
    const gate = deferred<{ text: string }>();
    const handle = runner.start({
      dir,
      summary: "work",
      timeoutMs: 60_000,
      run: ({ signal }) => {
        signal.addEventListener("abort", () => gate.reject(new Error("aborted")), { once: true });
        return gate.promise;
      },
    });
    await runner.shutdown();
    const collected = runner.collect(handle);
    assert.equal(collected.state, "cancelled");
  });

  it("shutdown never hangs on abort-ignoring runners", async () => {
    const runner = new BackgroundTaskRunner({ shutdownTimeoutMs: 400 });
    const dir = await tempDir("pi-agy-bg-");
    runner.start({
      dir,
      summary: "stubborn",
      timeoutMs: 60_000,
      run: () => new Promise<{ text: string }>(() => undefined),
    });
    const started = Date.now();
    await runner.shutdown();
    assert.ok(Date.now() - started < 10_000, "shutdown hung on an abort-ignoring runner");
  });
});

interface CapturedTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
}

function captureTools(): { tools: CapturedTool[] } {
  const tools: CapturedTool[] = [];
  const fakePi = {
    registerCommand: () => {},
    registerTool: (tool: CapturedTool) => {
      tools.push(tool);
    },
  };
  piAgyExtension(fakePi as unknown as ExtensionAPI);
  return { tools };
}

function findTool(tools: CapturedTool[], name: string): CapturedTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool: ${name}`);
  return tool!;
}

describe("background tools", () => {
  it("detaches, polls, and collects through agy_tasks", async () => {
    const raw =
      JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", response: "background done", conversation_id: "conv-bg" },
      }) + "\n";
    await withFakeAgy(raw, async () => {
      resetPreflightCache();
      const { tools } = captureTools();
      const executeTool = findTool(tools, "agy_execute");
      const tasksTool = findTool(tools, "agy_tasks");
      const workDir = await tempDir("pi-agy-bg-work-");
      const agentDir = await tempDir("pi-agy-bg-agent-");
      const previousDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        const ctx = { cwd: workDir } as unknown as Parameters<CapturedTool["execute"]>[4];
        const started = await executeTool.execute(
          "call-1",
          { prompt: "background job", mode: "plan", background: true },
          new AbortController().signal,
          undefined,
          ctx,
        );
        const handle = started.details.handle as string;
        assert.match(handle, /^agybg-/);
        // Returns while the run is still in flight (or just finished).
        const status = await tasksTool.execute(
          "call-2",
          { action: "status", handle },
          new AbortController().signal,
          undefined,
          ctx,
        );
        assert.ok(["running", "done"].includes(status.details.task.state));
        // Wait for terminal settlement, then collect.
        let terminal: { state: string } | undefined;
        for (let i = 0; i < 100; i++) {
          const current = await tasksTool.execute(
            "call-3",
            { action: "status", handle },
            new AbortController().signal,
            undefined,
            ctx,
          );
          if (current.details.task.state !== "running") {
            terminal = current.details.task;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.equal(terminal?.state, "done");
        const collected = await tasksTool.execute(
          "call-4",
          { action: "collect", handle },
          new AbortController().signal,
          undefined,
          ctx,
        );
        assert.match(collected.content[0].text, /background done/);
        assert.equal(collected.details.task.conversationId, "conv-bg");
        const listed = await tasksTool.execute(
          "call-5",
          { action: "list", dir: workDir },
          new AbortController().signal,
          undefined,
          ctx,
        );
        assert.deepEqual(listed.details.tasks, []);
      } finally {
        if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousDir;
        await getBackgroundRunner().shutdown();
      }
    });
  });

  it("keeps full payloads out of list and status details", async () => {
    const raw =
      JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", response: "payload-data", conversation_id: "conv-trim" },
      }) + "\n";
    await withFakeAgy(raw, async () => {
      resetPreflightCache();
      const tools: CapturedTool[] = [];
      piAgyExtension({
        registerCommand: () => {},
        registerTool: (tool: CapturedTool) => {
          tools.push(tool);
        },
      } as unknown as ExtensionAPI);
      const executeTool = findTool(tools, "agy_execute");
      const tasksTool = findTool(tools, "agy_tasks");
      const workDir = await tempDir("pi-agy-bg-trim-");
      const ctx = { cwd: workDir } as unknown as Parameters<CapturedTool["execute"]>[4];
      const started = await executeTool.execute(
        "call-1",
        { prompt: "trim job", mode: "plan", background: true },
        new AbortController().signal,
        undefined,
        ctx,
      );
      const handle = started.details.handle as string;
      for (let i = 0; i < 50; i++) {
        const current = await tasksTool.execute(
          "call-2",
          { action: "status", handle },
          new AbortController().signal,
          undefined,
          ctx,
        );
        if (current.details.task.state !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const listed = await tasksTool.execute(
        "call-3",
        { action: "list", dir: workDir },
        new AbortController().signal,
        undefined,
        ctx,
      );
      assert.equal(listed.details.tasks.length, 1);
      assert.equal("text" in listed.details.tasks[0], false);
      assert.equal("details" in listed.details.tasks[0], false);
      const status = await tasksTool.execute(
        "call-4",
        { action: "status", handle },
        new AbortController().signal,
        undefined,
        ctx,
      );
      assert.equal("text" in status.details.task, false);
      const collected = await tasksTool.execute(
        "call-5",
        { action: "collect", handle },
        new AbortController().signal,
        undefined,
        ctx,
      );
      assert.match(collected.content[0].text, /payload-data/);
      await getBackgroundRunner().shutdown();
    });
  });

  it("reports unknown handles and cancels live tasks", async () => {
    const { tools } = captureTools();
    const tasksTool = findTool(tools, "agy_tasks");
    const workDir = await tempDir("pi-agy-bg-work-");
    const ctx = { cwd: workDir } as unknown as Parameters<CapturedTool["execute"]>[4];
    await assert.rejects(
      tasksTool.execute("c", { action: "status", handle: "agybg-nope" }, new AbortController().signal, undefined, ctx),
      /unknown background task/,
    );
    await assert.rejects(
      tasksTool.execute("c", { action: "collect", handle: "agybg-nope" }, new AbortController().signal, undefined, ctx),
      /unknown background task/,
    );
    const listed = await tasksTool.execute(
      "c",
      { action: "list", dir: workDir },
      new AbortController().signal,
      undefined,
      ctx,
    );
    assert.deepEqual(listed.details.tasks, []);
  });
});
