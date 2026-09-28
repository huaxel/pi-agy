import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  createAgyStreamSimple,
  getProviderRunner,
  renderProviderPrompt,
  resolveProviderTurnModel,
  type AgyEventStream,
  type AgyStreamFactory,
  type ProviderRunEnd,
  type ProviderTranscriptMessage,
  type ProviderTurnRequest,
  type ProviderTurnResult,
  type ProviderTurnRunner,
} from "../extensions/lib/provider.js";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piAgyExtension from "../extensions/index.js";
import { withDirLock } from "../extensions/lib/lock.js";
import { AGY_PROVIDER_ID, closeProviderDrivers } from "../extensions/lib/provider.js";

// runProviderTurn shares persistent driver processes per directory: reset
// between tests so PATH-scoped fakes never cross-talk.
afterEach(async () => {
  await closeProviderDrivers();
});
import { FALLBACK_PROVIDER_MODELS } from "../extensions/lib/provider-models.js";
import { withFakeAgy } from "./helpers.js";

/** Run with an isolated agent dir so session-store reads/writes never touch the real store. */
async function withIsolatedAgentDir<T>(fn: () => Promise<T>): Promise<T> {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-provider-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await fn();
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
  }
}

function createRecordingFactory(): AgyStreamFactory & { events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  const stream: AgyEventStream = {
    push: (event) => {
      events.push(event);
    },
    end: () => {
      events.push({ type: "__end" });
    },
  };
  return {
    events,
    createStream: () => stream,
    getSystemPrompt: () => "Be helpful.",
  };
}



/** Unwrap a default-runner end, asserting terminal done. */
async function expectRunResult(end: Promise<ProviderRunEnd>): Promise<ProviderTurnResult> {
  const resolved = await end;
  assert.equal(resolved.kind, "done");
  if (resolved.kind !== "done") throw new Error("expected done");
  return resolved.result;
}

/** Wrap a one-shot function into a runner object (done-only, no parking). */
function makeStaticRunner(
  run: (request: ProviderTurnRequest) => Promise<ProviderTurnResult>,
): ProviderTurnRunner {
  return {
    run: async (request) => ({ kind: "done" as const, result: await run(request) }),
    resume: async () => {
      throw new Error("unexpected resume without suspension");
    },
    cancel: () => {},
  };
}

function userMessage(text: string): ProviderTranscriptMessage {
  return { role: "user", content: text };
}

describe("provider prompt rendering", () => {
  it("keeps the latest message authoritative with bounded history", () => {
    const prompt = renderProviderPrompt(
      [userMessage("first"), { role: "assistant", content: "draft" }, userMessage("do the thing")],
      "system rules",
    );
    assert.match(prompt, /System instructions:/);
    assert.match(prompt, /first/);
    assert.match(prompt, /Current message:\ndo the thing/);
  });

  it("renders tool results without throwing", () => {
    const prompt = renderProviderPrompt([
      userMessage("go"),
      { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false },
      userMessage("summarize"),
    ]);
    assert.match(prompt, /Tool result \(read\)/);
    assert.match(prompt, /Current message:\nsummarize/);
  });

  it("notes dropped images instead of silently ignoring them", () => {
    const prompt = renderProviderPrompt([
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "x", mimeType: "image/png" }] },
    ]);
    assert.match(prompt, /image omitted/);
  });
});

