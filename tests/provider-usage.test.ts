import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { AgyProviderDriver } from "../extensions/lib/provider-driver.js";
import {
  createAgyStreamSimple,
  diffAgyUsage,
  validateAgyUsage,
  ZERO_USAGE_BASELINE,
  type AgyEventStream,
  type AgyStreamFactory,
  type ProviderTurnRunner,
} from "../extensions/lib/provider.js";
/** Fixture catalog: production ships no builtin model ids. */
const TEST_CATALOG: AgyProviderModelEntry[] = [
  { full: "gemini-3.8-flash", id: "gemini-3-8-flash", efforts: ["low", "medium", "high"] },
];
import { awaitWithWatchdog, withTimingFakeAgy } from "./timing-helpers.js";
import type { AgyProviderModelEntry } from "../extensions/lib/provider-models.js";

function createRecordingFactory(): AgyStreamFactory & { events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  const stream: AgyEventStream = {
    push: (event) => { events.push(event); },
    end: () => { events.push({ type: "__end" }); },
  };
  return { events, createStream: () => stream, getSystemPrompt: () => "" };
}

async function waitForStreamEnd(factory: { events: Array<Record<string, unknown>> }, start: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!factory.events.slice(start).some((event) => event.type === "__end")) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for provider stream");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("provider usage normalization", () => {
  it("validates finite non-negative safe integers and rejects invalid shapes without coercion", () => {
    assert.deepEqual(
      validateAgyUsage({ input_tokens: 100, output_tokens: 25, cache_read_tokens: 300, thinking_tokens: 10, total_tokens: 125 }),
      { input: 100, output: 25, cacheRead: 300, thinking: 10 },
    );
    // Explicit measured zero is distinct from missing.
    assert.deepEqual(
      validateAgyUsage({ input_tokens: -0, output_tokens: 0, cache_read_tokens: 0, thinking_tokens: 0 }),
      { input: 0, output: 0, cacheRead: 0, thinking: 0 },
    );
    assert.equal(validateAgyUsage(undefined), undefined);
    assert.equal(validateAgyUsage(null), undefined);
    assert.equal(validateAgyUsage([]), undefined);
    assert.equal(validateAgyUsage({ input_tokens: 10 }), undefined);
    assert.equal(validateAgyUsage({ input_tokens: "10", output_tokens: 5 }), undefined);
    assert.equal(validateAgyUsage({ input_tokens: -1, output_tokens: 5 }), undefined);
    assert.equal(validateAgyUsage({ input_tokens: 1.5, output_tokens: 5 }), undefined);
    assert.equal(validateAgyUsage({ input_tokens: Number.NaN, output_tokens: 5 }), undefined);
    assert.equal(validateAgyUsage({ input_tokens: Number.POSITIVE_INFINITY, output_tokens: 5 }), undefined);
    assert.equal(validateAgyUsage({ input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 5 }), undefined);
    assert.equal(validateAgyUsage({ input_tokens: 10, output_tokens: 5, cache_read_tokens: -2 }), undefined);
  });

  it("diffs cumulative baselines into disjoint Pi usage and rejects regressions or overflow", () => {
    const delta = diffAgyUsage(
      { input: 160, output: 35, cacheRead: 350, thinking: 8 },
      { input: 100, output: 20, cacheRead: 300, thinking: 5 },
    );
    assert.deepEqual(delta, {
      input: 60,
      output: 15,
      cacheRead: 50,
      cacheWrite: 0,
      reasoning: 3,
      totalTokens: 125,
    });

    // Regression returns undefined instead of clamping to zero.
    assert.equal(
      diffAgyUsage(
        { input: 90, output: 25, cacheRead: 300, thinking: 5 },
        { input: 100, output: 20, cacheRead: 300, thinking: 5 },
      ),
      undefined,
    );

    // Overflow returns undefined.
    assert.equal(
      diffAgyUsage(
        { input: Number.MAX_SAFE_INTEGER, output: 1, cacheRead: 0 },
        ZERO_USAGE_BASELINE,
      ),
      undefined,
    );
  });
});

