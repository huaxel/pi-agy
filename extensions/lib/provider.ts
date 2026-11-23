/**
 * Antigravity provider turn runtime (`antigravity/*` models in `/model`).
 *
 * Each Pi turn runs on a persistent agy driver process (see
 * provider-driver.ts) with full transcript rendering on cold start and delta
 * prompts on synced resumed conversations. Response text and real model
 * thinking stream into Pi's TUI, while agy step/tool progress routes to Pi's
 * live status bar. By default, a loopback MCP bridge parks agy's Pi-tool
 * calls (micro-batched for parallel calls) for execution by Pi, so its normal
 * permissions, approvals, and diff review apply. The bridge is separate from
 * agy's own tools and can be disabled with `providerBridge: false`.
 */

import { randomBytes } from "node:crypto";
import * as path from "node:path";

import { loadAgyConfig } from "./config.js";
import {
  BUILTIN_BRIDGE_TOOL_NAMES,
  projectBridgeTools,
  bridgeToolsFingerprint,
  type ProviderToolSource,
} from "./provider-tools.js";
export { projectBridgeTools, bridgeToolsFingerprint, type ProviderToolSource } from "./provider-tools.js";

import {
  clearImageStaging,
  collectImageBlocks,
  ensureImageStagingRoot,
  getLiveImageStagingCount,
  renderProviderDeltaPrompt,
  renderProviderPrompt,
  stageImages,
  textFingerprint,
  textOfContent,
  transcriptFingerprint,
  type ProviderTranscriptMessage,
} from "./provider-prompt.js";
export {
  clearImageStaging,
  collectImageBlocks,
  ensureImageStagingRoot,
  imageExtension,
  renderProviderDeltaPrompt,
  renderProviderPrompt,
  stageImages,
  textFingerprint,
  transcriptFingerprint,
  MAX_ENCODED_IMAGE_CHARS,
  MAX_IMAGE_BYTES,
  MAX_STAGED_IMAGES,
  decodedImageBytes,
  type PromptImageBlock,
  type ProviderTranscriptMessage,
  type RenderProviderPromptOptions,
  type StagedImages,
} from "./provider-prompt.js";

import { withDirLock } from "./lock.js";
import type { McpBridgeHandle } from "./provider-mcp.js";
import type { BridgeToolDef } from "./provider-tools.js";
import {
  anchorUsageSnapshot,
  getSession,
  normalizeTranscriptAnchor,
  saveSession,
  snapshotFromAnchor,
  type AgySessionRecord,
  type TranscriptAnchor,
} from "./sessions.js";
import { AgyProviderDriver, PROVIDER_TURN_TIMEOUT_MS } from "./provider-driver.js";
import type { AgySubagentSummary } from "./subagents.js";
import type { NormalizedProviderUsage, ValidatedAgyUsage } from "./provider-usage.js";
export {
  diffAgyUsage,
  validateAgyUsage,
  ZERO_USAGE_BASELINE,
  type NormalizedProviderUsage,
  type ValidatedAgyUsage,
} from "./provider-usage.js";
import {
  toProviderEffort,
  validateAgyModelId,
  type AgyModelId,
  type AgyProviderEffort,
  type AgyProviderModelEntry,
  type AgyThinkingLevel,
} from "./provider-models.js";

/** Provider id registered with Pi. Collides with the bridge package — do not install both. */
export const AGY_PROVIDER_ID = "antigravity";

/** Custom API sentinel; no built-in provider claims it. */
export const AGY_PROVIDER_API = "agy-provider";


export interface ProviderTurnCallbacks {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onActivity?: (label: string) => void;
}

/**
 * Session-only `agy --settings` JSON for a bridged turn: always deny agy's
 * built-in shell and file-write tools.
 *
 * This used to deny a native tool only when Pi bridged its equivalent, which
 * inverted the policy: a Pi session with a restricted allowlist (no `bash`, no
 * `write`) got *no* deny rules, so agy's own shell stayed reachable under the
 * default `--dangerously-skip-permissions`. The two cases are the same rule
 * from opposite sides — capabilities come only from bridged Pi tools, which
 * carry Pi's approvals and diffs:
 *
 * - equivalent bridged: the native tool would shadow Pi's approval path;
 * - equivalent absent: Pi does not grant that capability at all, so the native
 *   tool would act outside the allowlist the user configured.
 *
 * Intentionally emits only `deny` rules (no blanket `allow`) so other MCP
 * servers keep the user's configured permission policy. Verified against agy
 * 1.5.14 by `npm run test:bridge`: agy reports the request as "blocked by a
 * permission check matching a user-configured deny rule", the file is never
 * created, and the same request without the document does run.
 */
export function buildProviderPermissionSettings(): string {
  return JSON.stringify({ permissions: { deny: ["command(*)", "write_file(*)"] } });
}

export interface ProviderTurnRequest {
  /** Exact agy `--model` value (base or qualified slug). */
  fullModel: string;
  /** Pass `--effort` (effort-driven bases only). */
  effort?: AgyProviderEffort;
  prompt: string;
  dir: string;
  signal: AbortSignal;
  timeoutMs: number;
  /** Resume this agy conversation instead of starting a new one. */
  resumeConversationId?: string;
  /** Cumulative usage snapshot an earlier process recorded for that conversation. */
  usageBaseline?: ValidatedAgyUsage;
  skipPermissions: boolean;
  /** Pi tools projected for this turn (refreshed per turn). */
  bridgedTools: BridgeToolDef[];
  callbacks?: ProviderTurnCallbacks;
}

/** A bridged Pi-tool call parked mid-turn; agy waits on the MCP response. */
export interface ProviderToolPark {
  callId: string;
  /** Real Pi tool name. */
  toolName: string;
  args: Record<string, unknown>;
}

/** A parked phase may publish only while its originating operation still owns it. */
export interface ProviderTurnOwnership {
  assertValid: () => void;
}

export type ProviderRunEnd =
  | { kind: "done"; result: ProviderTurnResult }
  | { kind: "parked"; park: ProviderToolPark; parks?: ProviderToolPark[]; ownership?: ProviderTurnOwnership };

