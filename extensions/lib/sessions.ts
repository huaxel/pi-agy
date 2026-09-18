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
  updated_at: string;
  /** Short task excerpt so humans and agents can tell conversations apart. */
  summary?: string;
}

export interface AgySessionRecord {
  last_conversation_id?: string;
  last_model?: string;
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

export interface AgySessionStore {
  getSession(dir: string): Promise<AgySessionRecord | undefined>;
  getHistory(dir: string): Promise<AgyConversationEntry[]>;
  saveSession(
    dir: string,
    conversationId: string,
    model?: string,
    signal?: AbortSignal,
    summary?: string,
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
              typeof entry.updated_at === "string",
          )
          .map((entry) => {
            const normalized: AgyConversationEntry = {
              conversation_id: entry.conversation_id,
              updated_at: entry.updated_at,
            };
            if (typeof entry.model === "string") normalized.model = entry.model;
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
  ): Promise<void> {
    const operation = waitForMutation(signal).then(() =>
      withStoreLock(async () => {
        const store = await loadStore(signal);
        const key = path.resolve(dir);
        const record = store[key] ?? {};
        const updatedAt = new Date().toISOString();
        store[key] = {
          last_conversation_id: conversationId,
          last_model: model,
          updated_at: updatedAt,
          history: [
            { conversation_id: conversationId, model, updated_at: updatedAt, summary },
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
): Promise<void> {
  return defaultStore.saveSession(dir, conversationId, model, signal, summary);
}
