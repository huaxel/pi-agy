/**
 * Antigravity provider turn runtime (`antigravity/*` models in `/model`).
 *
 * Each Pi turn runs on a persistent agy driver process (see
 * provider-driver.ts) with the transcript rendered as text. Response text
 * streams back into Pi's TUI; agy's own tool activity surfaces as thinking
 * events (`[agy tool: …]`) for visibility.
 *
 * Architectural wall (Phase 1): agy runs its OWN closed tool loop against
 * the working directory. Pi's read/write/edit/bash tools never fire for
 * these turns, so Pi's inline diff review does not engage — edits already
 * landed on disk. Full Pi-tool bridging (MCP bridge + approval gates) is
 * Phase 2; until then, prefer `agy_execute` delegation from a trusted Pi
 * model when you need Pi-owned tool execution and diff review.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { loadAgyConfig } from "./config.js";
import { withDirLock } from "./lock.js";
import {
  startMcpBridge,
  toSafeBridgeName,
  type BridgeToolDef,
  type McpBridgeHandle,
} from "./provider-mcp.js";
import { getSession, saveSession } from "./sessions.js";
import { AgyProviderDriver, PROVIDER_TURN_TIMEOUT_MS } from "./provider-driver.js";
import {
  toProviderEffort,
  type AgyProviderEffort,
  type AgyProviderModelEntry,
  type AgyThinkingLevel,
} from "./provider-models.js";

/** Provider id registered with Pi. Collides with the bridge package — do not install both. */
export const AGY_PROVIDER_ID = "antigravity";

/** Custom API sentinel; no built-in provider claims it. */
export const AGY_PROVIDER_API = "agy-provider";

/** Bounds for transcript rendering into a single turn prompt. */
const MAX_HISTORY_CHARS = 24_000;
const MAX_SYSTEM_CHARS = 8_000;
const MAX_MESSAGE_CHARS = 6_000;

/** Minimal structural transcript message (subset of Pi's Message). */
export interface ProviderTranscriptMessage {
  role: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
}

export interface ProviderTurnCallbacks {
  onText?: (delta: string) => void;
  onActivity?: (label: string) => void;
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

export type ProviderRunEnd =
  | { kind: "done"; result: ProviderTurnResult }
  | { kind: "parked"; park: ProviderToolPark };

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
  cancel: () => void;
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
}

function textOfContent(content: unknown, imagePath?: (block: object) => string | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block && typeof block === "object") {
        const record = block as Record<string, unknown>;
        if (record.type === "text" && typeof record.text === "string") {
          parts.push(record.text);
        } else if (record.type === "image") {
          const staged = imagePath?.(block);
          parts.push(
            staged ?? "[image omitted: agy provider turns are text-only]",
          );
        } else if (record.type === "toolCall") {
          parts.push(`[tool call: ${String(record.name ?? "unknown")}]`);
        } else if (record.type === "thinking" && typeof record.thinking === "string") {
          parts.push(record.thinking);
        }
      }
    }
    return parts.join("\n");
  }
  return "";
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

export interface PromptImageBlock {
  /** Identity of the transcript block (lookup key, never serialized). */
  block: object;
  data: string;
  mimeType: string;
}

export interface StagedImages {
  /** Per-turn subdir, undefined when nothing stageable. */
  dir: string | undefined;
  /** Block identity → absolute path (order-independent lookup). */
  paths: Map<object, string>;
  /** Remove this staging (idempotent, never throws). */
  cleanup: () => Promise<void>;
}

/** Cap staged images per invocation (count and per-file size). */
export const MAX_STAGED_IMAGES = 8;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

export function imageExtension(mimeType: string): string {
  return IMAGE_EXTENSIONS[mimeType.toLowerCase()] ?? "bin";
}

/** Collect image blocks in transcript order, optionally only one tool result. */
export function collectImageBlocks(
  messages: ProviderTranscriptMessage[],
  onlyToolCallId?: string,
): PromptImageBlock[] {
  const blocks: PromptImageBlock[] = [];
  for (const message of messages) {
    if (onlyToolCallId !== undefined) {
      if (message.role !== "toolResult" || message.toolCallId !== onlyToolCallId) continue;
    }
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const record = block as Record<string, unknown>;
      if (record.type !== "image") continue;
      if (typeof record.data !== "string" || typeof record.mimeType !== "string") continue;
      blocks.push({ block, data: record.data, mimeType: record.mimeType });
    }
  }
  return blocks;
}