export interface ProviderToolDelivery {
  callId: string;
  text: string;
  isError: boolean;
}

/**
 * Round-trip runner: `run` starts a driver turn (first phase end),
 * `resume` delivers Pi tool results and waits for the next end, `cancel`
 * abandons a suspended turn. One Pi turn maps to one call.
 */
export interface ProviderTurnRunner {
  run: (request: ProviderTurnRequest) => Promise<ProviderRunEnd>;
  resume: (
    deliveries: ProviderToolDelivery[],
    callbacks?: ProviderTurnCallbacks,
    signal?: AbortSignal,
    timeoutMs?: number,
  ) => Promise<ProviderRunEnd>;
  cancel: (ownership?: ProviderTurnOwnership) => void;
}

export interface ProviderTurnResult {
  text: string;
  truncated: boolean;
  /** True when the text below is partial because the turn was cancelled. */
  aborted?: boolean;
  /** True when the text below is partial because the turn hit its deadline. */
  timedOut?: boolean;
  conversationId?: string;
  /** Bounded agy tool-activity labels observed during the turn. */
  activity: string[];
  deniedActions?: Array<{ action?: string; display_name?: string }>;
  /** Validated per-turn native usage delta, when available. */
  usage?: NormalizedProviderUsage;
  /** Cumulative conversation usage after this turn, for the session store. */
  usageSnapshot?: ValidatedAgyUsage;
}

/**
 * Default runner: driver turns serialized on the per-directory lock so a
 * provider turn can never race a delegation run (or another provider turn)
 * in the same directory. Lock waits count against the turn timeout. One
 * runner per directory, shared across Pi turns so suspended (parked) turns
 * resume on the same driver.
 */
