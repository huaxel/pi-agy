import { isAgyModelId, validateAgyModelId, type AgyModelId } from "./provider-models.js";
import { normalizeUsageSnapshot, type ValidatedAgyUsage } from "./provider-usage.js";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat as statFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

/** One recorded agy conversation for a working directory. */
export interface AgyConversationEntry {
  conversation_id: string;
  model?: string;
  /** Exact delegation CLI ID; model remains the alias or native provider resume key. */
  raw_model_id?: AgyModelId;
  agent?: string;
  updated_at: string;
  /** Short task excerpt so humans and agents can tell conversations apart. */
  summary?: string;
}

/**
 * Fingerprint of the Pi transcript an agy conversation last consumed.
 *
 * `last_conversation_id` is stored per directory, so without this the record
 * says "the newest conversation in this workspace", not "the conversation this
 * transcript is a continuation of". Two Pi sessions in one checkout, or a
 * transcript that came from a different provider, would resume a conversation
 * they never took part in and append to it. A record written before this field
 * existed carries no anchor and therefore cannot be proven, so it is not
 * resumed.
 */
export interface TranscriptAnchor {
  /** Number of non-system transcript messages the conversation consumed. */
  count: number;
  /** `transcriptFingerprint` of exactly those messages. */
  fingerprint: string;
  /**
   * What else that turn had in force, so a *new* process can continue with a
   * delta instead of replaying the transcript, and can still report the turn's
   * own tokens. All optional: a record written before these existed simply
   * cannot prove a delta and falls back to a full prompt.
   */
  assistant_fingerprint?: string;
  /** Hash of the system prompt in force; the prompt itself is never stored. */
  system_prompt_hash?: string;
  /** Bridged tool catalog key in force. */
  bridge_tools_key?: string;
  /** Cumulative native usage of the conversation after that turn. */
  usage_snapshot?: { input: number; output: number; cache_read: number; thinking?: number };
}

/** Fingerprints are short opaque tokens; anything else is corruption. */
const MAX_FINGERPRINT_CHARS = 64;

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FINGERPRINT_CHARS;
}

/**
 * Validate an anchor read back from disk. An unrecognisable part is dropped
 * rather than trusted: the worst case is a full prompt, never a wrong delta.
 */
export function normalizeTranscriptAnchor(value: unknown): TranscriptAnchor | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.count !== "number" ||
    !Number.isSafeInteger(record.count) ||
    record.count <= 0 ||
    !isFingerprint(record.fingerprint)
  ) {
    return undefined;
  }
  const anchor: TranscriptAnchor = { count: record.count, fingerprint: record.fingerprint };
  if (isFingerprint(record.assistant_fingerprint)) {
    anchor.assistant_fingerprint = record.assistant_fingerprint;
  }
  if (isFingerprint(record.system_prompt_hash)) anchor.system_prompt_hash = record.system_prompt_hash;
  if (isFingerprint(record.bridge_tools_key)) anchor.bridge_tools_key = record.bridge_tools_key;
  const snapshot = normalizeUsageSnapshot(record.usage_snapshot);
  if (snapshot) {
    anchor.usage_snapshot = {
      input: snapshot.input,
      output: snapshot.output,
      cache_read: snapshot.cacheRead,
      ...(snapshot.thinking !== undefined ? { thinking: snapshot.thinking } : {}),
    };
  }
  return anchor;
}

export interface AgySessionRecord {
  last_conversation_id?: string;
  last_transcript_anchor?: TranscriptAnchor;
  last_model?: string;
  last_raw_model_id?: AgyModelId;
  last_agent?: string;
  updated_at?: string;
  /** Recent conversations for the directory, most recent first. */
  history?: AgyConversationEntry[];
}

const HISTORY_LIMIT = 10;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30_000;

function waitForStoreLockRetry(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error("agy was cancelled while waiting for session storage"));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, LOCK_RETRY_MS);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("agy was cancelled while waiting for session storage"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

type SessionStore = Record<string, AgySessionRecord>;

export function getDefaultStorePath(): string {
  const agentDir =
    process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "agy-sessions.json");
}

