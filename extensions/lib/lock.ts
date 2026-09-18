import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat as statFile,
  utimes,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const chains = new Map<string, Promise<void>>();
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30_000;
// The lock is held for the whole agy run (minutes), far longer than the
// stale threshold — refresh mtime while held so a live holder is never
// mistaken for a crashed one.
const LOCK_HEARTBEAT_MS = 5_000;

/**
 * Serialize agy_execute calls that share the same working directory.
 * When `timeoutMs` is set, waiting for the lock counts against the budget
 * so a call queued behind a long run cannot silently exceed its timeout.
 * Combines an in-process queue with a filesystem lock so separate Pi
 * processes cannot enter the same directory concurrently.
 */
export async function canonicalDir(dir: string): Promise<string> {
  try {
    return await realpath(path.resolve(dir));
  } catch {
    return path.resolve(dir);
  }
}

export function getDirLockPath(canonical: string): string {
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  const base =
    process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  return path.join(base, "agy-dirlocks", `${hash}.lock`);
}

/** Refresh a held lock so the stale-lock recovery cannot steal it mid-run. */
export async function touchDirLock(lockPath: string): Promise<void> {
  const now = new Date();
  await utimes(lockPath, now, now);
}

async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
  deadline?: number,
): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  while (true) {
    if (signal?.aborted) throw new Error("agy was cancelled while waiting");
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new Error("agy timed out waiting for a previous run in the same directory");
    }
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const lockStat = await statFile(lockPath);
        if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
          // Stale recovery has an irreducible stat→rm race: another process
          // can recover the same stale lock in between and install a fresh
          // one that this rm then deletes, briefly admitting two holders.
          // The heartbeat keeps live locks fresh, the owner check on release
          // limits the damage, and the window is a single await wide — an
          // accepted cost for a best-effort agent-serialization lock.
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, LOCK_RETRY_MS);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error("agy was cancelled while waiting"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
  const owner = `${process.pid}.${randomUUID()}`;
  try {
    await writeFile(path.join(lockPath, "owner"), owner, {
      encoding: "utf8",
      mode: 0o600,
    }).catch(() => undefined);
    const heartbeat = setInterval(() => {
      touchDirLock(lockPath).catch(() => undefined);
    }, LOCK_HEARTBEAT_MS);
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
    }
  } finally {
    // Only remove our own lock — a stale recovery may have handed the
    // directory to another process while we were suspended (e.g. sleep).
    try {
      if ((await readFile(path.join(lockPath, "owner"), "utf8")) === owner) {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch {
      // Lock already gone; nothing to clean up.
    }
  }
}

export async function withDirLock<T>(
  dir: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  // Normalize equivalent relative and absolute paths so the per-directory
  // guarantee cannot be bypassed by path spelling.
  const key = await canonicalDir(dir);
  const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
  const prev = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => gate);
  chains.set(key, tail);
  // Keep the tail registered until its predecessor and gate have both settled.
  // Otherwise a cancelled waiter can delete the chain while an earlier run is
  // still active, allowing a later caller to enter concurrently.
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });

  try {
    await waitForTurn(prev, signal, deadline);
    return await withFileLock(getDirLockPath(key), fn, signal, deadline);
  } finally {
    // A cancelled waiter still owns a gate in the chain. Release it so later
    // calls are not stranded behind work that will never run.
    release();
  }
}

function waitForTurn(prev: Promise<void>, signal?: AbortSignal, deadline?: number): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("agy was cancelled while waiting"));
  if (deadline !== undefined && Date.now() >= deadline) {
    return Promise.reject(
      new Error("agy timed out waiting for a previous run in the same directory"),
    );
  }
  if (!signal && deadline === undefined) return prev;

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => finish(() => reject(new Error("agy was cancelled while waiting")));
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (settle: () => void) => {
      signal?.removeEventListener("abort", onAbort);
      if (timer !== undefined) clearTimeout(timer);
      settle();
    };

    if (deadline !== undefined) {
      timer = setTimeout(
        () =>
          finish(() =>
            reject(new Error("agy timed out waiting for a previous run in the same directory")),
          ),
        Math.max(deadline - Date.now(), 0),
      );
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    prev.then(
      () => finish(resolve),
      (error) => finish(() => reject(error)),
    );
  });
}
