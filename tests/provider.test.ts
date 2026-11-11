import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { withTimingFakeAgy, awaitWithWatchdog, nativeSetTimeout, type FakeChild } from "./timing-helpers.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getProviderDriver, getProviderStatus } from "../extensions/lib/provider.js";
import { BRIDGE_TOKEN_HEADER, DEFAULT_PARK_ESCALATE_MS } from "../extensions/lib/provider-mcp.js";
import { afterEach, describe, it, mock } from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

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
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
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

describe("provider terminal response reconciliation", () => {
  it("replaces streamed prefixes and corrected drafts with the terminal answer", async () => {
    await withIsolatedAgentDir(async () => {
      for (const [draft, terminal] of [["prefix ", "prefix plus terminal"], ["draft text", "corrected final"]]) {
        const factory = createRecordingFactory();
        const streamSimple = createAgyStreamSimple(factory, {
          entries: [...FALLBACK_PROVIDER_MODELS],
          runner: makeStaticRunner(async ({ callbacks }) => {
            callbacks?.onText?.(draft);
            return { text: terminal, truncated: false, activity: [] };
          }),
        });
        const start = factory.events.length;
        streamSimple({ id: "gemini-3-8-flash" }, [userMessage("answer")], {});
        await waitForStreamEnd(factory, start);
        const textEnd = factory.events.find((event) => event.type === "text_end") as { content: string };
        const done = factory.events.find((event) => event.type === "done") as {
          message: { content: Array<{ type: string; text?: string }> };
        };
        assert.equal(textEnd.content, terminal);
        assert.equal(done.message.content.find((block) => block.type === "text")?.text, terminal);
      }
    });
  });

  it("uses activity or empty fallback instead of a stale live draft", async () => {
    await withIsolatedAgentDir(async () => {
      for (const activity of [["terminal activity"], []]) {
        const factory = createRecordingFactory();
        const streamSimple = createAgyStreamSimple(factory, {
          entries: [...FALLBACK_PROVIDER_MODELS],
          runner: makeStaticRunner(async ({ callbacks }) => {
            callbacks?.onText?.("stale live draft");
            return { text: "", truncated: false, activity };
          }),
        });
        const start = factory.events.length;
        streamSimple({ id: "gemini-3-8-flash" }, [userMessage("answer")], {});
        await waitForStreamEnd(factory, start);
        const expected = activity.length > 0 ? activity.join("\n") : "(agy returned no text)";
        const textEnd = factory.events.find((event) => event.type === "text_end") as { content: string };
        const done = factory.events.find((event) => event.type === "done") as {
          message: { content: Array<{ type: string; text?: string }> };
        };
        assert.equal(textEnd.content, expected);
        assert.equal(done.message.content.find((block) => block.type === "text")?.text, expected);
        assert.doesNotMatch(textEnd.content, /stale live draft/);
      }
    });
  });

  it("keeps terminal annotations and stop reasons identical for live and no-live results", async () => {
    const cases = [
      { name: "truncated", truncated: true, expected: "stop", note: "[truncated: agy response exceeded the provider cap]" },
      { name: "denied", deniedActions: [{ action: "write" }], expected: "stop", note: "[warning: agy reported 1 denied action(s) alongside this response]" },
      { name: "aborted", aborted: true, expected: "aborted", note: "[note: turn cancelled — response is partial]" },
      { name: "timed out", timedOut: true, expected: "length", note: "[note: turn timed out — response is partial]" },
      { name: "aborted precedence", aborted: true, timedOut: true, expected: "aborted", note: "[note: turn cancelled — response is partial]" },
    ];
    await withIsolatedAgentDir(async () => {
      for (const live of [false, true]) {
        for (const testCase of cases) {
          const factory = createRecordingFactory();
          const streamSimple = createAgyStreamSimple(factory, {
            entries: [...FALLBACK_PROVIDER_MODELS],
            runner: makeStaticRunner(async ({ callbacks }) => {
              if (live) callbacks?.onText?.("provisional draft");
              return { text: "terminal answer", truncated: false, activity: [], ...testCase };
            }),
          });
          const start = factory.events.length;
          streamSimple({ id: "gemini-3-8-flash" }, [userMessage(testCase.name)], {});
          await waitForStreamEnd(factory, start);
          const textEnd = factory.events.find((event) => event.type === "text_end") as { content: string };
          const done = factory.events.find((event) => event.type === "done") as {
            reason: string;
            message: { stopReason: string; content: Array<{ type: string; text?: string }> };
          };
          const expected = `terminal answer\n\n${testCase.note}`;
          assert.equal(textEnd.content, expected);
          assert.equal(done.message.content.find((block) => block.type === "text")?.text, expected);
          assert.equal(done.reason, testCase.expected);
          assert.equal(done.message.stopReason, testCase.expected);
        }
      }
    });
  });

  it("reconciles through the real pi-ai async iterable and result", async () => {
    await withIsolatedAgentDir(async () => {
      const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
      for (const [liveText, terminalText] of [["live draft", "authoritative terminal"], ["same answer", "same answer"]]) {
        const controller = new AbortController();
        const streamSimple = createAgyStreamSimple(
          {
            createStream: () => {
              const real = createAssistantMessageEventStream();
              const push = (real.push as (event: unknown) => void).bind(real);
              return Object.assign(real, { push: (event: Record<string, unknown>) => push(event) });
            },
            getSystemPrompt: () => "",
          },
          {
            entries: [...FALLBACK_PROVIDER_MODELS],
            runner: makeStaticRunner(async ({ callbacks }) => {
              callbacks?.onText?.(liveText);
              return { text: terminalText, truncated: false, activity: [] };
            }),
          },
        );
        const stream = streamSimple({ id: "gemini-3-8-flash" }, [userMessage("answer")], { signal: controller.signal });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const operation = (async () => {
            const events: Array<{ type: string; contentIndex?: number; content?: string; message?: { content: Array<{ type: string; text?: string }> } }> = [];
            for await (const event of stream as unknown as AsyncIterable<typeof events[number]>) events.push(event);
            const result = await (stream as unknown as { result(): Promise<{ content: Array<{ type: string; text?: string }> }> }).result();
            return { events, result };
          })();
          const guard = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timed out waiting for real provider stream")), 1_000);
          });
          const { events, result } = await Promise.race([operation, guard]);
          const starts = events.filter((event) => event.type === "text_start");
          const ends = events.filter((event) => event.type === "text_end");
          assert.equal(starts.length, 1);
          assert.equal(ends.length, 1);
          assert.equal(starts[0].contentIndex, ends[0].contentIndex);
          assert.equal(ends[0].content, terminalText);
          const done = events.find((event) => event.type === "done");
          assert.equal(done?.message?.content.find((block) => block.type === "text")?.text, terminalText);
          assert.equal(result.content.find((block) => block.type === "text")?.text, terminalText);
        } catch (error) {
          controller.abort();
          throw error;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
    });
  });
});