/** The driver shape of a stored snapshot. */
export function anchorUsageSnapshot(usage: ValidatedAgyUsage): NonNullable<TranscriptAnchor["usage_snapshot"]> {
  return {
    input: usage.input,
    output: usage.output,
    cache_read: usage.cacheRead,
    ...(usage.thinking !== undefined ? { thinking: usage.thinking } : {}),
  };
}

export function snapshotFromAnchor(
  snapshot: NonNullable<TranscriptAnchor["usage_snapshot"]>,
): ValidatedAgyUsage {
  return {
    input: snapshot.input,
    output: snapshot.output,
    cacheRead: snapshot.cache_read,
    ...(snapshot.thinking !== undefined ? { thinking: snapshot.thinking } : {}),
  };
}

export interface AgySessionStore {
  getSession(dir: string): Promise<AgySessionRecord | undefined>;
  getHistory(dir: string): Promise<AgyConversationEntry[]>;
  saveSession(
    dir: string,
    conversationId: string,
    model?: string,
    signal?: AbortSignal,
    summary?: string,
    agent?: string,
    rawModelId?: AgyModelId,
    /** Proof of which transcript this conversation consumed; see TranscriptAnchor. */
    anchor?: TranscriptAnchor,
  ): Promise<void>;
}

/** Collapse a prompt into a short one-line task summary. */
export function conversationSummary(prompt: string, max = 80): string {
  const collapsed = prompt.trim().replace(/\s+/g, " ");
  return collapsed.length > max ? collapsed.slice(0, max) + "…" : collapsed;
}

/**
 * Create a session store. The optional path (string or lazy resolver) makes
 * persistence testable; the lazy form re-reads `PI_CODING_AGENT_DIR` on each
 * operation.
 */