export function getProviderRunner(dir: string): ProviderTurnRunner {
  const key = path.resolve(dir);
  const existing = providerRunners.get(key);
  if (existing) return existing;
  const driver = getProviderDriver(dir);
  interface Operation extends ProviderTurnOwnership {
    failure?: Error;
    parks: Set<string>;
    bridge?: McpBridgeHandle;
  }
  let operation: Operation | undefined;
  const release = (owned: Operation, error: Error): void => {
    owned.failure ??= error;
    if (operation === owned) operation = undefined;
    owned.bridge?.discardParks(owned.parks);
    owned.parks.clear();
    const stale = suspendedByDir.get(key);
    if (stale?.ownership === owned) {
      suspendedByDir.delete(key);
      void runImageCleanups(stale.imageCleanups);
    }
  };
  const finishPhase = (owned: Operation, end: Parameters<typeof toRunEnd>[0]): ProviderRunEnd => {
    owned.assertValid();
    const result = toRunEnd(end);
    if (result.kind === "parked") return { ...result, ownership: owned };
    release(owned, new Error("agy provider operation completed"));
    return result;
  };
  const runner: ProviderTurnRunner = {
    run: (request) => {
      const lockStart = Date.now();
      return withDirLock(request.dir, async () => {
        // Reserve before any await or bridge mutation. Resumes stay lock-free,
        // so the workspace lock alone cannot protect this operation's catalog.
        if (operation) throw new Error("another agy turn owns this driver (running or suspended awaiting Pi tools)");
        const owned: Operation = {
          parks: new Set(),
          assertValid: () => { if (owned.failure) throw owned.failure; },
        };
        operation = owned;
        try {
          const waited = Date.now() - lockStart;
          const remaining = Math.max(5_000, request.timeoutMs - waited);
          const bridge = await ensureProviderBridge(request.dir).catch(() => undefined);
          const guardError = bridgeGuardError({
            dir: request.dir,
            bridgeFailure: bridge ? undefined : providerBridgeFailure(request.dir),
            skipPermissions: request.skipPermissions,
          });
          if (guardError) throw new Error(guardError);
          owned.bridge = bridge;
          // Workspace-scoped: this child may read its own workspace's staged
          // attachments, never another workspace's.
          const imageRoot = await ensureImageStagingRoot(request.dir).catch(() => undefined);
          owned.assertValid();
          const fingerprint = bridgeToolsFingerprint(request.bridgedTools);
          driver.onParksOrphaned = (message) => {
            bridge?.failAllParks(message);
            // The latch also survives the gap before the stream publishes a
            // suspension: a resolved parked phase cannot resurrect an orphan.
            release(owned, new Error(message));
          };
          if (bridge) {
            bridge.setTools(request.bridgedTools);
            bridge.setParkHandler((park) => {
              if (owned.failure) return false;
              owned.parks.add(park.callId);
              const accepted = driver.notifyPark(park);
              if (!accepted) owned.parks.delete(park.callId);
              return accepted;
            });
          }
          const end = await driver.turn({
            dir: request.dir, fullModel: request.fullModel, effort: request.effort,
            skipPermissions: request.skipPermissions, bridgeDir: bridge?.configDir,
            bridgeTools: bridge ? fingerprint : undefined, imageRoot,
            settingsJson: bridge ? buildProviderPermissionSettings() : undefined,
          }, {
            prompt: request.prompt, resumeConversationId: request.resumeConversationId,
            usageBaseline: request.usageBaseline,
            signal: request.signal, timeoutMs: remaining,
            onText: request.callbacks?.onText, onThinking: request.callbacks?.onThinking,
            onActivity: request.callbacks?.onActivity,
          });
          return finishPhase(owned, end);
        } catch (error) {
          release(owned, error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      }, request.signal, request.timeoutMs);
    },
    resume: async (deliveries, callbacks, resumeSignal, resumeTimeoutMs) => {
      // Deliberately lock-free: a parked Pi tool may itself hold the workspace
      // lock. Taking it here would wait on the work this resume must complete.
      const owned = operation;
      if (!owned) throw new Error("agy provider driver has no suspended operation");
      owned.assertValid();
      const bridge = owned.bridge;
      if (!bridge) throw new Error("agy provider turn has no bridge to resume on");
      if (!deliveries.length || deliveries.some((delivery) => !owned.parks.has(delivery.callId))) {
        throw new Error("agy provider tool delivery does not belong to the suspended operation");
      }
      try {
        for (const delivery of deliveries) {
          bridge.completePark(delivery.callId, { text: delivery.text, isError: delivery.isError });
        }
        const end = await driver.continueTurn({
          signal: resumeSignal, timeoutMs: resumeTimeoutMs,
          onText: callbacks?.onText, onThinking: callbacks?.onThinking,
          onActivity: callbacks?.onActivity,
        });
        return finishPhase(owned, end);
      } catch (error) {
        release(owned, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    },
    cancel: (ownership) => {
      const owned = operation;
      if (!owned || (ownership && ownership !== owned)) return;
      driver.cancelSuspended("agy provider turn was cancelled");
      owned.bridge?.failAllParks("agy provider turn was cancelled");
      release(owned, new Error("agy provider turn was cancelled"));
    },
  };
  providerRunners.set(key, runner);
  return runner;
}

function toRunEnd(
  end:
    | { kind: "done"; outcome: ProviderTurnResult }
    | {
        kind: "parked";
        park: { callId: string; toolName: string; args: Record<string, unknown> };
        parks?: Array<{ callId: string; toolName: string; args: Record<string, unknown> }>;
      },
): ProviderRunEnd {
  if (end.kind === "parked") {
    const parks = (end.parks && end.parks.length > 0 ? end.parks : [end.park]).map((park) => ({
      callId: park.callId,
      toolName: park.toolName,
      args: park.args,
    }));
    return { kind: "parked", park: parks[0], parks };
  }
  return { kind: "done", result: end.outcome };
}

/**
 * Driver registry: one persistent agy process per working directory, shared
 * across turns. Reset via closeProviderDrivers() (session shutdown, tests).
 */
const providerDrivers = new Map<string, AgyProviderDriver>();
interface ProviderDiagnostics {
  promptMode?: "full" | "delta";
  promptFallbackReason?: string;
  /** The fallback started a fresh agy conversation because the transcript diverged. */
  conversationRestarted?: boolean;
  deniedActions: number;
}

const providerDiagnostics = new Map<string, ProviderDiagnostics>();

export function getProviderDriver(dir: string): AgyProviderDriver {
  // Resolve spelling variants (./, ../) to one driver per directory. (Symlink
  // variants still alias apart; the dir lock owns full canonicalization.)
  const key = path.resolve(dir);
  let driver = providerDrivers.get(key);
  if (!driver) {
    driver = new AgyProviderDriver();
    providerDrivers.set(key, driver);
  }
  return driver;
}

/**
 * MCP bridges, one per directory, started lazily on the first bridged turn.
 * A stored `undefined` means bridging is disabled or failed for the dir —
 * turns proceed plain instead of retrying a broken server every turn.
 */
const providerBridges = new Map<string, McpBridgeHandle | undefined>();

/**
 * Why a bridge is absent, when it is absent because it failed rather than
 * because `providerBridge: false` turned it off. The callers need the
 * difference: a plain turn is safe when the user asked for it and unsafe when
 * an approval bypass is active, since the bridge is what carries the deny
 * rules for agy's own shell and write tools.
 */
const providerBridgeFailures = new Map<string, string>();

async function ensureProviderBridge(dir: string): Promise<McpBridgeHandle | undefined> {
  const key = path.resolve(dir);
  if (providerBridges.has(key)) return providerBridges.get(key);
  let handle: McpBridgeHandle | undefined;
  try {
    const config = await loadAgyConfig();
    if (config.providerBridge !== false) {
      // Keep the bridge and its MCP SDK off the extension startup path.
      const { startMcpBridge } = await import("./provider-mcp.js");
      handle = await startMcpBridge(dir);
      providerBridgeFailures.delete(key);
    }
  } catch (error) {
    handle = undefined;
    providerBridgeFailures.set(key, error instanceof Error ? error.message : String(error));
  }
  providerBridges.set(key, handle);
  return handle;
}

/** The start failure recorded for this directory, if bridging failed. */
export function providerBridgeFailure(dir: string): string | undefined {
  return providerBridgeFailures.get(path.resolve(dir));
}

/**
 * Decide whether a turn may proceed when the bridge is absent.
 *
 * Three states hide behind an absent bridge: healthy-but-off on purpose
 * (`providerBridge: false`), not yet attempted, and failed to start. Only the
 * last one is a surprise, and it is dangerous exactly when an approval bypass
 * is active — that is when the missing deny rules leave agy's own shell and
 * write tools unmediated while the turn still looks normal.
 */
export function bridgeGuardError(input: {
  dir: string;
  bridgeFailure?: string;
  skipPermissions: boolean;
}): string | undefined {
  if (!input.bridgeFailure || !input.skipPermissions) return undefined;
  return (
    `agy provider bridge failed to start for ${input.dir}: ${input.bridgeFailure}. ` +
    "Refusing to run with the permission bypass and no Pi tool policy. " +
    "Fix the bridge, disable skipPermissions, or set providerBridge: false " +
    "in agy-config.json to run plain deliberately."
  );
}

const providerRunners = new Map<string, ProviderTurnRunner>();

/** Stop memoized bridges so the next turn re-resolves them (toggle support). */
export async function resetProviderBridges(): Promise<void> {
  const bridges = [...providerBridges.values()];
  providerBridges.clear();
  // A recorded failure is what refuses the next turn, so a deliberate reset
  // (bridge toggle, config change) must clear it too — otherwise the refusal
  // outlives the condition it reported.
  providerBridgeFailures.clear();
  await Promise.all(
    bridges.map((bridge) => bridge?.stop().catch(() => undefined)),
  );
}

export interface ProviderBridgeStatus {
  dir: string;
  running: boolean;
  toolCount?: number;
}

/** Point-in-time bridge states for status surfaces. Never throws. */
export function describeProviderBridges(): ProviderBridgeStatus[] {
  const out: ProviderBridgeStatus[] = [];
  try {
    for (const [dir, bridge] of providerBridges) {
      const description = bridge?.describe();
      out.push({ dir, running: description?.listening ?? false, toolCount: description?.toolCount });
    }
  } catch {
    // Status surfaces must never break callers.
  }
  return out;
}

export interface ProviderStatusSuspended {
  toolCallId: string;
  toolName: string;
  modelId: string;
}

export interface ProviderStatus {
  dir: string;
  /** Driver snapshot, when a driver exists for the directory. */
  driver?: {
    state: string;
    turns: number;
    reuses: number;
    recycles: number;
    lastRecycleReason?: string;
    boundConversationId?: string;
    /** Live aggregate of the active turn's subagents, when any launched. */
    subagents?: AgySubagentSummary;
  };
  /** Bridge description, when a bridge is running for the directory. */
  bridge?: { toolCount: number; pendingResults: number; listening: boolean };
  /** Why the bridge failed to start for this directory, when it did. */
  bridgeFailure?: string;
  /** Suspended turns awaiting Pi tool results. */
  suspended: ProviderStatusSuspended[];
  /** Most recent prompt construction and denied-action observations for this workspace. */
  diagnostics?: ProviderDiagnostics;
  /** Live image staging dirs process-wide. */
  stagedImages: number;
}

/** Non-creating driver lookup (status surfaces must not spawn state). */
export function peekProviderDriver(dir: string): AgyProviderDriver | undefined {
  return providerDrivers.get(path.resolve(dir));
}

/** Point-in-time provider status for doctor and debugging. Never throws. */
export function getProviderStatus(dir: string): ProviderStatus {
  const key = path.resolve(dir);
  const suspended: ProviderStatusSuspended[] = [];
  for (const [suspendedDir, entry] of suspendedByDir) {
    if (suspendedDir === key) {
      for (const call of entry.calls) {
        suspended.push({ toolCallId: call.toolCallId, toolName: call.park.toolName, modelId: entry.modelId });
      }
    }
  }
  try {
    const driver = providerDrivers.get(key);
    const snapshot = driver?.snapshot();
    const description = providerBridges.get(key)?.describe();
    return {
      dir: key,
      driver: snapshot
        ? {
            state: snapshot.state,
            turns: snapshot.stats.turns,
            reuses: snapshot.stats.reuses,
            recycles: snapshot.stats.recycles,
            lastRecycleReason: snapshot.stats.lastRecycleReason,
            boundConversationId: snapshot.boundConversationId,
            subagents: snapshot.subagents,
          }
        : undefined,
      bridge: description
        ? {
            toolCount: description.toolCount,
            pendingResults: description.pendingResults,
            listening: description.listening,
          }
        : undefined,
      bridgeFailure: providerBridgeFailures.get(key),
      diagnostics: providerDiagnostics.get(key),
      suspended,
      stagedImages: getLiveImageStagingCount(),
    };
  } catch {
    return { dir: key, suspended, stagedImages: 0 };
  }
}

/** Kill all driver processes and drop them; the next turn respawns lazily. */
export async function closeProviderDrivers(): Promise<void> {
  const drivers = [...providerDrivers.values()];
  providerDrivers.clear();
  providerDiagnostics.clear();
  providerRunners.clear();
  clearSuspendedTurns();
  await clearImageStaging();
  await Promise.all(drivers.map((driver) => driver.close()));
  await resetProviderBridges();
}

export interface AgyProviderStreamDeps {
  entries: AgyProviderModelEntry[];
  runner?: ProviderTurnRunner;
  /** Working directory for agy turns. Defaults to process.cwd() at turn time. */
  dir?: string;
  skipPermissions?: boolean;
  timeoutMs?: number;
  /** Pi tools to bridge into agy turns (projected per turn by the caller). */
  tools?: ProviderToolSource[];
  /** Live status callback for agy step/tool progress (undefined clears status). */
  onActivity?: (label: string | undefined) => void;
}

export interface AgyStreamSimpleModel {
  id: string;
}

export interface AgyStreamSimpleOptions {
  signal?: AbortSignal;
  reasoning?: AgyThinkingLevel;
  /** Active Pi tools for this turn (bridged into agy). */
  tools?: ProviderToolSource[];
}

/**
 * Minimal event-stream + message types (structural subset of Pi's pi-ai
 * types) so this module is unit-testable with fakes. The extension entry
 * passes the real `createAssistantMessageEventStream` from pi-ai.
 */
export interface AgyEventStream {
  push: (event: Record<string, unknown>) => void;
  end: () => void;
}

export interface AgyStreamFactory {
  createStream: () => AgyEventStream;
  getSystemPrompt: (messages: ProviderTranscriptMessage[]) => string;
}

/** Resolve the catalog entry + effort for a selected provider model id. */
export function resolveProviderTurnModel(
  entries: AgyProviderModelEntry[],
  modelId: string,
  reasoning?: AgyThinkingLevel,
): { full: string; effort?: AgyProviderEffort } {
  const entry = entries.find((candidate) => candidate.id === modelId);
  if (!entry) {
    throw new Error(
      `Unknown ${AGY_PROVIDER_ID} model '${modelId}'; pick another via /model (the agy catalog may have changed — reopen /model to refresh).`,
    );
  }
  const effort =
    entry.efforts && entry.efforts.length > 0
      ? toProviderEffort(reasoning, entry.efforts)
      : undefined;
  return { full: entry.full, effort };
}

/**
 * Collect Pi tool result bodies addressed to a suspended shadow tool call.
 * The bridge call id comes from the suspension itself: the shadow id only
 * exists in Pi's transcript, while agy waits on the bridge's park id.
 * Mixing them up strands agy on an uncompletable call.
 */
export function collectParkedDeliveries(
  messages: ProviderTranscriptMessage[],
  toolCallId: string,
): Array<{ text: string; isError: boolean }> {
  const deliveries: Array<{ text: string; isError: boolean }> = [];
  for (const message of messages) {
    if (message.role !== "toolResult" || message.toolCallId !== toolCallId) continue;
    deliveries.push({
      text: textOfContent(message.content).trim(),
      isError: message.isError === true,
    });
  }
  return deliveries;
}

/** Does the transcript hold our shadow toolCall (same or later, any result)? */
function transcriptHasToolCall(messages: ProviderTranscriptMessage[], toolCallId: string): boolean {
  return messages.some((message) => {
    const content = message.content;
    if (!Array.isArray(content)) return false;
    return content.some(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "toolCall" &&
        (block as Record<string, unknown>).id === toolCallId,
    );
  });
}

/** Is there a non-empty user message after our shadow toolCall? */
function hasUserMessageAfterToolCall(messages: ProviderTranscriptMessage[], toolCallId: string): boolean {
  let seenCall = false;
  for (const message of messages) {
    if (!seenCall) {
      if (transcriptHasToolCall([message], toolCallId)) seenCall = true;
      continue;
    }
    if (message.role === "user" && textOfContent(message.content).trim()) return true;
  }
  return false;
}

/**
 * Whether the persisted conversation is a continuation of *this* transcript.
 *
 * `last_conversation_id` is per directory, so it answers "newest in this
 * workspace" — not "mine". Resuming on that alone let a second Pi session in
 * the same checkout, or a transcript that came from another provider, inherit
 * and append to a conversation it never took part in. The stored anchor makes
 * the claim checkable: the transcript must still start with exactly the
 * messages that conversation consumed, and must have grown past them.
 *
 * A record written before anchors existed cannot prove anything, so it is not
 * resumed; a transcript that has not grown past the anchor is not a
 * continuation either.
 */
export function transcriptContinuesConversation(
  anchor: { count: number; fingerprint: string } | undefined,
  messages: readonly ProviderTranscriptMessage[],
): boolean {
  if (!anchor || !Number.isInteger(anchor.count) || anchor.count <= 0) return false;
  if (typeof anchor.fingerprint !== "string" || anchor.fingerprint.length === 0) return false;
  const conversational = messages.filter((message) => message.role !== "system");
  if (conversational.length <= anchor.count) return false;
  return transcriptFingerprint(conversational.slice(0, anchor.count)) === anchor.fingerprint;
}

/** Anchor for the messages an agy turn just consumed. */
function transcriptAnchor(
  messages: readonly ProviderTranscriptMessage[],
): { count: number; fingerprint: string } {
  // System messages carry Pi's tool catalog and prompt deltas, which change
  // mid-session for reasons unrelated to the conversation. Excluding them keeps
  // the anchor about the exchange, not about the tool list.
  const conversational = messages.filter((message) => message.role !== "system");
  return { count: conversational.length, fingerprint: transcriptFingerprint(conversational) };
}

interface SuspendedToolCall {
  toolCallId: string;
  park: ProviderToolPark;
}

interface SuspendedTurn {
  /** Original executed selector, retained across reasoning/catalog changes and re-parks. */
  rawModelId: AgyModelId;
  runner: ProviderTurnRunner;
  ownership?: ProviderTurnOwnership;
  calls: SuspendedToolCall[];
  modelId: string;
  /** System prompt actually sent on the originating turn, preserved for delta sync. */
  systemPrompt: string;
  /** Bridged tool catalog fingerprint sent on the originating turn. */
  bridgeToolsKey: string;
  /** Image staging cleanups owned by the suspended turn. */
  imageCleanups: Array<() => Promise<void>>;
}

interface ConversationSyncState {
  conversationId: string;
  /** Fingerprint of the system prompt in force; never the prompt itself. */
  systemPromptHash: string;
  bridgeToolsKey: string;
  syncedInputCount: number;
  syncedInputFingerprint: string;
  syncedAssistantFingerprint: string;
  /** Cumulative usage the conversation had reached, for a cold resume. */
  usageSnapshot?: ValidatedAgyUsage;
}

/**
 * Rebuild the delta decision from the record an earlier process wrote. Every
 * field is compared again by the ladder below, so a stale record degrades to a
 * full prompt and never to a wrong delta.
 */
function syncFromAnchor(
  anchor: TranscriptAnchor | undefined,
): ConversationSyncState | undefined {
  if (!anchor?.assistant_fingerprint || !anchor.system_prompt_hash || !anchor.bridge_tools_key) {
    return undefined;
  }
  return {
    conversationId: "",
    systemPromptHash: anchor.system_prompt_hash,
    bridgeToolsKey: anchor.bridge_tools_key,
    syncedInputCount: anchor.count,
    syncedInputFingerprint: anchor.fingerprint,
    syncedAssistantFingerprint: anchor.assistant_fingerprint,
    ...(anchor.usage_snapshot ? { usageSnapshot: snapshotFromAnchor(anchor.usage_snapshot) } : {}),
  };
}

/** The anchor filed for the messages a turn consumed. */
function anchorForTurn(
  messages: readonly ProviderTranscriptMessage[],
  turn: { assistantFingerprint: string; systemPromptHash: string; bridgeToolsKey: string; usageSnapshot?: ValidatedAgyUsage },
): TranscriptAnchor {
  return {
    ...transcriptAnchor(messages),
    assistant_fingerprint: turn.assistantFingerprint,
    system_prompt_hash: turn.systemPromptHash,
    bridge_tools_key: turn.bridgeToolsKey,
    ...(turn.usageSnapshot ? { usage_snapshot: anchorUsageSnapshot(turn.usageSnapshot) } : {}),
  };
}

/** Run cleanups sequentially, never throwing. */
async function runImageCleanups(cleanups: Array<() => Promise<void>>): Promise<void> {
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch {
      // Best effort per handle.
    }
  }
}

// Suspended turns awaiting Pi tool results, keyed by directory. Entries are
// consumed only by the Pi turn delivering the matching toolResult; anything
// else leaves them untouched (another session's business) until the
// suspension wall timer fires. Module scope so teardown can reach them.
const suspendedByDir = new Map<string, SuspendedTurn>();

/** Drop all suspended-turn records (teardown, tests). Runners are untouched. */
export function clearSuspendedTurns(): void {
  suspendedByDir.clear();
}

/**
 * Build a `streamSimple` handler for the registered provider. Conversation
 * continuity: resume the in-memory conversation for this model when present,
 * else the session store's provider-recorded conversation, else start fresh.
 * Completed conversations are recorded to the session store so `/agy
 * sessions` can resume them.
 *
 * Bridged Pi tools round-trip through suspended turns: when agy calls one,
 * this emits a real shadow `toolCall` (Pi executes it with normal
 * permissions and review) and ends with `toolUse`; the Pi turn whose
 * transcript delivers the matching `toolResult` resumes the driver turn.
 */
export function createAgyStreamSimple(
  factory: AgyStreamFactory,
  deps: AgyProviderStreamDeps,
): (
  model: AgyStreamSimpleModel,
  messages: ProviderTranscriptMessage[],
  options?: AgyStreamSimpleOptions,
) => AgyEventStream {
  const resumeByModel = new Map<string, string>();
  const syncByModel = new Map<string, ConversationSyncState>();
  const getRunner = (dir: string): ProviderTurnRunner => deps.runner ?? getProviderRunner(dir);

  return (model, messages, options) => {
    const stream = factory.createStream();
    const output: {
      role: string;
      content: Array<Record<string, unknown>>;
      api: string;
      provider: string;
      model: string;
      usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        reasoning?: number;
        totalTokens: number;
        cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
      };
      stopReason: string;
      timestamp: number;
      errorMessage?: string;
    } = {
      role: "assistant",
      content: [],
      api: AGY_PROVIDER_API,
      provider: AGY_PROVIDER_ID,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };

    (async () => {
      let turnModel: { full: string; effort?: AgyProviderEffort };
      try {
        turnModel = resolveProviderTurnModel(deps.entries, model.id, options?.reasoning);
      } catch (error) {
        output.stopReason = "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
        return;
      }

      stream.push({ type: "start", partial: output });
      const dir = deps.dir ?? process.cwd();
      const signal = options?.signal ?? new AbortController().signal;
      // Image staging owned by this invocation until terminal settle; a
      // park transfers ownership into the suspension entry. Declared here
      // so both the try body and the catch below can clean it.
      const pendingImageCleanups: Array<() => Promise<void>> = [];
      const setActivityStatus = (label: string | undefined): void => {
        try {
          deps.onActivity?.(label);
        } catch {
          // Live status surfaces must never disrupt a turn.
        }
      };

      try {
        const systemPrompt = factory.getSystemPrompt(messages);
        // Only resume when the transcript already holds a prior assistant
        // turn: a fresh session (user message only) must start a new agy
        // conversation instead of inheriting stale context.
        const hasPriorAssistantTurn = messages.some((message) => message.role === "assistant");

        let textIndex = -1;
        let thinkingIndex = -1;
        const ensureText = (): number => {
          if (textIndex === -1) {
            output.content.push({ type: "text", text: "" });
            textIndex = output.content.length - 1;
            stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
          }
          return textIndex;
        };
        const ensureThinking = (): number => {
          if (thinkingIndex === -1) {
            output.content.push({ type: "thinking", thinking: "" });
            thinkingIndex = output.content.length - 1;
            stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
          }
          return thinkingIndex;
        };

        const callbacks: ProviderTurnCallbacks = {
          onText: (delta) => {
            const index = ensureText();
            const block = output.content[index] as { text: string };
            block.text += delta;
            stream.push({ type: "text_delta", contentIndex: index, delta, partial: output });
          },
          onThinking: (delta) => {
            const index = ensureThinking();
            const block = output.content[index] as { thinking: string };
            block.thinking += delta;
            stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: output });
          },
          onActivity: (label) => {
            setActivityStatus(label);
          },
        };

        const runner = getRunner(dir);
        const skey = path.resolve(dir);
        const prior = suspendedByDir.get(skey);
        const deliveredByCall = prior
          ? prior.calls.map((call) => ({
              call,
              bodies: collectParkedDeliveries(messages, call.toolCallId),
            }))
          : [];
        const hasCompleteDelivery =
          !!prior &&
          deliveredByCall.length > 0 &&
          deliveredByCall.every((entry) => entry.bodies.length > 0);
        let end: ProviderRunEnd;
        let executedRawModelId: AgyModelId;
        let activeSystemPrompt = systemPrompt;
        // Compared against a persisted hash, never against a stored prompt.
        let activeSystemPromptHash = textFingerprint(activeSystemPrompt ?? "");
        let activeBridgeToolsKey = "";
        if (prior && hasCompleteDelivery) {
          executedRawModelId = prior.rawModelId;
          activeSystemPrompt = prior.systemPrompt;
          activeSystemPromptHash = textFingerprint(activeSystemPrompt ?? "");
          activeBridgeToolsKey = prior.bridgeToolsKey;
          prior.ownership?.assertValid();
          suspendedByDir.delete(skey);
          const resumeCleanups = [...prior.imageCleanups];
          // Deliver by bridge park id (what agy waits on), matched via the
          // shadow toolCall id (what Pi's transcript carries). Images riding
          // on each delivered tool result are staged per tool call.
          const deliveries: ProviderToolDelivery[] = [];
          for (const { call, bodies } of deliveredByCall) {
            const deliveryImages = await stageImages(
              collectImageBlocks(messages, call.toolCallId),
              dir,
            );
            resumeCleanups.push(deliveryImages.cleanup);
            const imageRefs = [...deliveryImages.paths.values()];
            for (const body of bodies) {
              deliveries.push({
                callId: call.park.callId,
                text:
                  body.text +
                  (imageRefs.length > 0
                    ? `\n[attached images saved at: ${imageRefs.join(", ")} — open them with your file tools to view]`
                    : ""),
                isError: body.isError,
              });
            }
          }
          try {
            end = await runner.resume(
              deliveries,
              callbacks,
              signal,
              deps.timeoutMs ?? PROVIDER_TURN_TIMEOUT_MS,
            );
          } catch (error) {
            // The suspended turn is gone (agy moved on without us): fail the
            // parks so nothing strands, then surface the failure loudly.
            try {
              runner.cancel(prior.ownership);
            } catch {
              // Cancel is best effort next to the real error.
            }
            await runImageCleanups(resumeCleanups);
            throw error;
          }
          // Staging ownership transfers to the shared settle below: a new
          // park carries it into the suspension, terminal settle cleans it.
          pendingImageCleanups.push(...resumeCleanups);
        } else {
          if (prior && prior.calls.some((call) => hasUserMessageAfterToolCall(messages, call.toolCallId))) {
            // Our own transcript moved on without delivering (abort, reject,
            // retry): cancel the stale suspension and start fresh instead
            // of bricking the directory behind the suspended guard.
            suspendedByDir.delete(skey);
            try {
              runner.cancel(prior.ownership);
            } catch {
              // Cancel is best effort next to a fresh turn.
            }
            await runImageCleanups(prior.imageCleanups);
          }
          let resume = hasPriorAssistantTurn ? resumeByModel.get(model.id) : undefined;
          let stored: AgySessionRecord | undefined;
          if (hasPriorAssistantTurn) {
            try {
              stored = await getSession(dir);
            } catch {
              // Session-store failures must never block a turn.
            }
          }
          if (!resume && hasPriorAssistantTurn && stored) {
            if (
              stored.last_conversation_id &&
              stored.last_model === model.id &&
              transcriptContinuesConversation(stored.last_transcript_anchor, messages)
            ) {
              resume = stored.last_conversation_id;
            }
          }
          const bridgedTools = projectBridgeTools(options?.tools ?? deps.tools ?? [], {
            reserved: BUILTIN_BRIDGE_TOOL_NAMES,
          });
          activeBridgeToolsKey = bridgeToolsFingerprint(bridgedTools);
          // A fresh process has no in-memory sync, but the record remembers what
          // the last completed turn actually sent. Seeding it is what lets a cold
          // resume send only the new messages instead of replaying the
          // transcript.
          if (resume && !syncByModel.has(model.id)) {
            const anchor =
              stored?.last_conversation_id === resume
                ? normalizeTranscriptAnchor(stored?.last_transcript_anchor)
                : undefined;
            const restored = syncFromAnchor(anchor);
            if (restored) syncByModel.set(model.id, { ...restored, conversationId: resume });
          }
          const sync = resume ? syncByModel.get(model.id) : undefined;
          // The stored anchor counts non-system messages: Pi's system prompt and
          // tool catalog ride in them and change for reasons unrelated to the
          // conversation. The delta ladder uses the same convention.
          const conversational = messages.filter((message) => message.role !== "system");
          const prefixDiverged =
            !!sync &&
            transcriptFingerprint(conversational.slice(0, sync.syncedInputCount)) !== sync.syncedInputFingerprint;
          const anchorDiverged =
            !!sync &&
            !prefixDiverged &&
            conversational.length > sync.syncedInputCount &&
            conversational[sync.syncedInputCount]?.role === "assistant" &&
            transcriptFingerprint([conversational[sync.syncedInputCount]]) !== sync.syncedAssistantFingerprint;
          const deltaFailureReason = !resume
            ? "no conversation to resume"
            : !sync
              ? "no synchronized in-memory prompt"
              : sync.conversationId !== resume
                ? "conversation changed"
                : sync.systemPromptHash !== activeSystemPromptHash
                  ? "system prompt changed"
                  : sync.bridgeToolsKey !== activeBridgeToolsKey
                    ? "tool catalog changed"
                    : prefixDiverged
                      ? "earlier transcript changed"
                      : conversational.length <= sync.syncedInputCount
                        ? "no new messages"
                        : conversational[sync.syncedInputCount]?.role !== "assistant"
                          ? "assistant anchor missing"
                          : anchorDiverged
                            ? "assistant anchor changed"
                            : undefined;
          const canDelta = deltaFailureReason === undefined;
          // A rewind, a regenerated reply or a compaction means agy already holds
          // turns Pi no longer has. Appending the rewritten transcript would keep
          // them in the model's context and replay the rest twice, so start clean
          // and let the full prompt *be* the conversation. The stored anchor
          // cannot cover this: it only gates resumes that come from the store.
          const conversationRestarted = !canDelta && (prefixDiverged || anchorDiverged);
          if (conversationRestarted) {
            resumeByModel.delete(model.id);
            resume = undefined;
          }
          let prompt: string;
          if (canDelta) {
            const deltaSync = sync!;
            const deltaMessages = messages.slice(deltaSync.syncedInputCount + 1);
            const staged = await stageImages(collectImageBlocks(deltaMessages), dir);
            pendingImageCleanups.push(staged.cleanup);
            prompt = renderProviderDeltaPrompt(deltaMessages, staged.paths);
          } else {
            // Materialize attached images as files agy's tools can open;
            // paths render inline, failures degrade to omitted notes. Held
            // for the driver turn: terminal settle below cleans it, a park
            // carries it into the suspension.
            const staged = await stageImages(collectImageBlocks(messages), dir);
            pendingImageCleanups.push(staged.cleanup);
            prompt = renderProviderPrompt(messages, systemPrompt || undefined, staged.paths, {
              bridgedToolNames: bridgedTools.map((tool) => tool.name),
            });
          }
          const nextDiagnostics: ProviderDiagnostics = {
            ...providerDiagnostics.get(skey),
            promptMode: canDelta ? "delta" : "full",
            promptFallbackReason: canDelta ? undefined : deltaFailureReason,
            deniedActions: providerDiagnostics.get(skey)?.deniedActions ?? 0,
          };
          // Absent rather than stale: a later turn that resumed normally must
          // not keep reporting the restart from an earlier one.
          if (conversationRestarted) nextDiagnostics.conversationRestarted = true;
          else delete nextDiagnostics.conversationRestarted;
          providerDiagnostics.set(skey, nextDiagnostics);
          // Capture before execution: later invocations can resolve a different
          // profile while this child remains parked on its original target.
          executedRawModelId = validateAgyModelId(
            turnModel.effort ? `${turnModel.full}-${turnModel.effort}` : turnModel.full,
          );
          end = await runner.run({
            fullModel: turnModel.full,
            effort: turnModel.effort,
            prompt,
            dir,
            signal,
            timeoutMs: deps.timeoutMs ?? PROVIDER_TURN_TIMEOUT_MS,
            resumeConversationId: resume,
            usageBaseline: sync?.usageSnapshot,
            skipPermissions: deps.skipPermissions ?? true,
            bridgedTools,
            callbacks,
          });
        }

        if (end.kind === "parked") {
          setActivityStatus(undefined);
          // Bridged Pi tool call(s): end any open blocks, then emit REAL
          // shadow toolCall blocks so Pi executes them with normal
          // permissions, approvals, and review. The Pi turn delivering the
          // matching toolResults resumes this driver turn.
          if (thinkingIndex !== -1) {
            const thinking = (output.content[thinkingIndex] as { thinking: string }).thinking;
            stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: thinking, partial: output });
          }
          if (textIndex !== -1) {
            const text = (output.content[textIndex] as { text: string }).text;
            stream.push({ type: "text_end", contentIndex: textIndex, content: text, partial: output });
          }
          const parks = end.parks && end.parks.length > 0 ? end.parks : [end.park];
          const calls: SuspendedToolCall[] = [];
          const toolCalls: Array<{
            type: "toolCall";
            id: string;
            name: string;
            arguments: Record<string, unknown>;
          }> = [];
          for (const park of parks) {
            const toolCallId = `agybridge-${randomBytes(8).toString("hex")}`;
            calls.push({ toolCallId, park });
            toolCalls.push({
              type: "toolCall",
              id: toolCallId,
              name: park.toolName,
              arguments: park.args,
            });
          }
          end.ownership?.assertValid();
          suspendedByDir.set(skey, {
            runner,
            ownership: end.ownership,
            calls,
            rawModelId: executedRawModelId,
            modelId: model.id,
            systemPrompt: activeSystemPrompt,
            bridgeToolsKey: activeBridgeToolsKey,
            imageCleanups: pendingImageCleanups,
          });
          for (const toolCall of toolCalls) {
            output.content.push(toolCall);
            const toolIndex = output.content.length - 1;
            stream.push({ type: "toolcall_start", contentIndex: toolIndex, partial: output });
            stream.push({ type: "toolcall_end", contentIndex: toolIndex, toolCall, partial: output });
          }
          output.usage.totalTokens =
            output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          output.stopReason = "toolUse";
          stream.push({ type: "done", reason: output.stopReason, message: output });
          stream.end();
          return;
        }
        const result = end.result;
        const previousDiagnostics = providerDiagnostics.get(skey);
        providerDiagnostics.set(skey, {
          ...previousDiagnostics,
          deniedActions: result.deniedActions?.length ?? 0,
        });
        setActivityStatus(undefined);

        if (thinkingIndex !== -1) {
          const thinking = (output.content[thinkingIndex] as { thinking: string }).thinking;
          stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: thinking, partial: output });
        }
        const index = textIndex === -1 ? ensureText() : textIndex;
        const block = output.content[index] as { text: string };
        // The terminal result is authoritative; activity and the empty-result
        // fallback supply content only when that result has no answer.
        let finalText = result.text ||
          (result.activity.length > 0 ? result.activity.join("\n") : "(agy returned no text)");
        if (result.truncated) finalText += "\n\n[truncated: agy response exceeded the provider cap]";
        if (result.deniedActions && result.deniedActions.length > 0) {
          finalText += `\n\n[warning: agy reported ${result.deniedActions.length} denied action(s) alongside this response]`;
        }
        if (result.aborted) finalText += "\n\n[note: turn cancelled — response is partial]";
        else if (result.timedOut) finalText += "\n\n[note: turn timed out — response is partial]";
        block.text = finalText;
        stream.push({ type: "text_end", contentIndex: index, content: finalText, partial: output });

        if (result.usage) {
          output.usage.input = result.usage.input;
          output.usage.output = result.usage.output;
          output.usage.cacheRead = result.usage.cacheRead;
          output.usage.cacheWrite = result.usage.cacheWrite;
          if (result.usage.reasoning !== undefined) {
            output.usage.reasoning = result.usage.reasoning;
          }
          output.usage.totalTokens = result.usage.totalTokens;
        } else {
          output.usage.totalTokens =
            output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
        }
        // Partial turns must never masquerade as clean stops: surface the
        // real terminal state so Pi retries or reports instead of accepting
        // truncated text as a complete answer.
        if (result.aborted) output.stopReason = "aborted";
        else if (result.timedOut) output.stopReason = "length";
        else output.stopReason = "stop";
        if (result.conversationId) {
          resumeByModel.set(model.id, result.conversationId);
          const syncedCount = messages.filter((message) => message.role !== "system").length;
          const syncState: ConversationSyncState | undefined =
            result.aborted || result.timedOut
              ? undefined
              : {
                  conversationId: result.conversationId,
                  systemPromptHash: activeSystemPromptHash,
                  bridgeToolsKey: activeBridgeToolsKey,
                  syncedInputCount: syncedCount,
                  syncedInputFingerprint: transcriptFingerprint(
                    messages.filter((message) => message.role !== "system"),
                  ),
                  syncedAssistantFingerprint: transcriptFingerprint([output]),
                  ...(result.usageSnapshot ? { usageSnapshot: result.usageSnapshot } : {}),
                };
          if (syncState) syncByModel.set(model.id, syncState);
          else syncByModel.delete(model.id);
          const latestUser = [...messages].reverse().find((message) => message.role === "user");
          const summary = textOfContent(latestUser?.content).trim().slice(0, 80) || undefined;
          try {
            // Preserve a delegation-recorded agent: provider turns must not
            // wipe the agent that /agy continue would otherwise restore.
            const prior = await getSession(dir).catch(() => undefined);
            // Native resume still keys on model.id. Delegation needs the exact
            // CLI ID, including the concrete Gemini tier represented by the
            // catalog's base + effort pair (never the normalized Pi ID).
            await saveSession(
              dir,
              result.conversationId,
              model.id,
              undefined,
              summary,
              prior?.last_agent,
              executedRawModelId,
              syncState
                ? anchorForTurn(messages, {
                    assistantFingerprint: syncState.syncedAssistantFingerprint,
                    systemPromptHash: syncState.systemPromptHash,
                    bridgeToolsKey: syncState.bridgeToolsKey,
                    ...(result.usageSnapshot ? { usageSnapshot: result.usageSnapshot } : {}),
                  })
                : transcriptAnchor(messages),
            );
          } catch {
            // Recording failures must never fail a completed turn.
          }
        }
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
        await runImageCleanups(pendingImageCleanups);
      } catch (error) {
        syncByModel.delete(model.id);
        setActivityStatus(undefined);
        output.stopReason = signal.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
        await runImageCleanups(pendingImageCleanups);
      }
    })();

    return stream;
  };
}