describe("provider model resolution", () => {
  it("maps thinking levels to effort for effort-driven bases", () => {
    assert.deepEqual(resolveProviderTurnModel(FALLBACK_PROVIDER_MODELS, "gemini-3-8-flash", "medium"), {
      full: "gemini-3.8-flash",
      effort: "medium",
    });
    // Fallback Pro entry has no medium: clamps to high.
    assert.deepEqual(resolveProviderTurnModel(FALLBACK_PROVIDER_MODELS, "gemini-3-1-pro", "medium"), {
      full: "gemini-3.1-pro",
      effort: "high",
    });
  });

  it("never passes effort for fixed-thinking models", () => {
    assert.deepEqual(resolveProviderTurnModel(FALLBACK_PROVIDER_MODELS, "claude-sonnet-4-6", "high"), {
      full: "claude-sonnet-4-6",
      effort: undefined,
    });
  });

  it("fails closed on unknown model ids", () => {
    assert.throws(
      () => resolveProviderTurnModel(FALLBACK_PROVIDER_MODELS, "gemini-9-9-flash"),
      /Unknown antigravity model/,
    );
  });
});

describe("provider streamSimple", () => {
  it("streams text deltas and ends with stop", async () => {
    await withIsolatedAgentDir(async () => {
    const factory = createRecordingFactory();
    const streamSimple = createAgyStreamSimple(factory, {
      entries: [...FALLBACK_PROVIDER_MODELS],
      runner: makeStaticRunner(async ({ callbacks }) => {
        callbacks?.onText?.("hello ");
        callbacks?.onText?.("world");
        const result: ProviderTurnResult = { text: "hello world", truncated: false, activity: [] };
        return result;
      }),
    });
    streamSimple({ id: "gemini-3-8-flash" }, [userMessage("hi")], {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const types = factory.events.map((event) => event.type);
    assert.deepEqual(types, ["start", "text_start", "text_delta", "text_delta", "text_end", "done", "__end"]);
    const done = factory.events.find((event) => event.type === "done") as unknown as {
      message: { stopReason: string };
    };
    assert.equal(done.message.stopReason, "stop");
    });
  });

  it("surfaces agy tool activity as thinking events", async () => {
    await withIsolatedAgentDir(async () => {
    const factory = createRecordingFactory();
    const streamSimple = createAgyStreamSimple(factory, {
      entries: [...FALLBACK_PROVIDER_MODELS],
      runner: makeStaticRunner(async ({ callbacks }) => {
        callbacks?.onActivity?.("[agy tool: editing foo.ts]");
        callbacks?.onText?.("done");
        return { text: "done", truncated: false, activity: ["[agy tool: editing foo.ts]"] };
      }),
    });
    streamSimple({ id: "claude-sonnet-4-6" }, [userMessage("edit foo")], {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const types = factory.events.map((event) => event.type);
    assert.ok(types.includes("thinking_start"));
    assert.ok(types.includes("thinking_delta"));
    assert.ok(types.includes("thinking_end"));
    });
  });

  it("emits an error event for unknown models without spawning", async () => {
    await withIsolatedAgentDir(async () => {
    const factory = createRecordingFactory();
    let spawned = false;
    const streamSimple = createAgyStreamSimple(factory, {
      entries: [...FALLBACK_PROVIDER_MODELS],
      runner: makeStaticRunner(async () => {
        spawned = true;
        throw new Error("must not spawn");
      }),
    });
    streamSimple({ id: "nope" }, [userMessage("hi")], {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(spawned, false);
    const error = factory.events.find((event) => event.type === "error") as unknown as {
      error: { stopReason: string; errorMessage: string };
    };
    assert.equal(error.error.stopReason, "error");
    assert.match(error.error.errorMessage, /Unknown antigravity model/);
    });
  });

  it("passes effort and resume ids through to the runner", async () => {
    await withIsolatedAgentDir(async () => {
    const factory = createRecordingFactory();
    const seen: Array<{ fullModel: string; effort?: string; resume?: string }> = [];
    const entries = [...FALLBACK_PROVIDER_MODELS];
    const streamSimple = createAgyStreamSimple(factory, {
      entries,
      runner: makeStaticRunner(async (request) => {
        seen.push({
          fullModel: request.fullModel,
          effort: request.effort,
          resume: request.resumeConversationId,
        });
        return { text: "ok", truncated: false, conversationId: "conv-1", activity: [] };
      }),
    });
    const controller = new AbortController();
    streamSimple({ id: "gemini-3-8-flash" }, [userMessage("one")], { signal: controller.signal, reasoning: "low" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A follow-up turn (prior assistant message present) resumes.
    streamSimple(
      { id: "gemini-3-8-flash" },
      [userMessage("one"), { role: "assistant", content: "ok" }, userMessage("two")],
      { signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.length, 2);
    assert.equal(seen[0].fullModel, "gemini-3.8-flash");
    assert.equal(seen[0].effort, "low");
    assert.equal(seen[0].resume, undefined);
    // Second turn resumes the first turn's conversation in memory.
    assert.equal(seen[1].resume, "conv-1");
    });
  });

  it("starts a fresh conversation for sessions without a prior assistant turn", async () => {
    await withIsolatedAgentDir(async () => {
    const factory = createRecordingFactory();
    const seen: Array<string | undefined> = [];
    const streamSimple = createAgyStreamSimple(factory, {
      entries: [...FALLBACK_PROVIDER_MODELS],
      runner: makeStaticRunner(async (request) => {
        seen.push(request.resumeConversationId);
        return { text: "ok", truncated: false, conversationId: "conv-fresh", activity: [] };
      }),
    });
    // User message only: must not inherit a stale recorded conversation.
    streamSimple({ id: "gemini-3-8-flash" }, [userMessage("fresh start")], {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(seen, [undefined]);
    });
  });

  it("marks partial turns as aborted/length instead of stop", async () => {
    await withIsolatedAgentDir(async () => {
    const factory = createRecordingFactory();
    const streamSimple = createAgyStreamSimple(factory, {
      entries: [...FALLBACK_PROVIDER_MODELS],
      runner: makeStaticRunner(async ({ callbacks }) => {
        callbacks?.onText?.("partial");
        return { text: "partial", truncated: false, timedOut: true, activity: [] };
      }),
    });
    streamSimple(
      { id: "gemini-3-8-flash" },
      [userMessage("a"), { role: "assistant", content: "b" }, userMessage("c")],
      {},
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const done = factory.events.find((event) => event.type === "done") as unknown as {
      reason: string;
      message: { stopReason: string };
    };
    assert.equal(done.reason, "length");
    assert.equal(done.message.stopReason, "length");
    const textEnd = factory.events.find((event) => event.type === "text_end") as unknown as {
      content: string;
    };
    assert.match(textEnd.content, /timed out — response is partial/);
    });
  });

  it("emits thinking_end with string content", async () => {
    await withIsolatedAgentDir(async () => {
    const factory = createRecordingFactory();
    const streamSimple = createAgyStreamSimple(factory, {
      entries: [...FALLBACK_PROVIDER_MODELS],
      runner: makeStaticRunner(async ({ callbacks }) => {
        callbacks?.onActivity?.("[agy tool: editing foo.ts]");
        callbacks?.onText?.("done");
        return { text: "done", truncated: false, activity: [] };
      }),
    });
    streamSimple({ id: "claude-sonnet-4-6" }, [userMessage("edit foo")], {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const end = factory.events.find((event) => event.type === "thinking_end") as unknown as {
      content: unknown;
    };
    assert.equal(typeof end.content, "string");
    });
  });
});

describe("provider tool round-trip", () => {
  it("emits a shadow toolUse on park and resumes on toolResult", async () => {
    await withIsolatedAgentDir(async () => {
    const factory = createRecordingFactory();
    const deliveries: Array<{ callId: string; text: string; isError: boolean }> = [];
    let resumes = 0;
    const runner: ProviderTurnRunner = {
      run: async () => ({
        kind: "parked" as const,
        park: { callId: "park-1", toolName: "read", args: { path: "/tmp/x" } },
      }),
      resume: async (got) => {
        resumes += 1;
        deliveries.push(...got);
        return {
          kind: "done" as const,
          result: { text: "file says hi", truncated: false, conversationId: "conv-r", activity: [] },
        };
      },
      cancel: () => {},
    };
    const streamSimple = createAgyStreamSimple(factory, {
      entries: [...FALLBACK_PROVIDER_MODELS],
      runner,
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
    });
    streamSimple({ id: "gemini-3-8-flash" }, [userMessage("read the file")], {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const parkedTypes = factory.events.map((event) => event.type);
    assert.ok(parkedTypes.includes("toolcall_start"));
    assert.ok(parkedTypes.includes("toolcall_end"));
    const parkedDone = factory.events.find((event) => event.type === "done") as unknown as {
      reason: string;
      message: { stopReason: string; content: Array<{ type: string; id: string; name: string }> };
    };
    assert.equal(parkedDone.reason, "toolUse");
    assert.equal(parkedDone.message.stopReason, "toolUse");
    const toolCall = parkedDone.message.content.find((block) => block.type === "toolCall");
    assert.ok(toolCall);
    assert.equal(toolCall!.name, "read");

    // Next Pi turn delivers the tool result: the suspended turn resumes on
    // the same handler instance.
    streamSimple(
      { id: "gemini-3-8-flash" },
      [
        userMessage("read the file"),
        { role: "assistant", content: [{ type: "toolCall", id: toolCall!.id, name: "read", arguments: {} }] },
        { role: "toolResult", toolCallId: toolCall!.id, toolName: "read", content: "file says hi", isError: false },
        userMessage("thanks"),
      ],
      {},
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(resumes, 1);
    // Deliveries carry the bridge park id (what agy waits on), matched via
    // the shadow toolCall id (what Pi's transcript carries).
    assert.deepEqual(deliveries, [{ callId: "park-1", text: "file says hi", isError: false }]);
    const dones = factory.events.filter((event) => event.type === "done") as unknown as Array<{
      reason: string;
    }>;
    assert.deepEqual(
      dones.map((done) => done.reason),
      ["toolUse", "stop"],
    );
    });
  });

  it("cancels a stale suspension when its own transcript moves on", async () => {
    await withIsolatedAgentDir(async () => {
    const factory = createRecordingFactory();
    let runs = 0;
    let cancels = 0;
    const runner: ProviderTurnRunner = {
      run: async () => {
        runs += 1;
        if (runs === 1) {
          return {
            kind: "parked" as const,
            park: { callId: "park-stale", toolName: "read", args: {} },
          };
        }
        return { kind: "done" as const, result: { text: "fresh retry", truncated: false, activity: [] } };
      },
      resume: async () => {
        throw new Error("must not resume without a delivery");
      },
      cancel: () => {
        cancels += 1;
      },
    };
    const streamSimple = createAgyStreamSimple(factory, {
      entries: [...FALLBACK_PROVIDER_MODELS],
      runner,
    });
    streamSimple({ id: "gemini-3-8-flash" }, [userMessage("first")], {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const toolUse = factory.events.find((event) => event.type === "done") as unknown as {
      message: { content: Array<{ type: string; id: string }> };
    };
    const toolCall = toolUse.message.content.find((block) => block.type === "toolCall")!;
    // User retries with a new prompt instead of delivering the tool result.
    streamSimple(
      { id: "gemini-3-8-flash" },
      [
        userMessage("first"),
        { role: "assistant", content: [{ type: "toolCall", id: toolCall.id, name: "read", arguments: {} }] },
        userMessage("never mind, do something else"),
      ],
      {},
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(cancels, 1);
    assert.equal(runs, 2);
    const dones = factory.events.filter((event) => event.type === "done") as unknown as Array<{
      reason: string;
    }>;
    assert.deepEqual(
      dones.map((done) => done.reason),
      ["toolUse", "stop"],
    );
    });
  });

  it("leaves foreign suspensions alone and runs fresh", async () => {
    await withIsolatedAgentDir(async () => {
    const factory = createRecordingFactory();
    let runs = 0;
    const runner: ProviderTurnRunner = {
      run: async () => {
        runs += 1;
        return { kind: "done" as const, result: { text: `run-${runs}`, truncated: false, activity: [] } };
      },
      resume: async () => {
        throw new Error("must not resume without a delivery");
      },
      cancel: () => {},
    };
    const streamSimple = createAgyStreamSimple(factory, {
      entries: [...FALLBACK_PROVIDER_MODELS],
      runner,
    });
    // No suspended turn exists and no toolResult matches: plain fresh run.
    streamSimple({ id: "gemini-3-8-flash" }, [userMessage("hi")], {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(runs, 1);
    });
  });
});

describe("provider image staging", () => {
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const imageBlock = (mimeType = "image/png", data = pngBase64) => ({
    type: "image",
    data,
    mimeType,
  });

  it("collects blocks in order with identity", async () => {
    const { collectImageBlocks, imageExtension } = await import("../extensions/lib/provider.js");
    assert.equal(imageExtension("image/png"), "png");
    assert.equal(imageExtension("IMAGE/JPEG"), "jpg");
    assert.equal(imageExtension("application/octet-stream"), "bin");
    const first = imageBlock();
    const second = imageBlock("image/jpeg");
    const blocks = collectImageBlocks([
      { role: "user", content: [{ type: "text", text: "look" }, first] },
      { role: "assistant", content: "ack" },
      { role: "user", content: [second] },
    ]);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].block, first);
    assert.equal(blocks[1].mimeType, "image/jpeg");
    assert.deepEqual(collectImageBlocks([{ role: "user", content: [first] }], "other-id"), []);
  });

  it("stages files with restrictive modes and caps", async () => {
    const { stageImages, MAX_STAGED_IMAGES } = await import("../extensions/lib/provider.js");
    const { stat } = await import("node:fs/promises");
    const blocks = Array.from({ length: MAX_STAGED_IMAGES + 3 }, (_, index) => ({
      block: {},
      data: pngBase64,
      mimeType: "image/png",
    }));
    // Oversized and invalid blocks are skipped, never fatal.
    blocks.push(
      { block: {}, data: pngBase64, mimeType: "image/png" },
      { block: {}, data: "!!!not-base64!!!", mimeType: "image/png" },
    );
    const { dir, paths, cleanup } = await stageImages(blocks);
    assert.ok(dir);
    // Newest-first: the invalid tail block is skipped, the oldest blocks
    // starve past the cap.
    assert.equal(paths.size, MAX_STAGED_IMAGES - 1);
    assert.equal(paths.has(blocks[0].block), false);
    assert.equal(paths.has(blocks[blocks.length - 3].block), true);
    const mode = (await stat(dir!)).mode & 0o777;
    assert.equal(mode, 0o700);
    const { readFile } = await import("node:fs/promises");
    const first = paths.values().next().value as string;
    assert.match(first, /\.png$/);
    assert.deepEqual(await readFile(first), Buffer.from(pngBase64, "base64"));
    await cleanup();
  });

  it("isolates concurrent stagings from each other's cleanup", async () => {
    const { stageImages } = await import("../extensions/lib/provider.js");
    const { stat } = await import("node:fs/promises");
    const make = () => [{ block: {}, data: pngBase64, mimeType: "image/png" }];
    const first = await stageImages(make());
    const second = await stageImages(make());
    assert.notEqual(first.dir, second.dir);
    await first.cleanup();
    await stat(second.dir!);
    await second.cleanup();
    await assert.rejects(stat(second.dir!));
  });

  it("renders staged paths and omits unstaged images", async () => {
    const { collectImageBlocks, stageImages, renderProviderPrompt } = await import(
      "../extensions/lib/provider.js"
    );
    const messages = [
      { role: "user", content: [{ type: "text", text: "look" }, imageBlock()] },
    ];
    const plain = renderProviderPrompt(messages);
    assert.match(plain, /image omitted/);
    const staged = await stageImages(collectImageBlocks(messages));
    assert.ok(staged.dir);
    const rendered = renderProviderPrompt(messages, undefined, staged.paths);
    assert.match(rendered, /attached image saved at .*\.png/);
    const { rm } = await import("node:fs/promises");
    await rm(staged.dir!, { recursive: true, force: true });
  });

  it("passes staged paths in prompts and cleans up after done", async () => {
    await withIsolatedAgentDir(async () => {
    const factory = createRecordingFactory();
    let seenPrompt = "";
    const runner: ProviderTurnRunner = {
      run: async (request) => {
        seenPrompt = request.prompt;
        return { kind: "done" as const, result: { text: "seen", truncated: false, activity: [] } };
      },
      resume: async () => {
        throw new Error("unexpected resume");
      },
      cancel: () => {},
    };
    const streamSimple = createAgyStreamSimple(factory, {
      entries: [...FALLBACK_PROVIDER_MODELS],
      runner,
    });
    streamSimple(
      { id: "gemini-3-8-flash" },
      [{ role: "user", content: [{ type: "text", text: "describe" }, imageBlock()] }],
      {},
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const match = /attached image saved at (\S+\.png)/.exec(seenPrompt);
    assert.ok(match, "prompt must reference the staged file");
    const { stat } = await import("node:fs/promises");
    await assert.rejects(stat(match![1]), /ENOENT/);
    });
  });

  it("keeps staging across park and cleans after resume-done", async () => {
    await withIsolatedAgentDir(async () => {
    const factory = createRecordingFactory();
    let prompts: string[] = [];
    const runner: ProviderTurnRunner = {
      run: async (request) => {
        prompts.push(request.prompt);
        return {
          kind: "parked" as const,
          park: { callId: "park-img", toolName: "read", args: {} },
        };
      },
      resume: async () => ({
        kind: "done" as const,
        result: { text: "done", truncated: false, activity: [] },
      }),
      cancel: () => {},
    };
    const streamSimple = createAgyStreamSimple(factory, {
      entries: [...FALLBACK_PROVIDER_MODELS],
      runner,
    });
    streamSimple(
      { id: "gemini-3-8-flash" },
      [{ role: "user", content: [{ type: "text", text: "read this" }, imageBlock()] }],
      {},
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const match = /attached image saved at (\S+\.png)/.exec(prompts[0]);
    assert.ok(match);
    const { stat } = await import("node:fs/promises");
    await stat(match![1]);
    const toolUse = factory.events.find((event) => event.type === "done") as unknown as {
      message: { content: Array<{ type: string; id: string }> };
    };
    const toolCall = toolUse.message.content.find((block) => block.type === "toolCall")!;
    streamSimple(
      { id: "gemini-3-8-flash" },
      [
        { role: "user", content: "read this" },
        { role: "assistant", content: [{ type: "toolCall", id: toolCall.id, name: "read", arguments: {} }] },
        { role: "toolResult", toolCallId: toolCall.id, toolName: "read", content: "ok", isError: false },
      ],
      {},
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(stat(match![1]), /ENOENT/);
    });
  });
});

describe("provider status", () => {
  it("reports idle state for untouched directories", async () => {
    const { getProviderStatus } = await import("../extensions/lib/provider.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-status-"));
    const status = getProviderStatus(dir);
    assert.equal(status.driver, undefined);
    assert.equal(status.bridge, undefined);
    assert.deepEqual(status.suspended, []);
    assert.equal(typeof status.stagedImages, "number");
  });

  it("surfaces suspended turns awaiting Pi tools", async () => {
    await withIsolatedAgentDir(async () => {
    const { getProviderStatus } = await import("../extensions/lib/provider.js");
    const factory = createRecordingFactory();
    const runner: ProviderTurnRunner = {
      run: async () => ({
        kind: "parked" as const,
        park: { callId: "park-status", toolName: "read", args: {} },
      }),
      resume: async () => {
        throw new Error("unexpected resume");
      },
      cancel: () => {},
    };
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-status-susp-"));
    const streamSimple = createAgyStreamSimple(factory, {
      entries: [...FALLBACK_PROVIDER_MODELS],
      runner,
      dir,
    });
    streamSimple({ id: "gemini-3-8-flash" }, [userMessage("go")], {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = getProviderStatus(dir);
    assert.equal(status.suspended.length, 1);
    assert.equal(status.suspended[0].toolName, "read");
    assert.ok(status.suspended[0].toolCallId.length > 0);
    });
  });
});

describe("provider registration", () => {
  it("registers antigravity picker models without breaking when discovery yields nothing", async () => {
    await withFakeAgy(
      "",
      async () => {
        await withIsolatedAgentDir(async () => {
          const providers: Array<{ name: string; config: { models: Array<{ id: string }>; streamSimple?: unknown } }> = [];
          const fakePi = {
            registerCommand: () => {},
            registerTool: () => {},
            registerProvider: (
              name: string,
              config: { models: Array<{ id: string }>; streamSimple?: unknown },
            ) => {
              providers.push({ name, config });
            },
          };
          piAgyExtension(fakePi as unknown as ExtensionAPI);
          const provider = providers.find((entry) => entry.name === AGY_PROVIDER_ID);
          assert.ok(provider, "antigravity provider was not registered");
          const ids = provider!.config.models.map((model) => model.id);
          for (const entry of FALLBACK_PROVIDER_MODELS) {
            assert.ok(ids.includes(entry.id), `missing fallback model: ${entry.id}`);
          }
          assert.equal(typeof provider!.config.streamSimple, "function");
          // Let the background catalog refresh settle (fake `agy models`
          // yields no parseable entries, so the fallback stands).
          await new Promise((resolve) => setTimeout(resolve, 200));
          assert.equal(
            providers.filter((entry) => entry.name === AGY_PROVIDER_ID).length,
            1,
            "fallback catalog must not be re-registered when discovery yields nothing",
          );
        });
      },
      0,
      0,
      "",
      "",
      "{}",
      0,
      "Fetching models…",
    );
  });
});

describe("provider real stream protocol", () => {
  it("returns an async-iterable pi-ai stream", async () => {
    await withIsolatedAgentDir(async () => {
      const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
      const streamSimple = createAgyStreamSimple(
        {
          // Same passthrough shape as the extension entry: keep the real
          // stream object (async iteration, result()) and only widen push.
          createStream: () => {
            const real = createAssistantMessageEventStream();
            const push = (real.push as (event: unknown) => void).bind(real);
            return Object.assign(real, {
              push: (event: Record<string, unknown>) => push(event),
            });
          },
          getSystemPrompt: () => "",
        },
        {
          entries: [...FALLBACK_PROVIDER_MODELS],
          runner: makeStaticRunner(async ({ callbacks }) => {
            callbacks?.onText?.("real stream text");
            return { text: "real stream text", truncated: false, activity: [] };
          }),
        },
      );
      const stream = streamSimple({ id: "gemini-3-8-flash" }, [userMessage("hi")], {});
      assert.equal(typeof (stream as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator], "function");
      const types: Array<unknown> = [];
      for await (const event of stream as unknown as AsyncIterable<Record<string, unknown>>) {
        types.push(event.type);
      }
      assert.ok(types.includes("start"), "missing start event");
      assert.ok(types.includes("done"), "missing done event");
    });
  });
});

describe("provider default runner", () => {
  it("injects the MCP bridge dir as an extra --add-dir", async () => {
    const raw =
      JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", response: "bridged", conversation_id: "conv-b" },
      }) + "\n";
    await withFakeAgy(raw, async (bin) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-provider-bridge-"));
      const result = await expectRunResult(getProviderRunner(dir).run({
        fullModel: "gemini-3.8-flash",
        prompt: "hi",
        dir,
        signal: new AbortController().signal,
        timeoutMs: 30_000,
        skipPermissions: false,
        bridgedTools: [],
      }));
      assert.equal(result.text, "bridged");
      const { readFakeAgyArgs } = await import("./helpers.js");
      const invocations = await readFakeAgyArgs(bin);
      assert.ok(invocations.length >= 1);
      const addDirs = invocations[0].filter((arg) => arg === "--add-dir").length;
      assert.equal(addDirs, 3);
      assert.ok(
        invocations[0].includes(dir),
        "workspace dir must stay the first --add-dir",
      );
    });
  });

  it("skips the bridge dir when providerBridge is false", async () => {
    const raw =
      JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", response: "plain", conversation_id: "conv-p" },
      }) + "\n";
    await withFakeAgy(raw, async (bin) => {
      const agentDir = process.env.PI_CODING_AGENT_DIR;
      assert.ok(agentDir, "withFakeAgy must isolate the agent dir");
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(agentDir, { recursive: true });
      await writeFile(path.join(agentDir, "agy-config.json"), JSON.stringify({ providerBridge: false }));
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-provider-plain-"));
      const result = await expectRunResult(getProviderRunner(dir).run({
        fullModel: "gemini-3.8-flash",
        prompt: "hi",
        dir,
        signal: new AbortController().signal,
        timeoutMs: 30_000,
        skipPermissions: false,
        bridgedTools: [],
      }));
      assert.equal(result.text, "plain");
      const { readFakeAgyArgs } = await import("./helpers.js");
      const invocations = await readFakeAgyArgs(bin);
      assert.ok(invocations.length >= 1);
      const addDirs = invocations[0].filter((arg) => arg === "--add-dir").length;
      assert.equal(addDirs, 2);
    });
  });

  it("resolves text from a stream-json result envelope", async () => {
    const raw =
      JSON.stringify({ event: "init", init: { model: "gemini-3.8-flash" } }) +
      "\n" +
      JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", response: "provider hello", conversation_id: "conv-9" },
      }) +
      "\n";
    await withFakeAgy(raw, async () => {
      const result = await expectRunResult(getProviderRunner(process.cwd()).run({
        fullModel: "gemini-3.8-flash",
        effort: "medium",
        prompt: "say hello",
        dir: process.cwd(),
        signal: new AbortController().signal,
        timeoutMs: 30_000,
        skipPermissions: false,
        bridgedTools: [],
      }));
      assert.equal(result.text, "provider hello");
      assert.equal(result.conversationId, "conv-9");
    });
  });

  it("waits for the directory lock instead of racing another run", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-provider-lock-"));
    // Occupy the directory chain with a holder that never finishes.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withDirLock(dir, () => gate);
    try {
      await assert.rejects(
        () =>
          getProviderRunner(dir).run({
            fullModel: "gemini-3.8-flash",
            prompt: "blocked",
            dir,
            signal: new AbortController().signal,
            timeoutMs: 1_500,
            skipPermissions: false,
        bridgedTools: [],
          }),
        /timed out waiting for a previous run/,
      );
    } finally {
      release();
      await holder;
    }
  });

  it("rejects terminal failures instead of returning empty text", async () => {
    const raw =
      JSON.stringify({
        event: "result",
        result: { status: "FAILED", error: "boom" },
      }) + "\n";
    await withFakeAgy(raw, async () => {
      await assert.rejects(
        () =>
          getProviderRunner(process.cwd()).run({
            fullModel: "gemini-3.8-flash",
            prompt: "fail",
            dir: process.cwd(),
            signal: new AbortController().signal,
            timeoutMs: 30_000,
            skipPermissions: false,
        bridgedTools: [],
          }),
        /FAILED/,
      );
    });
  });
});