async function waitForStreamEnd(factory: { events: Array<Record<string, unknown>> }, start: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!factory.events.slice(start).some((event) => event.type === "__end")) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for provider stream");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const ordinaryTool = { name: "read_file", description: "Read a file", parameters: { type: "object", properties: {} } };
const secondTool = { name: "write_file", description: "Write a file", parameters: { type: "object", properties: {} } };
const selfDelegationTool = { name: "askantigravity", description: "Delegate", parameters: { type: "object", properties: {} } };

async function bridgedToolCatalogs(
  invocations: Array<typeof ordinaryTool[] | undefined>,
  depsTools?: typeof ordinaryTool[],
): Promise<Array<Array<{ name: string; piName: string }>>> {
  const factory = createRecordingFactory();
  const captured: Array<Array<{ name: string; piName: string }>> = [];
  const streamSimple = createAgyStreamSimple(factory, {
    entries: [...FALLBACK_PROVIDER_MODELS],
    tools: depsTools,
    runner: makeStaticRunner(async (request) => {
      captured.push(request.bridgedTools.map(({ name, piName }) => ({ name, piName })));
      return { text: "ok", truncated: false, activity: [] };
    }),
  });
  for (const tools of invocations) {
    const start = factory.events.length;
    streamSimple({ id: "gemini-3-8-flash" }, [userMessage("inspect")], tools === undefined ? undefined : { tools });
    await waitForStreamEnd(factory, start);
  }
  return captured;
}

