import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { AgyProviderDriver } from "../extensions/lib/provider-driver.js";
import {
  createAgyStreamSimple,
  diffAgyUsage,
  normalizeAgyUsage,
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

    // A baseline that never knew its thinking counter cannot be subtracted
    // from: charging the whole cumulative total to this turn is worse than
    // reporting no reasoning delta at all.
    const unknownBaseline = diffAgyUsage(
      { input: 160, output: 35, cacheRead: 350, thinking: 6 },
      { input: 100, output: 20, cacheRead: 300 },
    );
    assert.equal(unknownBaseline?.reasoning, undefined);
    // The other counters stay independently measurable.
    assert.equal(unknownBaseline?.output, 15);
    // A known-zero baseline still yields a reasoning delta.
    assert.equal(
      diffAgyUsage(
        { input: 10, output: 6, cacheRead: 0, thinking: 4 },
        ZERO_USAGE_BASELINE,
      )?.reasoning,
      4,
    );

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

  it("normalizes single-step usage directly into Pi usage with cacheRead included in totalTokens", () => {
    assert.deepEqual(
      normalizeAgyUsage({ input: 3187, output: 26, cacheRead: 10742, thinking: 21 }),
      {
        input: 3187,
        output: 26,
        cacheRead: 10742,
        cacheWrite: 0,
        reasoning: 21,
        totalTokens: 13955,
      },
    );
    assert.deepEqual(
      normalizeAgyUsage({ input: 2144, output: 1, cacheRead: 11885 }),
      {
        input: 2144,
        output: 1,
        cacheRead: 11885,
        cacheWrite: 0,
        totalTokens: 14030,
      },
    );
    assert.equal(
      normalizeAgyUsage({ input: Number.MAX_SAFE_INTEGER, output: 1, cacheRead: 0 }),
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

  it("keeps differing after a recycle that resumes the same conversation", async () => {
    await withTimingFakeAgy({ onSpawn: (_args, child) => { Object.assign(child, { stdin: new PassThrough() }); } }, async (children) => {
      const driver = new AgyProviderDriver();
      try {
        const t1 = driver.turn(profile, { prompt: "one", signal: new AbortController().signal, timeoutMs: 2000 });
        await Promise.resolve();
        [...children][0].stdout.write(JSON.stringify({
          event: "result",
          result: {
            status: "SUCCESS",
            response: "r1",
            conversation_id: "conv-keep",
            usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 300 },
          },
        }) + "\n");
        const r1 = await awaitWithWatchdog(t1, "turn 1");
        assert.equal(r1.kind, "done");
        if (r1.kind === "done") {
          assert.deepEqual(r1.outcome.usage, {
            input: 100, output: 20, cacheRead: 300, cacheWrite: 0, reasoning: 5, totalTokens: 420,
          });
        }

        // Changing the thinking tier recycles the child. agy's counters are
        // conversation-cumulative (verified live across processes), so the
        // resumed conversation keeps differing instead of re-priming to an
        // empty usage row.
        const t2 = driver.turn(
          { ...profile, effort: "high" },
          { prompt: "two", resumeConversationId: "conv-keep", signal: new AbortController().signal, timeoutMs: 2000 },
        );
        await Promise.resolve();
        assert.equal(children.size, 1, "the recycled child is the only live one");
        [...children][0].stdout.write(JSON.stringify({
          event: "result",
          result: {
            status: "SUCCESS",
            response: "r2",
            conversation_id: "conv-keep",
            usage: { input_tokens: 160, output_tokens: 35, thinking_tokens: 8, cache_read_tokens: 1350 },
          },
        }) + "\n");
        const r2 = await awaitWithWatchdog(t2, "turn 2 after recycle");
        assert.equal(r2.kind, "done");
        if (r2.kind === "done") {
          assert.deepEqual(r2.outcome.usage, {
            input: 60, output: 15, cacheRead: 1050, cacheWrite: 0, reasoning: 3, totalTokens: 1125,
          });
        }
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

  it("reports the last agent_response step usage on multi-step turns instead of the cumulative result sum", async () => {
    await withTimingFakeAgy({ onSpawn: (_args, child) => { Object.assign(child, { stdin: new PassThrough() }); } }, async (children) => {
      const driver = new AgyProviderDriver();
      try {
        const t1 = driver.turn(profile, { prompt: "read package.json", signal: new AbortController().signal, timeoutMs: 2000 });
        await Promise.resolve();
        const child = [...children][0];
        child.stdout.write(JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "c-multi",
            step_index: 1,
            state: "DONE",
            step_type: "agent_response",
            usage: { input_tokens: 12783, output_tokens: 72, thinking_tokens: 42, cache_read_tokens: 0, total_tokens: 12855 },
          },
        }) + "\n");
        // Subagent step usage belongs to a different context window and must be ignored.
        child.stdout.write(JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "c-multi",
            step_index: 2,
            state: "DONE",
            step_type: "subagent",
            usage: { input_tokens: 500, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 510 },
          },
        }) + "\n");
        child.stdout.write(JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "c-multi",
            step_index: 3,
            state: "DONE",
            step_type: "agent_response",
            text_delta: "0.8.4\n",
            usage: { input_tokens: 3187, output_tokens: 26, thinking_tokens: 21, cache_read_tokens: 10742, total_tokens: 3213 },
          },
        }) + "\n");
        // Non-DONE or all-zero step updates must not overwrite a real step's usage.
        child.stdout.write(JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "c-multi",
            step_index: 3,
            state: "ACTIVE",
            step_type: "agent_response",
            usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
          },
        }) + "\n");
        child.stdout.write(JSON.stringify({
          event: "result",
          result: {
            status: "SUCCESS",
            response: "0.8.4\n",
            conversation_id: "c-multi",
            usage: { input_tokens: 15970, output_tokens: 98, thinking_tokens: 63, cache_read_tokens: 10742, total_tokens: 16068 },
          },
        }) + "\n");
        const r1 = await awaitWithWatchdog(t1, "multi-step turn");
        assert.equal(r1.kind, "done");
        if (r1.kind === "done") {
          assert.deepEqual(r1.outcome.usage, {
            input: 3187,
            output: 26,
            cacheRead: 10742,
            cacheWrite: 0,
            reasoning: 21,
            totalTokens: 13955,
          });
          // Cumulative snapshot is still preserved for session persistence and fallback diffing.
          assert.deepEqual(r1.outcome.usageSnapshot, {
            input: 15970,
            output: 98,
            cacheRead: 10742,
            thinking: 63,
          });
        }
      } finally {
        await driver.close();
      }
    });
  });

  it("attaches per-step usage to parked toolUse phases and resets for the resumed phase", async () => {
    await withTimingFakeAgy({ onSpawn: (_args, child) => { Object.assign(child, { stdin: new PassThrough() }); } }, async (children) => {
      const driver = new AgyProviderDriver({ parkBatchMs: 0 });
      try {
        const t1 = driver.turn(profile, { prompt: "inspect file", signal: new AbortController().signal, timeoutMs: 2000 });
        await Promise.resolve();
        const child = [...children][0];
        child.stdout.write(JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "c-park",
            step_index: 1,
            state: "DONE",
            step_type: "agent_response",
            usage: { input_tokens: 12000, output_tokens: 60, thinking_tokens: 30, cache_read_tokens: 0, total_tokens: 12060 },
          },
        }) + "\n");
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(driver.notifyPark({ callId: "p1", toolName: "read", args: { path: "package.json" } }), true);
        const parked = await awaitWithWatchdog(t1, "parked phase");
        assert.equal(parked.kind, "parked");
        if (parked.kind === "parked") {
          assert.deepEqual(parked.usage, {
            input: 12000,
            output: 60,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 30,
            totalTokens: 12060,
          });
        }

        const resumed = driver.continueTurn({ signal: new AbortController().signal, timeoutMs: 2000 });
        child.stdout.write(JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "c-park",
            step_index: 3,
            state: "DONE",
            step_type: "agent_response",
            text_delta: "done",
            usage: { input_tokens: 2500, output_tokens: 12, thinking_tokens: 4, cache_read_tokens: 11000, total_tokens: 2512 },
          },
        }) + "\n");
        child.stdout.write(JSON.stringify({
          event: "result",
          result: {
            status: "SUCCESS",
            response: "done",
            conversation_id: "c-park",
            usage: { input_tokens: 14500, output_tokens: 72, thinking_tokens: 34, cache_read_tokens: 11000, total_tokens: 14572 },
          },
        }) + "\n");
        const final = await awaitWithWatchdog(resumed, "resumed done");
        assert.equal(final.kind, "done");
        if (final.kind === "done") {
          assert.deepEqual(final.outcome.usage, {
            input: 2500,
            output: 12,
            cacheRead: 11000,
            cacheWrite: 0,
            reasoning: 4,
            totalTokens: 13512,
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

  it("propagates per-step usage onto parked toolUse messages when the runner supplies it", async () => {
    const factory = createRecordingFactory();
    const runner: ProviderTurnRunner = {
      run: async () => ({
        kind: "parked" as const,
        park: { callId: "p1", toolName: "read", args: {} },
        usage: { input: 12000, output: 60, cacheRead: 0, cacheWrite: 0, reasoning: 30, totalTokens: 12060 },
      }),
      resume: async () => ({
        kind: "done" as const,
        result: {
          text: "final answer",
          truncated: false,
          activity: [],
          usage: { input: 2500, output: 12, cacheRead: 11000, cacheWrite: 0, reasoning: 4, totalTokens: 13512 },
        },
      }),
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
      message: {
        stopReason: string;
        usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; totalTokens: number };
      };
    };
    assert.equal(parkedDone.message.stopReason, "toolUse");
    assert.deepEqual(
      {
        input: parkedDone.message.usage.input,
        output: parkedDone.message.usage.output,
        cacheRead: parkedDone.message.usage.cacheRead,
        cacheWrite: parkedDone.message.usage.cacheWrite,
        reasoning: parkedDone.message.usage.reasoning,
        totalTokens: parkedDone.message.usage.totalTokens,
      },
      { input: 12000, output: 60, cacheRead: 0, cacheWrite: 0, reasoning: 30, totalTokens: 12060 },
    );
  });
});