describe("provider driver cumulative usage accounting", () => {
  const profile = { dir: "/tmp", fullModel: "gemini-3.8-flash", effort: "medium" as const, skipPermissions: false };

  it("diffs consecutive turns on a warm fresh process and re-primes on counter regression", async () => {
    await withTimingFakeAgy({ onSpawn: (_args, child) => { Object.assign(child, { stdin: new PassThrough() }); } }, async (children) => {
      const driver = new AgyProviderDriver();
      try {
        const t1 = driver.turn(profile, { prompt: "one", signal: new AbortController().signal, timeoutMs: 2000 });
        await Promise.resolve();
        const child = [...children][0];
        child.stdout.write(JSON.stringify({
          event: "result",
          result: {
            status: "SUCCESS",
            response: "r1",
            conversation_id: "c1",
            usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 300, total_tokens: 120 },
          },
        }) + "\n");
        const r1 = await awaitWithWatchdog(t1, "turn 1");
        assert.equal(r1.kind, "done");
        if (r1.kind === "done") {
          assert.deepEqual(r1.outcome.usage, {
            input: 100, output: 20, cacheRead: 300, cacheWrite: 0, reasoning: 5, totalTokens: 420,
          });
        }

        // Turn 2 in same warm process: cumulative snapshot minus turn 1 baseline.
        const t2 = driver.turn(profile, { prompt: "two", resumeConversationId: "c1", signal: new AbortController().signal, timeoutMs: 2000 });
        await Promise.resolve();
        child.stdout.write(JSON.stringify({
          event: "result",
          result: {
            status: "SUCCESS",
            response: "r2",
            conversation_id: "c1",
            usage: { input_tokens: 160, output_tokens: 35, thinking_tokens: 8, cache_read_tokens: 350, total_tokens: 195 },
          },
        }) + "\n");
        const r2 = await awaitWithWatchdog(t2, "turn 2");
        assert.equal(r2.kind, "done");
        if (r2.kind === "done") {
          assert.deepEqual(r2.outcome.usage, {
            input: 60, output: 15, cacheRead: 50, cacheWrite: 0, reasoning: 3, totalTokens: 125,
          });
        }

        // Turn 3 with regressed counter: unavailable (undefined), re-primes baseline.
        const t3 = driver.turn(profile, { prompt: "three", resumeConversationId: "c1", signal: new AbortController().signal, timeoutMs: 2000 });
        await Promise.resolve();
        child.stdout.write(JSON.stringify({
          event: "result",
          result: {
            status: "SUCCESS",
            response: "r3",
            conversation_id: "c1",
            usage: { input_tokens: 10, output: 5, cache_read_tokens: 0 },
          },
        }) + "\n");
        const r3 = await awaitWithWatchdog(t3, "turn 3");
        assert.equal(r3.kind, "done");
        if (r3.kind === "done") assert.equal(r3.outcome.usage, undefined);
      } finally {
        await driver.close();
      }
    });
  });

  it("primes baseline on external cold resume without charging prior history, then diffs turn 2", async () => {
    await withTimingFakeAgy({ onSpawn: (_args, child) => { Object.assign(child, { stdin: new PassThrough() }); } }, async (children) => {
      const driver = new AgyProviderDriver();
      try {
        const t1 = driver.turn(profile, {
          prompt: "resumed",
          resumeConversationId: "external-conv",
          signal: new AbortController().signal,
          timeoutMs: 2000,
        });
        await Promise.resolve();
        const child = [...children][0];
        child.stdout.write(JSON.stringify({
          event: "result",
          result: {
            status: "SUCCESS",
            response: "primed",
            conversation_id: "external-conv",
            usage: { input_tokens: 5000, output_tokens: 800, cache_read_tokens: 10000 },
          },
        }) + "\n");
        const r1 = await awaitWithWatchdog(t1, "external resume prime");
        assert.equal(r1.kind, "done");
        if (r1.kind === "done") assert.equal(r1.outcome.usage, undefined);

        const t2 = driver.turn(profile, {
          prompt: "follow-up",
          resumeConversationId: "external-conv",
          signal: new AbortController().signal,
          timeoutMs: 2000,
        });
        await Promise.resolve();
        child.stdout.write(JSON.stringify({
          event: "result",
          result: {
            status: "SUCCESS",
            response: "next",
            conversation_id: "external-conv",
            usage: { input_tokens: 5120, output_tokens: 840, cache_read_tokens: 10200 },
          },
        }) + "\n");
        const r2 = await awaitWithWatchdog(t2, "external resume turn 2");
        assert.equal(r2.kind, "done");
        if (r2.kind === "done") {
          assert.deepEqual(r2.outcome.usage, {
            input: 120, output: 40, cacheRead: 200, cacheWrite: 0, totalTokens: 360,
          });
        }
      } finally {
        await driver.close();
      }
    });
  });
});