describe("provider active tool catalog", () => {
  it("uses invocation tools, refreshes them on consecutive fresh turns, and honors an explicit empty catalog", async () => {
    await withIsolatedAgentDir(async () => {
      assert.deepEqual(await bridgedToolCatalogs([[ordinaryTool], [secondTool], []], [ordinaryTool]), [
        [{ name: "read_file", piName: "read_file" }],
        [{ name: "write_file", piName: "write_file" }],
        [],
      ]);
    });
  });

  it("retains dependency tools when invocation tools are omitted", async () => {
    await withIsolatedAgentDir(async () => {
      assert.deepEqual(await bridgedToolCatalogs([undefined], [ordinaryTool]), [
        [{ name: "read_file", piName: "read_file" }],
      ]);
    });
  });

  it("excludes the agy self-delegation tool while retaining ordinary tools", async () => {
    await withIsolatedAgentDir(async () => {
      assert.deepEqual(await bridgedToolCatalogs([[selfDelegationTool, ordinaryTool]]), [
        [{ name: "read_file", piName: "read_file" }],
      ]);
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
      run: async ({ callbacks }) => {
        callbacks?.onText?.("pre-tool commentary");
        return {
          kind: "parked" as const,
          park: { callId: "park-1", toolName: "read", args: { path: "/tmp/x" } },
        };
      },
      resume: async (got, callbacks) => {
        resumes += 1;
        deliveries.push(...got);
        callbacks?.onText?.("resumed draft");
        return {
          kind: "done" as const,
          result: { text: "authoritative resumed answer", truncated: false, conversationId: "conv-r", activity: [] },
        };
      },
      cancel: () => {},
    };
    const streamSimple = createAgyStreamSimple(factory, {
      entries: [...FALLBACK_PROVIDER_MODELS],
      runner,
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
    });
    const parkedStart = factory.events.length;
    streamSimple({ id: "gemini-3-8-flash" }, [userMessage("read the file")], {});
    await waitForStreamEnd(factory, parkedStart);
    const parkedTypes = factory.events.map((event) => event.type);
    assert.ok(parkedTypes.includes("toolcall_start"));
    assert.ok(parkedTypes.includes("toolcall_end"));
    const parkedDone = factory.events.find((event) => event.type === "done") as unknown as {
      reason: string;
      message: { stopReason: string; content: Array<{ type: string; id: string; name: string; text?: string }> };
    };
    const parkedContentSnapshot = structuredClone(parkedDone.message.content);
    assert.equal(parkedDone.message.content.find((block) => block.type === "text")?.text, "pre-tool commentary");
    const parkedToolCall = parkedDone.message.content.find((block) => block.type === "toolCall");
    assert.ok(parkedToolCall);
    assert.equal(parkedDone.reason, "toolUse");
    assert.equal(parkedDone.message.stopReason, "toolUse");
    const toolCall = parkedDone.message.content.find((block) => block.type === "toolCall");
    assert.ok(toolCall);
    assert.equal(toolCall!.name, "read");

    // Next Pi turn delivers the tool result: the suspended turn resumes on
    // the same handler instance.
    const resumeStart = factory.events.length;
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
    await waitForStreamEnd(factory, resumeStart);
    assert.equal(resumes, 1);
    assert.deepEqual(parkedDone.message.content, parkedContentSnapshot);
    const resumedEvents = factory.events.slice(resumeStart);
    const resumedTextEnd = resumedEvents.find((event) => event.type === "text_end") as { content: string };
    assert.equal(resumedTextEnd.content, "authoritative resumed answer");
    assert.doesNotMatch(resumedTextEnd.content, /pre-tool commentary|resumed draft/);
    // Deliveries carry the bridge park id (what agy waits on), matched via
    // the shadow toolCall id (what Pi's transcript carries).
    assert.deepEqual(deliveries, [{ callId: "park-1", text: "file says hi", isError: false }]);
    const dones = factory.events.filter((event) => event.type === "done") as unknown as Array<{
      reason: string;
      message?: { content: Array<{ type: string; text?: string }> };
    }>;
    assert.deepEqual(
      dones.map((done) => done.reason),
      ["toolUse", "stop"],
    );
    assert.equal(
      dones[1].message?.content.find((block) => block.type === "text")?.text,
      "authoritative resumed answer",
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withFakePersistentAgy<T>(assertionFile: string, fn: (workspace: string) => Promise<T>): Promise<T> {
  const bin = await mkdtemp(path.join(os.tmpdir(), "pi-agy-registration-bin-"));
  const clientUrl = import.meta.resolve("@modelcontextprotocol/sdk/client/index.js");
  const transportUrl = import.meta.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const script = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const { Client } = await import(${JSON.stringify(clientUrl)});
const { StreamableHTTPClientTransport } = await import(${JSON.stringify(transportUrl)});
const args = process.argv.slice(2);
if (args.includes("models")) { console.log("fake-model"); process.exit(0); }
const dirs = args.flatMap((arg, index) => arg === "--add-dir" ? [args[index + 1]] : []);
const configDir = dirs.find((dir) => { try { return readFileSync(dir + "/.agents/mcp_config.json", "utf8"); } catch { return false; } });
if (!configDir) throw new Error("bridge config not found");
const config = JSON.parse(readFileSync(configDir + "/.agents/mcp_config.json", "utf8"));
const server = config.mcpServers["pi-agy-tools"];
const client = new Client({ name: "catalog-test", version: "1" }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(server.serverUrl), { requestInit: { headers: server.headers } });
await client.connect(transport);
const listed = await client.listTools();
writeFileSync(${JSON.stringify(assertionFile)}, JSON.stringify(listed.tools.map((tool) => tool.name)));
await client.close();
const expiry = setTimeout(() => process.exit(0), 5000);
expiry.unref();
const input = createInterface({ input: process.stdin });
for await (const _line of input) {
  console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok", conversation_id: "catalog-test" } }));
}
`;
  const fake = path.join(bin, "agy");
  await writeFile(fake, script);
  await chmod(fake, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-agy-registration-workspace-"));
  try {
    return await fn(workspace);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

const registrationReadTool = {
  name: "read_file",
  description: "Read a file",
  parameters: Type.Object({ path: Type.String() }),
};
const registrationWriteTool = {
  name: "write_file",
  description: "Write a file",
  parameters: Type.Object({ path: Type.String(), content: Type.String() }),
};
const registrationSelfTool = {
  name: "askantigravity",
  description: "Delegate to agy",
  parameters: Type.Object({ prompt: Type.String() }),
};

type CapturedProviderStream = { result: () => Promise<{ stopReason?: string }> };
type CapturedProvider = {
  streamSimple?: (
    model: { id: string },
    context: { messages: ProviderTranscriptMessage[] },
    options?: object,
  ) => CapturedProviderStream;
};

async function runRegisteredCatalogScenario(withOptions: boolean): Promise<string[]> {
  const privateRoot = await mkdtemp(path.join(os.tmpdir(), "pi-agy-registration-"));
  const assertionFile = path.join(privateRoot, "listed-tools.json");
  try {
    return await withFakePersistentAgy(assertionFile, async (workspace) => {
      const previousCwd = process.cwd();
      try {
        process.chdir(workspace);
        return await withIsolatedAgentDir(async () => {
          const providers: CapturedProvider[] = [];
          const fakePi = {
            registerCommand: () => {},
            registerTool: () => {},
            registerProvider: (_name: string, config: CapturedProvider) => providers.push(config),
          };
          piAgyExtension(fakePi as unknown as ExtensionAPI);
          const provider = providers[0];
          assert.ok(provider?.streamSimple);
          type RegistrationTranscriptMessage = ProviderTranscriptMessage & {
            timestamp: number;
            toolsAdded?: object[];
            toolsRemoved?: Array<{ name: string }>;
          };
          const messages: RegistrationTranscriptMessage[] = [
            { role: "system", content: "test", timestamp: 0, toolsAdded: [registrationReadTool, registrationWriteTool, registrationSelfTool] },
            { role: "user", content: "inspect", timestamp: 1 },
            { role: "system", content: "", timestamp: 2, toolsRemoved: [{ name: registrationWriteTool.name }] },
          ];
          try {
            const stream = provider!.streamSimple!({ id: "gemini-3-8-flash" }, { messages }, withOptions ? {} : undefined);
            const completed = await withTimeout(stream.result(), 3_000);
            assert.equal(completed.stopReason, "stop");
          } finally {
            await closeProviderDrivers();
          }
          return JSON.parse(await readFile(assertionFile, "utf8")) as string[];
        });
      } finally {
        process.chdir(previousCwd);
      }
    });
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
}

describe("provider registration active tool catalog", () => {
  it("advertises transcript tools without stream options and omits removed/self-delegation tools", async () => {
    const names = await runRegisteredCatalogScenario(false);
    assert.ok(names.includes("read_file"));
    assert.ok(!names.includes("write_file"));
    assert.ok(!names.includes("askantigravity"));
  });

  it("advertises the same active catalog when stream options are supplied", async () => {
    const names = await runRegisteredCatalogScenario(true);
    assert.ok(names.includes("read_file"));
    assert.ok(!names.includes("write_file"));
    assert.ok(!names.includes("askantigravity"));
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
    await withIsolatedAgentDir(async () => {
      await withTimingFakeAgy({ onSpawn: () => { assert.fail("lock waiter must never spawn agy"); } }, async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-provider-lock-"));
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const ready = new Promise<void>((resolve) => { entered = resolve; });
        const holder = withDirLock(dir, () => { entered(); return gate; });
        try {
          await awaitWithWatchdog(ready, "lock holder readiness");
          await assert.rejects(getProviderRunner(dir).run({
            fullModel: "gemini-3.8-flash", prompt: "blocked", dir,
            signal: new AbortController().signal, timeoutMs: 1_500,
            skipPermissions: false, bridgedTools: [],
          }), /timed out waiting for a previous run/);
        } finally {
          release();
          await holder;
        }
      });
    });
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


describe("provider parked resource reclamation", () => {
  for (const subsequent of [false, true]) {
    for (const failure of ["abort", "close", "error", "cancel", "shutdown"]) {
      it(`reclaims suspension, images and bridge on ${failure} (${subsequent ? "subsequent" : "first"} park)`, { timeout: 7000 }, async () => {
        await withIsolatedAgentDir(async () => {
          let configDir = "";
          let spawned!: () => void;
          const ready = new Promise<void>((resolve) => { spawned = resolve; });
          await withTimingFakeAgy({ onSpawn: (args, child) => {
            Object.assign(child, { stdin: new PassThrough() });
            for (let i = 0; i < args.length; i++) {
              if (args[i] === "--add-dir" && args[i + 1].includes("pi-agy-bridge")) configDir = args[i + 1];
            }
            spawned();
          } }, async (children) => {
            const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-reclaim-"));
            const factory = createRecordingFactory();
            const stream = createAgyStreamSimple(factory, {
              dir, entries: [...FALLBACK_PROVIDER_MODELS],
              tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
            });
            const old = new AbortController();
            const current = new AbortController();
            const messages: ProviderTranscriptMessage[] = [{ role: "user", content: [
              { type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
            ] }];
            stream({ id: "gemini-3-8-flash" }, messages, { signal: old.signal });
            await awaitWithWatchdog(ready, "provider spawn", 3000);
            const child = [...children][0];
            const originalDriver = getProviderDriver(dir);
            const config = JSON.parse(await readFile(path.join(configDir, ".agents", "mcp_config.json"), "utf8"));
            const server = Object.values(config.mcpServers)[0] as { serverUrl: string; headers: Record<string, string> };
            const client = new Client({ name: "reclaim-test", version: "1" }, { capabilities: {} });
            try {
              await awaitWithWatchdog(client.connect(new StreamableHTTPClientTransport(new URL(server.serverUrl), {
                requestInit: { headers: { [BRIDGE_TOKEN_HEADER]: server.headers[BRIDGE_TOKEN_HEADER] } },
              })), "resource probe connect", 2000);
              const listed = await awaitWithWatchdog(client.listTools(), "resource probe catalog");
              const tool = listed.tools.find((entry) => entry.name === "read");
              assert.ok(tool);
              const calls = [client.callTool({ name: tool.name, arguments: {} })];
              void calls[0].catch(() => undefined);
              await waitForStreamEnd(factory, 0);
              assert.equal(getProviderStatus(dir).suspended.length, 1);
              assert.equal(getProviderStatus(dir).stagedImages, 1);
              if (subsequent) {
                const call = factory.events.find((event) => event.type === "toolcall_end")!.toolCall as { id: string; name: string; arguments: Record<string, unknown> };
                const start = factory.events.length;
                stream({ id: "gemini-3-8-flash" }, [...messages,
                  { role: "assistant", content: [{ type: "toolCall", ...call }] },
                  { role: "toolResult", toolCallId: call.id, toolName: call.name, content: "first result", isError: false },
                ], { signal: current.signal });
                await awaitWithWatchdog(calls[0], "first delivered tool");
                calls.push(client.callTool({ name: tool.name, arguments: {} }));
                void calls[1].catch(() => undefined);
                await waitForStreamEnd(factory, start);
                old.abort();
                assert.equal(getProviderStatus(dir).suspended.length, 1);
              }
              if (failure === "abort") (subsequent ? current : old).abort();
              if (failure === "close") child.close(3);
              if (failure === "error") child.emit("error", new Error("fake process error"));
              if (failure === "cancel") getProviderRunner(dir).cancel();
              if (failure === "shutdown") { await closeProviderDrivers(); await client.close(); }
              const settledCalls = await awaitWithWatchdog(Promise.allSettled(calls), "parked MCP cleanup", 2000);
              if (failure !== "shutdown") {
                const last = settledCalls[settledCalls.length - 1];
                assert.equal(last.status, "fulfilled");
                if (last.status === "fulfilled") assert.equal(last.value.isError, true);
              }
              // The hook removes the status entry synchronously; image removal is asynchronous.
              assert.equal(getProviderStatus(dir).suspended.length, 0);
              for (let n = 0; n < 100 && getProviderStatus(dir).stagedImages; n++) {
                await new Promise((resolve) => setTimeout(resolve, 5));
              }
              assert.equal(getProviderStatus(dir).stagedImages, 0);
              assert.throws(() => originalDriver.continueTurn(), failure === "shutdown" ? /closed/ : /no suspended turn/);
            } finally {
              await closeProviderDrivers();
              await client.close();
            }
          });
        });
      });
    }
  }
});


/** Default runner + real authenticated MCP transport + pid-free driver fake. */
async function withProviderLifecycleProbe(fn: (probe: {
  dir: string; child: FakeChild; driver: ReturnType<typeof getProviderDriver>;
  runner: ProviderTurnRunner; client: Client; factory: ReturnType<typeof createRecordingFactory>;
  controller: AbortController; parks: Array<{ callId: string; toolName: string }>;
}) => Promise<void>): Promise<void> {
  await withIsolatedAgentDir(async () => {
    let configDir = "";
    let spawned!: () => void;
    const ready = new Promise<void>((resolve) => { spawned = resolve; });
    await withTimingFakeAgy({ onSpawn: (args, child) => {
      Object.assign(child, { stdin: new PassThrough() });
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--add-dir" && args[i + 1].includes("pi-agy-bridge")) configDir = args[i + 1];
      }
      spawned();
    } }, async (children) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-integration-"));
      const driver = getProviderDriver(dir);
      const runner = getProviderRunner(dir);
      const parks: Array<{ callId: string; toolName: string }> = [];
      const notify = driver.notifyPark.bind(driver);
      const parkStub = mock.method(driver, "notifyPark", (park: Parameters<typeof driver.notifyPark>[0]) => { parks.push(park); return notify(park); });
      const factory = createRecordingFactory();
      const controller = new AbortController();
      const stream = createAgyStreamSimple(factory, { dir, entries: [...FALLBACK_PROVIDER_MODELS],
        tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
      });
      const client = new Client({ name: "lifecycle-probe", version: "1" }, { capabilities: {} });
      try {
        stream({ id: "gemini-3-8-flash" }, [{ role: "user", content: [
          { type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
        ] }], { signal: controller.signal });
        await awaitWithWatchdog(ready, "default runner spawn", 3000);
        const config = JSON.parse(await readFile(path.join(configDir, ".agents", "mcp_config.json"), "utf8"));
        const server = Object.values(config.mcpServers)[0] as { serverUrl: string; headers: Record<string, string> };
        await awaitWithWatchdog(client.connect(new StreamableHTTPClientTransport(new URL(server.serverUrl), {
          requestInit: { headers: { [BRIDGE_TOKEN_HEADER]: server.headers[BRIDGE_TOKEN_HEADER] } },
        })), "probe MCP connect", 2000);
        await fn({ dir, driver, runner, client, factory, controller, parks, child: [...children][0] });
      } finally {
        controller.abort();
        await awaitWithWatchdog(closeProviderDrivers(), "probe shutdown", 3000);
        await client.close();
        parkStub.mock.restore();
      }
    });
  });
}

function callProbeTool(client: Client, name = "read") {
  const result = awaitWithWatchdog(client.callTool({ name, arguments: {} }), "probe MCP tool", 2500);
  void result.catch(() => undefined);
  return result;
}

describe("default runner integration ownership", () => {
  for (const catalog of ["different-name", "different-mapping"]) {
    it(`preserves owner catalog and handler on rejected ${catalog} start`, { timeout: 7000 }, async () => {
      await withProviderLifecycleProbe(async ({ dir, driver, runner, client, factory, parks }) => {
        const firstCall = callProbeTool(client);
        await waitForStreamEnd(factory, 0);
        const resumed = awaitWithWatchdog(runner.resume([{ callId: parks[0].callId, text: "first", isError: false }]), "owner next park", 2000);
        void resumed.catch(() => undefined);
        await firstCall;
        await assert.rejects(runner.run({ dir, fullModel: "other", prompt: "foreign", signal: new AbortController().signal,
          timeoutMs: 1000, skipPermissions: false, bridgedTools: [{ name: catalog === "different-name" ? "write" : "read",
            piName: "foreign", description: "foreign", inputSchema: { type: "object" } }],
        }), /another agy turn/);
        const tools = await awaitWithWatchdog(client.listTools(), "owner catalog");
        assert.ok(tools.tools.some((tool) => tool.name === "read"));
        assert.equal(tools.tools.some((tool) => tool.name === "write"), false);
        const secondCall = callProbeTool(client);
        const next = await resumed;
        assert.equal(next.kind, "parked");
        if (next.kind === "parked") assert.equal(next.park.toolName, "read");
        assert.equal(driver.snapshot().stats.spawns, 1);
        runner.cancel();
        const failed = await secondCall;
        assert.equal(failed.isError, true);
      });
    });
  }

  for (const failure of ["abort", "close", "error"]) {
    it(`refuses suspension publication when ${failure} follows park acceptance before lock release`, { timeout: 7000 }, async () => {
      await withProviderLifecycleProbe(async ({ dir, driver, child, client, factory, controller }) => {
        const notify = driver.notifyPark.bind(driver);
        const stub = mock.method(driver, "notifyPark", (park: Parameters<typeof driver.notifyPark>[0]) => {
          const accepted = notify(park);
          assert.equal(accepted, true);
          // notifyPark resolved the phase, but no promise continuation or lock
          // release has run: orphan before the stream can publish its record.
          if (failure === "abort") controller.abort();
          if (failure === "close") child.close(3);
          if (failure === "error") child.emit("error", new Error("publication gap"));
          return accepted;
        });
        try {
          const call = callProbeTool(client);
          await waitForStreamEnd(factory, 0);
          assert.equal((await call).isError, true);
          assert.equal(factory.events.some((event) => event.type === "toolcall_start" || event.type === "toolcall_end"), false);
          assert.ok(factory.events.some((event) => event.type === "error"));
          assert.equal(getProviderStatus(dir).suspended.length, 0);
          await awaitWithWatchdog((async () => {
            while (getProviderStatus(dir).stagedImages) await new Promise((resolve) => nativeSetTimeout(resolve, 5));
          })(), "publication image cleanup");
          assert.equal(getProviderStatus(dir).stagedImages, 0);
          assert.throws(() => driver.continueTurn(), /no suspended turn/);
        } finally { stub.mock.restore(); }
      });
    });
  }

  for (const status of ["SUCCESS", "FAILED"]) {
    it(`discards unpolled escalations when retained ${status} is consumed`, { timeout: 7000 }, async () => {
      const timerStub = mock.method(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
        nativeSetTimeout(callback, ms === DEFAULT_PARK_ESCALATE_MS ? 5 : ms, ...args)) as typeof setTimeout);
      try {
        await withProviderLifecycleProbe(async ({ dir, child, runner, client, factory, parks }) => {
          const ack = callProbeTool(client);
          await waitForStreamEnd(factory, 0);
          assert.match(JSON.stringify(await ack), /STILL RUNNING/);
          assert.equal(getProviderStatus(dir).bridge?.pendingResults, 1);
          child.stdout.write(JSON.stringify({ event: "result", result: { status, response: "owned final" } }) + "\n");
          const resumed = runner.resume([{ callId: parks[0].callId, text: "large tool payload".repeat(1000), isError: false }]);
          if (status === "FAILED") await assert.rejects(awaitWithWatchdog(resumed, "retained failure"), /FAILED/);
          else assert.equal((await awaitWithWatchdog(resumed, "retained success")).kind, "done");
          // Inspect without polling: polling itself would consume and hide a leak.
          const bridge = getProviderStatus(dir).bridge;
          assert.equal(bridge?.pendingResults, 0);
        });
      } finally { timerStub.mock.restore(); }
    });
  }
});


it("keeps ordinary escalation polling available until the owning operation ends", { timeout: 7000 }, async () => {
  const timerStub = mock.method(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    nativeSetTimeout(callback, ms === DEFAULT_PARK_ESCALATE_MS ? 5 : ms, ...args)) as typeof setTimeout);
  try {
    await withProviderLifecycleProbe(async ({ dir, child, runner, client, factory, parks }) => {
      const ack = callProbeTool(client);
      await waitForStreamEnd(factory, 0);
      assert.match(JSON.stringify(await ack), /STILL RUNNING/);
      const resumed = awaitWithWatchdog(runner.resume([{ callId: parks[0].callId, text: "ordinary output", isError: false }]), "ordinary resumed terminal");
      void resumed.catch(() => undefined);
      assert.equal(getProviderStatus(dir).bridge?.pendingResults, 1);
      const poll = await awaitWithWatchdog(client.callTool({ name: "bridge_poll_result", arguments: { callId: parks[0].callId } }), "ordinary live polling");
      assert.match(JSON.stringify(poll), /ordinary output/);
      assert.equal(getProviderStatus(dir).bridge?.pendingResults, 0);
      child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"after polling"}}\n');
      const done = await resumed;
      assert.equal(done.kind, "done");
      if (done.kind === "done") assert.equal(done.result.text, "after polling");
    });
  } finally { timerStub.mock.restore(); }
});