/** Strict base64 (Node's decoder silently strips non-alphabet chars). */
const STRICT_BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeImageData(data: string): Buffer | undefined {
  if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0) return undefined;
  if (!STRICT_BASE64_RE.test(data)) return undefined;
  try {
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}

/** Process-stable staging root (0700): per-turn subdirs, one --add-dir. */
let imageStagingRoot: string | undefined;

/** Live staging dirs (teardown sweep; per-turn cleanup disposes handles). */
const liveStagingDirs = new Set<string>();

/** Resolve (creating once) the process staging root for agy --add-dir. */
export async function ensureImageStagingRoot(): Promise<string> {
  if (!imageStagingRoot) {
    // mkdtemp (not join+mkdir): atomic, unique, 0700 — no pre-creation or
    // symlink race between check and creation.
    imageStagingRoot = await mkdtemp(path.join(os.tmpdir(), "pi-agy-images-"));
    try {
      await chmod(imageStagingRoot, 0o700);
    } catch {
      // mkdtemp already guarantees 0700; best effort.
    }
  }
  return imageStagingRoot;
}

/**
 * Materialize image blocks as files agy's tools can open. Newest transcript
 * images win (oldest starve first) so a fresh attachment is never dropped
 * behind history. Failures degrade to omitted notes, never to turn
 * failures. Each call owns its subdir; dispose via the returned cleanup.
 */
export async function stageImages(blocks: PromptImageBlock[]): Promise<StagedImages> {
  const paths = new Map<object, string>();
  const noop = async (): Promise<void> => undefined;
  const bounded = blocks.slice(-MAX_STAGED_IMAGES);
  if (bounded.length === 0) return { dir: undefined, paths, cleanup: noop };
  let root: string;
  try {
    root = await ensureImageStagingRoot();
  } catch {
    return { dir: undefined, paths, cleanup: noop };
  }
  const dir = path.join(root, randomBytes(8).toString("hex"));
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch {
    return { dir: undefined, paths, cleanup: noop };
  }
  liveStagingDirs.add(dir);
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    liveStagingDirs.delete(dir);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
  for (let index = 0; index < bounded.length; index++) {
    const block = bounded[index];
    const bytes = decodeImageData(block.data);
    if (!bytes) continue;
    const file = path.join(dir, `image-${index}.${imageExtension(block.mimeType)}`);
    try {
      await writeFile(file, bytes, { mode: 0o600 });
      await chmod(file, 0o600);
    } catch {
      continue;
    }
    paths.set(block.block, file);
  }
  if (paths.size === 0) {
    await cleanup();
    return { dir: undefined, paths, cleanup: noop };
  }
  return { dir, paths, cleanup };
}

