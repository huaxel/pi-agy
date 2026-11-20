/**
 * Live provider-turn verification (opt-in, spends two real inference turns).
 *
 * `test:live` deliberately spends none: it only proves discovery and doctor
 * output. This script exercises the path that fixtures cannot fully cover —
 * a persistent `agy --input-format stream-json` child, the streaming envelope,
 * native usage, and the cumulative-counter differencing that keeps a reused
 * process from double-charging a second turn.
 *
 * Usage: `npm run test:provider` (optional: `-- <model-id>`).
 */
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { AgyProviderDriver } from "../extensions/lib/provider-driver.js";
import { resolveAgyModelId } from "../extensions/lib/args.js";
import { inspectAgyModels } from "../extensions/lib/inspect.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agy-live-provider-"));
const driver = new AgyProviderDriver({ idleMs: 60_000 });

const controller = new AbortController();
const timeoutMs = 120_000;

// Discovery first: the alias resolves only against an observed catalog, and the
// default alias keeps a budget-friendly target without naming a model id.
await inspectAgyModels(dir, controller.signal, timeoutMs);
const modelId = process.argv[2] ?? resolveAgyModelId("flash-low");
assert.ok(modelId, "no catalog match for flash-low; run `agy models` first");

const profile = {
  dir,
  fullModel: modelId,
  // No bypass: the prompts below need no tools, and a live test must not
  // inherit write permission from the provider default.
  skipPermissions: false,
};

// Keep both prompts cheap and tool-free; the assertion target is the envelope.
const firstPrompt = "Reply with only the single word: ok";
const secondPrompt = "Reply with only the single word: again";

try {
  const catalog = await inspectAgyModels(dir, controller.signal, timeoutMs);
  assert.ok(
    Object.values(catalog).includes(modelId),
    `${modelId} is not in the discovered catalog`,
  );

  const first = await driver.turn(profile, {
    prompt: firstPrompt,
    signal: controller.signal,
    timeoutMs,
  });
  assert.equal(first.kind, "done", "first live turn unexpectedly parked on a tool call");
  if (first.kind !== "done") throw new Error("unreachable");
  const firstOutcome = first.outcome;

  assert.ok(firstOutcome.text.trim().length > 0, "first live turn returned no text");
  assert.equal(firstOutcome.aborted, undefined, "first live turn reported aborted");
  assert.equal(firstOutcome.timedOut, undefined, "first live turn timed out");
  assert.ok(firstOutcome.conversationId, "first live turn reported no conversation id");
  assert.ok(firstOutcome.usage, "first live turn reported no native usage");
  const firstUsage = firstOutcome.usage;
  assert.ok(firstUsage.totalTokens > 0, "first live turn reported zero total tokens");
  assert.equal(
    firstUsage.totalTokens,
    firstUsage.input + firstUsage.output + firstUsage.cacheRead + firstUsage.cacheWrite,
    "usage total disagrees with its parts",
  );

  // The provider always continues the conversation it recorded, which is what
  // keeps the child alive: a turn without a resume target recycles instead.
  const second = await driver.turn(profile, {
    prompt: secondPrompt,
    resumeConversationId: firstOutcome.conversationId,
    signal: controller.signal,
    timeoutMs,
  });
  assert.equal(second.kind, "done", "second live turn unexpectedly parked on a tool call");
  if (second.kind !== "done") throw new Error("unreachable");
  const secondOutcome = second.outcome;

  assert.ok(secondOutcome.text.trim().length > 0, "second live turn returned no text");
  assert.ok(secondOutcome.usage, "second live turn reported no native usage");
  const secondUsage = secondOutcome.usage;
  // The child is reused and `result.usage` is cumulative for the session: the
  // delta must not restate the first turn. Prompt reuse makes the two turns
  // comparable in size, so a sum would stand out well above this bound.
  assert.ok(
    secondUsage.totalTokens < firstUsage.totalTokens * 2,
    `second turn usage ${secondUsage.totalTokens} looks cumulative, not a delta (first ${firstUsage.totalTokens})`,
  );

  const snapshot = driver.snapshot();
  assert.equal(snapshot.stats.reuses, 1, "the second turn did not reuse the persistent child");
  assert.equal(snapshot.stats.spawns, 1, "the second turn spawned a replacement child");

  console.log(
    JSON.stringify(
      {
        modelId,
        conversationId: firstOutcome.conversationId,
        first: {
          text: firstOutcome.text.trim().slice(0, 120),
          usage: firstUsage,
          activityEntries: firstOutcome.activity.length,
        },
        second: {
          text: secondOutcome.text.trim().slice(0, 120),
          usage: secondUsage,
        },
        driver: { spawns: snapshot.stats.spawns, reuses: snapshot.stats.reuses },
      },
      null,
      2,
    ),
  );
} finally {
  await driver.close();
  await rm(dir, { recursive: true, force: true });
}