export function createSessionStore(
  storePath: string | (() => string) = getDefaultStorePath,
): AgySessionStore {
  const resolvePath = (): string => (typeof storePath === "function" ? storePath() : storePath);
  let mutationChain = Promise.resolve();

  async function loadStore(signal?: AbortSignal): Promise<SessionStore> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(resolvePath(), { encoding: "utf8", signal }),
      );
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Invalid agy session store format");
      }
      return parsed as SessionStore;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async function saveStore(store: SessionStore): Promise<void> {
    const target = resolvePath();
    await mkdir(path.dirname(target), { recursive: true });
    const tempPath = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(store, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(tempPath, 0o600);
      await rename(tempPath, target);
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  }

  /** A corrupt store must never block the user's task; saves stay strict. */
  function isCorruptStoreError(error: unknown): boolean {
    return (
      error instanceof SyntaxError ||
      (error instanceof Error && error.message === "Invalid agy session store format")
    );
  }

  async function getSession(dir: string): Promise<AgySessionRecord | undefined> {
    try {
      const store = await loadStore();
      return store[path.resolve(dir)];
    } catch (error) {
      if (isCorruptStoreError(error)) return undefined;
      throw error;
    }
  }

  async function getHistory(dir: string): Promise<AgyConversationEntry[]> {
    let history: AgyConversationEntry[] | undefined;
    try {
      const store = await loadStore();
      history = store[path.resolve(dir)]?.history;
    } catch (error) {
      if (!isCorruptStoreError(error)) throw error;
    }
    return Array.isArray(history)
      ? history
          .filter(
            (entry) =>
              entry &&
              typeof entry.conversation_id === "string" &&
              typeof entry.updated_at === "string" &&
                (entry.raw_model_id === undefined || isAgyModelId(entry.raw_model_id)),
          )
          .map((entry) => {
            const normalized: AgyConversationEntry = {
              conversation_id: entry.conversation_id,
              updated_at: entry.updated_at,
            };
            if (typeof entry.model === "string") normalized.model = entry.model;
            if (entry.raw_model_id !== undefined) normalized.raw_model_id = entry.raw_model_id;
            if (typeof entry.agent === "string") {
              const agent = entry.agent.trim();
              if (agent && agent.length <= 128 && !/[\x00-\x1f\x7f]/.test(agent)) {
                normalized.agent = agent;
              }
            }
            if (typeof entry.summary === "string") normalized.summary = entry.summary;
            return normalized;
          })
      : [];
  }

  async function withStoreLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const target = resolvePath();
    const lockPath = `${target}.lock`;
    const owner = randomUUID();
    await mkdir(path.dirname(target), { recursive: true });

    while (true) {
      if (signal?.aborted) throw new Error("agy was cancelled while waiting for session storage");
      try {
        await mkdir(lockPath);
        try {
          await writeFile(path.join(lockPath, "owner"), owner, {
            encoding: "utf8",
            mode: 0o600,
          });
        } catch (error) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lockStat = await statFile(lockPath);
          if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
            // Same irreducible stat→rm race as the dir lock in lock.ts; the
            // critical section here is a single fast read-modify-write, so
            // the 30 s staleness margin dwarfs the window. Accepted cost.
            await rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          // The lock disappeared between mkdir and stat; retry immediately.
          continue;
        }
        await waitForStoreLockRetry(signal);
      }
    }

    try {
      return await fn();
    } finally {
      try {
        if ((await readFile(path.join(lockPath, "owner"), "utf8")) === owner) {
          await rm(lockPath, { recursive: true, force: true });
        }
      } catch {
        // Preserve the operation result if cleanup races with a stale-lock recovery.
      }
    }
  }

  async function waitForMutation(signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await mutationChain;
      return;
    }
    if (signal.aborted) throw new Error("agy was cancelled while waiting for session storage");
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => finish(() => reject(new Error("agy was cancelled while waiting for session storage")));
      const finish = (settle: () => void) => {
        signal.removeEventListener("abort", onAbort);
        settle();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      mutationChain.then(() => finish(resolve), (error) => finish(() => reject(error)));
    });
  }

  function saveSession(
    dir: string,
    conversationId: string,
    model?: string,
    signal?: AbortSignal,
    summary?: string,
    agent?: string,
    rawModelId?: AgyModelId,
    anchor?: TranscriptAnchor,
  ): Promise<void> {
    if (rawModelId !== undefined) validateAgyModelId(rawModelId);
    const operation = waitForMutation(signal).then(() =>
      withStoreLock(async () => {
        const store = await loadStore(signal);
        const key = path.resolve(dir);
        const record = store[key] ?? {};
        const updatedAt = new Date().toISOString();
        store[key] = {
          last_conversation_id: conversationId,
          ...(anchor ? { last_transcript_anchor: anchor } : {}),
          last_model: model,
          ...(rawModelId ? { last_raw_model_id: rawModelId } : {}),
          last_agent: agent,
          updated_at: updatedAt,
          history: [
            { conversation_id: conversationId, model, ...(rawModelId ? { raw_model_id: rawModelId } : {}), agent, updated_at: updatedAt, summary },
            ...(Array.isArray(record.history) ? record.history : []).filter(
              (entry) =>
                entry &&
                typeof entry.conversation_id === "string" &&
                entry.conversation_id !== conversationId,
            ),
          ].slice(0, HISTORY_LIMIT),
        };
        await saveStore(store);
      }, signal),
    );
    mutationChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  return { getSession, getHistory, saveSession };
}

const defaultStore = createSessionStore();

export function getSession(dir: string): Promise<AgySessionRecord | undefined> {
  return defaultStore.getSession(dir);
}

export function getHistory(dir: string): Promise<AgyConversationEntry[]> {
  return defaultStore.getHistory(dir);
}

export function saveSession(
  dir: string,
  conversationId: string,
  model?: string,
  signal?: AbortSignal,
  summary?: string,
  agent?: string,
  rawModelId?: AgyModelId,
  anchor?: TranscriptAnchor,
): Promise<void> {
  return defaultStore.saveSession(dir, conversationId, model, signal, summary, agent, rawModelId, anchor);
}