/** Remove every staging dir and the root (teardown, tests). */
export async function clearImageStaging(): Promise<void> {
  const dirs = [...liveStagingDirs];
  liveStagingDirs.clear();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
  if (imageStagingRoot) {
    const root = imageStagingRoot;
    imageStagingRoot = undefined;
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Render Pi transcript messages into a single agy `-p` prompt. The latest
 * user message is authoritative; earlier history is bounded reference. Pi
 * tool definitions are intentionally NOT translated — agy runs its own tool
 * loop (see the module wall note).
 */
export function renderProviderPrompt(
  messages: ProviderTranscriptMessage[],
  systemPrompt?: string,
  imagePaths?: Map<object, string>,
): string {
  const imageRef = (block: object): string | undefined => {
    const file = imagePaths?.get(block);
    return file
      ? `[attached image saved at ${file} — open it with your file tools to view it]`
      : undefined;
  };
  const lines: string[] = [];
  if (systemPrompt?.trim()) {
    lines.push("System instructions:", clip(systemPrompt.trim(), MAX_SYSTEM_CHARS), "");
  }
  const history = messages.slice(0, -1);
  const rendered: string[] = [];
  let budget = MAX_HISTORY_CHARS;
  for (let i = history.length - 1; i >= 0 && budget > 0; i--) {
    const message = history[i];
    const text = clip(textOfContent(message.content, imageRef).trim(), MAX_MESSAGE_CHARS);
    if (!text) continue;
    let label: string;
    if (message.role === "user") label = "User";
    else if (message.role === "assistant") label = "Assistant (previous turn)";
    else if (message.role === "toolResult") {
      label = `Tool result (${message.toolName ?? "tool"}${message.isError ? ", error" : ""})`;
    } else if (message.role === "system") label = "System";
    else label = message.role;
    const entry = `${label}: ${text}`;
    if (entry.length > budget) break;
    budget -= entry.length;
    rendered.unshift(entry);
  }
  if (rendered.length > 0) {
    lines.push("Conversation history (reference only; the current message is authoritative):", ...rendered, "");
  }
  const last = messages[messages.length - 1];
  const current = last ? textOfContent(last.content, imageRef).trim() : "";
  const currentLabel = last && last.role !== "user" ? `Current message (${last.role}):` : "Current message:";
  lines.push(currentLabel, current || "(empty — respond with a brief acknowledgement)");
  return lines.join("\n");
}

/** Pi tool source shape (structural subset of Pi's ToolInfo). */
export interface ProviderToolSource {
  name: string;
  description?: string;
  parameters?: unknown;
}

/**
 * Tools that must never be bridged back into agy: self-delegation loops
 * burn quota and nest conversations, they are not capabilities agy lacks.
 */
const BRIDGE_EXCLUDED_TOOL_NAMES = new Set(["askantigravity"]);
const MAX_BRIDGED_TOOLS = 100;

function isBridgableToolName(name: string): boolean {
  const lowered = name.toLowerCase();
  if (lowered === "agy" || lowered.startsWith("agy_") || lowered.startsWith("agy-")) return false;
  return !BRIDGE_EXCLUDED_TOOL_NAMES.has(lowered);
}

function jsonClone(value: unknown): Record<string, unknown> | undefined {
  try {
    const cloned: unknown = JSON.parse(JSON.stringify(value));
    if (cloned && typeof cloned === "object" && !Array.isArray(cloned)) {
      return cloned as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Project Pi tools into bridge definitions: exclude self-delegation,
 * sanitize MCP names, drop unserializable schemas. First-seen wins on
 * collisions so output is deterministic.
 */
export function projectBridgeTools(sources: ProviderToolSource[]): BridgeToolDef[] {
  const defs: BridgeToolDef[] = [];
  const seenNames = new Set<string>();
  const seenPiNames = new Set<string>();
  for (const source of sources) {
    if (defs.length >= MAX_BRIDGED_TOOLS) break;
    if (typeof source.name !== "string" || !isBridgableToolName(source.name)) continue;
    if (seenPiNames.has(source.name)) continue;
    const name = toSafeBridgeName(source.name);
    if (seenNames.has(name)) continue;
    // MCP requires an object root; anything else degrades to no-arg form
    // instead of shipping a schema agy cannot validate against.
    const cloned = jsonClone(source.parameters);
    const inputSchema =
      cloned && (cloned as { type?: unknown }).type === "object" && typeof (cloned as { properties?: unknown }).properties === "object"
        ? (cloned as Record<string, unknown>)
        : { type: "object", properties: {} };
    seenPiNames.add(source.name);
    seenNames.add(name);
    defs.push({
      name,
      piName: source.name,
      description:
        typeof source.description === "string" && source.description.trim()
          ? source.description.trim().slice(0, 500)
          : `Pi tool ${source.name}`,
      inputSchema,
    });
  }
  return defs;
}

/** Fingerprint the bridged catalog: changes recycle the driver (fresh ListTools). */
export function bridgeToolsFingerprint(tools: BridgeToolDef[]): string {
  const canonical = JSON.stringify(
    tools.map((tool) => [tool.name, tool.piName, tool.description, tool.inputSchema]),
  );
  let hash = 5381;
  for (let i = 0; i < canonical.length; i++) {
    hash = ((hash << 5) + hash + canonical.charCodeAt(i)) | 0;
  }
  return `n${tools.length}-h${(hash >>> 0).toString(16)}`;
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
  const runner: ProviderTurnRunner = {
    run: (request) => {
      const lockStart = Date.now();
      return withDirLock(
        request.dir,
        async () => {
          const waited = Date.now() - lockStart;
          const remaining = Math.max(5_000, request.timeoutMs - waited);
          // Bridge startup never fails a turn: without a handle the driver
          // simply spawns plain and parks are refused at the bridge.
          const bridge = await ensureProviderBridge(request.dir).catch(() => undefined);
          // Process-stable staging root: agy can open staged images even
          // with permissions enforced (no per-turn fingerprint churn).
          const imageRoot = await ensureImageStagingRoot().catch(() => undefined);
          const fingerprint = bridgeToolsFingerprint(request.bridgedTools);
          if (bridge) {
            bridge.setTools(request.bridgedTools);
            bridge.setParkHandler((park) =>
              driver.notifyPark({ callId: park.callId, toolName: park.toolName, args: park.args }),
            );
            driver.onParksOrphaned = (message) => {
              bridge.failAllParks(message);
              // Abandoned suspensions (wall timer, teardown kills) reclaim
              // their staging here; nothing else will consume them.
              const stale = suspendedByDir.get(path.resolve(request.dir));
              if (stale) {
                suspendedByDir.delete(path.resolve(request.dir));
                void runImageCleanups(stale.imageCleanups);
              }
            };
          }
          const end = await driver.turn(
            {
              dir: request.dir,
              fullModel: request.fullModel,
              effort: request.effort,
              skipPermissions: request.skipPermissions,
              bridgeDir: bridge?.configDir,
              bridgeTools: bridge ? fingerprint : undefined,
              imageRoot,
            },
            {
              prompt: request.prompt,
              resumeConversationId: request.resumeConversationId,
              signal: request.signal,
              timeoutMs: remaining,
              onText: request.callbacks?.onText,
              onActivity: request.callbacks?.onActivity,
            },
          );
          return toRunEnd(end);
        },
        request.signal,
        request.timeoutMs,
      );
    },
    resume: async (deliveries, callbacks, resumeSignal, resumeTimeoutMs) => {
      // Like run: resumed phases hold the child and must not race
      // delegation (or another session's fresh turn) in the directory.
      return withDirLock(
        dir,
        async () => {
          const bridge = providerBridges.get(path.resolve(dir));
          if (!bridge) throw new Error("agy provider turn has no bridge to resume on");
          for (const delivery of deliveries) {
            bridge.completePark(delivery.callId, { text: delivery.text, isError: delivery.isError });
          }
          const end = await driver.continueTurn({
            signal: resumeSignal,
            timeoutMs: resumeTimeoutMs,
            onText: callbacks?.onText,
            onActivity: callbacks?.onActivity,
          });
          return toRunEnd(end);
        },
        resumeSignal,
        resumeTimeoutMs,
      );
    },
    cancel: () => {
      driver.cancelSuspended("agy provider turn was cancelled");
      providerBridges.get(path.resolve(dir))?.failAllParks("agy provider turn was cancelled");
    },
  };
  providerRunners.set(key, runner);
  return runner;
}

function toRunEnd(end: { kind: "done"; outcome: ProviderTurnResult } | { kind: "parked"; park: { callId: string; toolName: string; args: Record<string, unknown> } }): ProviderRunEnd {
  if (end.kind === "parked") {
    return { kind: "parked", park: { callId: end.park.callId, toolName: end.park.toolName, args: end.park.args } };
  }
  return { kind: "done", result: end.outcome };
}

/**
 * Driver registry: one persistent agy process per working directory, shared
 * across turns. Reset via closeProviderDrivers() (session shutdown, tests).
 */
const providerDrivers = new Map<string, AgyProviderDriver>();

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

async function ensureProviderBridge(dir: string): Promise<McpBridgeHandle | undefined> {
  const key = path.resolve(dir);
  if (providerBridges.has(key)) return providerBridges.get(key);
  let handle: McpBridgeHandle | undefined;
  try {
    const config = await loadAgyConfig();
    if (config.providerBridge !== false) {
      handle = await startMcpBridge(dir);
    }
  } catch {
    handle = undefined;
  }
  providerBridges.set(key, handle);
  return handle;
}

const providerRunners = new Map<string, ProviderTurnRunner>();

/** Stop memoized bridges so the next turn re-resolves them (toggle support). */
export async function resetProviderBridges(): Promise<void> {
  const bridges = [...providerBridges.values()];
  providerBridges.clear();
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
      out.push({ dir, running: !!bridge, toolCount: bridge?.describe().toolCount });
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
  };
  /** Bridge description, when a bridge is running for the directory. */
  bridge?: { toolCount: number };
  /** Suspended turns awaiting Pi tool results. */
  suspended: ProviderStatusSuspended[];
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
      suspended.push({ toolCallId: entry.toolCallId, toolName: entry.park.toolName, modelId: entry.modelId });
    }
  }
  try {
    const driver = providerDrivers.get(key);
    const snapshot = driver?.snapshot();
    const bridge = providerBridges.get(key);
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
          }
        : undefined,
      bridge: bridge ? { toolCount: bridge.describe().toolCount } : undefined,
      suspended,
      stagedImages: liveStagingDirs.size,
    };
  } catch {
    return { dir: key, suspended, stagedImages: 0 };
  }
}