describe("provider streamSimple usage phase accounting", () => {
  it("reports zero on parked toolUse phases, native usage once on terminal phase, and ignores text length", async () => {
    const factory = createRecordingFactory();
    const runner: ProviderTurnRunner = {
      run: async ({ callbacks }) => {
        callbacks?.onText?.("pre-tool text 🚀🚀🚀");
        return {
          kind: "parked" as const,
          park: { callId: "p1", toolName: "read", args: {} },
        };
      },
      resume: async (_deliveries, callbacks) => {
        callbacks?.onText?.("streamed unicode answer 🎉".repeat(10));
        return {
          kind: "done" as const,
          result: {
            text: "final answer",
            truncated: false,
            activity: [],
            usage: { input: 60, output: 15, cacheRead: 50, cacheWrite: 0, reasoning: 3, totalTokens: 125 },
          },
        };
      },
      cancel: () => {},
    };
    const streamSimple = createAgyStreamSimple(factory, {
      entries: [...TEST_CATALOG],
      runner,
    });
    const start1 = factory.events.length;
    streamSimple({ id: "gemini-3-8-flash" }, [{ role: "user", content: "go" }], {});
    await waitForStreamEnd(factory, start1);
    const parkedDone = factory.events.find((e) => e.type === "done") as {
      message: { usage: { input: number; output: number; cacheRead: number; reasoning?: number; totalTokens: number }; content: Array<{ type: string; id: string }> };
    };
    assert.equal(parkedDone.message.usage.output, 0);
    assert.equal(parkedDone.message.usage.totalTokens, 0);
    assert.equal(parkedDone.message.usage.reasoning, undefined);

    const toolCall = parkedDone.message.content.find((b) => b.type === "toolCall")!;
    const start2 = factory.events.length;
    streamSimple(
      { id: "gemini-3-8-flash" },
      [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "toolCall", id: toolCall.id, name: "read", arguments: {} }] },
        { role: "toolResult", toolCallId: toolCall.id, toolName: "read", content: "ok", isError: false },
      ],
      {},
    );
    await waitForStreamEnd(factory, start2);
    const finalDone = factory.events.slice(start2).find((e) => e.type === "done") as {
      message: { usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; totalTokens: number } };
    };
    assert.deepEqual(
      {
        input: finalDone.message.usage.input,
        output: finalDone.message.usage.output,
        cacheRead: finalDone.message.usage.cacheRead,
        cacheWrite: finalDone.message.usage.cacheWrite,
        reasoning: finalDone.message.usage.reasoning,
        totalTokens: finalDone.message.usage.totalTokens,
      },
      { input: 60, output: 15, cacheRead: 50, cacheWrite: 0, reasoning: 3, totalTokens: 125 },
    );
  });
});