/** Kill all driver processes and drop them; the next turn respawns lazily. */
export async function closeProviderDrivers(): Promise<void> {
  const drivers = [...providerDrivers.values()];
  providerDrivers.clear();
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
      `Unknown ${AGY_PROVIDER_ID} model '${modelId}'; pick another via /model (the agy catalog may have changed — restart Pi to refresh).`,
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

interface SuspendedTurn {
  runner: ProviderTurnRunner;
  toolCallId: string;
  park: ProviderToolPark;
  modelId: string;
  /** Image staging cleanups owned by the suspended turn. */
  imageCleanups: Array<() => Promise<void>>;
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
            output.usage.output += delta.length;
            stream.push({ type: "text_delta", contentIndex: index, delta, partial: output });
          },
          onActivity: (label) => {
            const index = ensureThinking();
            const block = output.content[index] as { thinking: string };
            block.thinking += (block.thinking ? "\n" : "") + label;
            stream.push({ type: "thinking_delta", contentIndex: index, delta: label, partial: output });
          },
        };

        const runner = getRunner(dir);
        const skey = path.resolve(dir);
        const prior = suspendedByDir.get(skey);
        const bodies = prior ? collectParkedDeliveries(messages, prior.toolCallId) : [];
        let end: ProviderRunEnd;
        if (prior && bodies.length > 0) {
          suspendedByDir.delete(skey);
          // Images riding on the delivered tool results are staged too:
          // the resumed agy turn reads them by path. Owned by this
          // invocation; cleaned on its terminal settle below.
          const deliveryImages = await stageImages(collectImageBlocks(messages, prior.toolCallId));
          const resumeCleanups = [...prior.imageCleanups, deliveryImages.cleanup];
          const imageRefs = [...deliveryImages.paths.values()];
          // Deliver by bridge park id (what agy waits on), matched via the
          // shadow toolCall id (what Pi's transcript carries).
          const deliveries: ProviderToolDelivery[] = bodies.map((body) => ({
            callId: prior.park.callId,
            text:
              body.text +
              (imageRefs.length > 0
                ? `\n[attached images saved at: ${imageRefs.join(", ")} — open them with your file tools to view]`
                : ""),
            isError: body.isError,
          }));
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
              runner.cancel();
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
          if (prior && hasUserMessageAfterToolCall(messages, prior.toolCallId)) {
            // Our own transcript moved on without delivering (abort, reject,
            // retry): cancel the stale suspension and start fresh instead
            // of bricking the directory behind the suspended guard.
            suspendedByDir.delete(skey);
            try {
              runner.cancel();
            } catch {
              // Cancel is best effort next to a fresh turn.
            }
            await runImageCleanups(prior.imageCleanups);
          }
          let resume = hasPriorAssistantTurn ? resumeByModel.get(model.id) : undefined;
          if (!resume && hasPriorAssistantTurn) {
            try {
              const record = await getSession(dir);
              if (record?.last_conversation_id && record.last_model === model.id) {
                resume = record.last_conversation_id;
              }
            } catch {
              // Session-store failures must never block a turn.
            }
          }
          // Materialize attached images as files agy's tools can open;
          // paths render inline, failures degrade to omitted notes. Held
          // for the driver turn: terminal settle below cleans it, a park
          // carries it into the suspension.
          const staged = await stageImages(collectImageBlocks(messages));
          pendingImageCleanups.push(staged.cleanup);
          const prompt = renderProviderPrompt(messages, systemPrompt || undefined, staged.paths);
          end = await runner.run({
            fullModel: turnModel.full,
            effort: turnModel.effort,
            prompt,
            dir,
            signal,
            timeoutMs: deps.timeoutMs ?? PROVIDER_TURN_TIMEOUT_MS,
            resumeConversationId: resume,
            skipPermissions: deps.skipPermissions ?? true,
            bridgedTools: projectBridgeTools(deps.tools ?? []),
            callbacks,
          });
        }

        if (end.kind === "parked") {
          // A bridged Pi tool call: end any open blocks, then emit a REAL
          // shadow toolCall so Pi executes it with normal permissions,
          // approvals, and review. The Pi turn delivering the matching
          // toolResult resumes this driver turn.
          if (thinkingIndex !== -1) {
            const thinking = (output.content[thinkingIndex] as { thinking: string }).thinking;
            stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: thinking, partial: output });
          }
          if (textIndex !== -1) {
            const text = (output.content[textIndex] as { text: string }).text;
            stream.push({ type: "text_end", contentIndex: textIndex, content: text, partial: output });
          }
          const toolCallId = `agybridge-${randomBytes(8).toString("hex")}`;
          const toolCall = {
            type: "toolCall",
            id: toolCallId,
            name: end.park.toolName,
            arguments: end.park.args,
          };
          output.content.push(toolCall);
          const toolIndex = output.content.length - 1;
          stream.push({ type: "toolcall_start", contentIndex: toolIndex, partial: output });
          stream.push({ type: "toolcall_end", contentIndex: toolIndex, toolCall, partial: output });
          suspendedByDir.set(skey, {
            runner,
            toolCallId,
            park: end.park,
            modelId: model.id,
            imageCleanups: pendingImageCleanups,
          });
          output.usage.totalTokens =
            output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          output.stopReason = "toolUse";
          stream.push({ type: "done", reason: output.stopReason, message: output });
          stream.end();
          return;
        }
        const result = end.result;

        if (thinkingIndex !== -1) {
          const thinking = (output.content[thinkingIndex] as { thinking: string }).thinking;
          stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: thinking, partial: output });
        }
        if (textIndex === -1) {
          // No live deltas arrived: the terminal response (if any) is the
          // answer — never answer empty when agy produced text.
          const index = ensureText();
          const fallback =
            result.text ||
            (result.activity.length > 0 ? result.activity.join("\n") : "(agy returned no text)");
          (output.content[index] as { text: string }).text = fallback;
          stream.push({ type: "text_end", contentIndex: index, content: fallback, partial: output });
        } else {
          const block = output.content[textIndex];
          let finalText = (block as { text: string }).text;
          if (result.truncated) finalText += "\n\n[truncated: agy response exceeded the provider cap]";
          if (result.deniedActions && result.deniedActions.length > 0) {
            finalText += `\n\n[warning: agy reported ${result.deniedActions.length} denied action(s) alongside this response]`;
          }
          if (result.aborted) finalText += "\n\n[note: turn cancelled — response is partial]";
          else if (result.timedOut) finalText += "\n\n[note: turn timed out — response is partial]";
          (block as { text: string }).text = finalText;
          stream.push({ type: "text_end", contentIndex: textIndex, content: finalText, partial: output });
        }

        output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
        // Partial turns must never masquerade as clean stops: surface the
        // real terminal state so Pi retries or reports instead of accepting
        // truncated text as a complete answer.
        if (result.aborted) output.stopReason = "aborted";
        else if (result.timedOut) output.stopReason = "length";
        else output.stopReason = "stop";
        if (result.conversationId) {
          resumeByModel.set(model.id, result.conversationId);
          const latestUser = [...messages].reverse().find((message) => message.role === "user");
          const summary = textOfContent(latestUser?.content).trim().slice(0, 80) || undefined;
          try {
            // Preserve a delegation-recorded agent: provider turns must not
            // wipe the agent that /agy continue would otherwise restore.
            const prior = await getSession(dir).catch(() => undefined);
            await saveSession(dir, result.conversationId, model.id, undefined, summary, prior?.last_agent);
          } catch {
            // Recording failures must never fail a completed turn.
          }
        }
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
        await runImageCleanups(pendingImageCleanups);
      } catch (error) {
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
