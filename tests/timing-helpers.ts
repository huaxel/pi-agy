import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { mock } from "node:test";

export const nativeSetTimeout = globalThis.setTimeout;
export const nativeClearTimeout = globalThis.clearTimeout;
export const nativeSetImmediate = globalThis.setImmediate;

export type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killRequested: boolean;
  kill: () => boolean;
  close: (code?: number | null, signal?: NodeJS.Signals | null) => void;
  forceClose: () => void;
};

interface TimingFakeOptions {
  taskOutput?: string;
  onTaskOutput?: () => void;
  onSpawn?: (args: readonly string[], child: FakeChild) => void;
  onClose?: (args: readonly string[], child: FakeChild) => void;
  killCloseDelayMs?: number;
  hangModels?: boolean;
  cleanupTimeoutMs?: number;
}

export async function withTimingFakeAgy<T>(
  options: TimingFakeOptions,
  fn: (
    children: Set<FakeChild>,
    signal: AbortSignal,
    track: <V>(promise: Promise<V>) => Promise<V>,
  ) => Promise<T>,
): Promise<T> {
  const children = new Set<FakeChild>();
  const fixtureController = new AbortController();
  const tracked = new Set<Promise<unknown>>();
  const cp = createRequire(import.meta.url)("node:child_process") as {
    spawn: (...args: unknown[]) => unknown;
  };
  const fakeSpawn = (_command: string, args: readonly string[]) => {
    let closed = false;
    let delayedKill: ReturnType<typeof setTimeout> | undefined;
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = undefined;
    child.exitCode = null;
    child.signalCode = null;
    child.killRequested = false;
    child.close = (code = 0, signal = null) => {
      if (closed) return;
      closed = true;
      if (delayedKill !== undefined) clearTimeout(delayedKill);
      child.exitCode = code;
      child.signalCode = signal;
      options.onClose?.(args, child);
      child.emit("close", code, signal);
      children.delete(child);
    };
    child.forceClose = () => child.close(null, "SIGTERM");
    child.kill = () => {
      if (closed || child.killRequested) return true;
      child.killRequested = true;
      if (options.killCloseDelayMs) {
        delayedKill = setTimeout(() => child.close(null, "SIGTERM"), options.killCloseDelayMs);
      } else {
        child.close(null, "SIGTERM");
      }
      return true;
    };
    children.add(child);
    options.onSpawn?.(args, child);
    queueMicrotask(() => {
      if (closed) return;
      if (args[0] === "models") {
        if (options.hangModels) return;
        child.stdout.end("gemini-3.8-flash-medium\tGemini\n");
        child.close();
      } else if (args[0] === "--version") {
        child.stdout.end("agy 1.2.0\n");
        child.close();
      } else if (args[0] === "--output-format") {
        child.stdout.end("{}\n");
        child.close();
      } else {
        child.stdout.write('{"event":"init","init":{"model":"fake"}}\n');
        if (!closed && options.taskOutput) child.stdout.write(options.taskOutput);
        if (!closed) options.onTaskOutput?.();
      }
    });
    return child;
  };
  const stub = mock.method(cp, "spawn", fakeSpawn as typeof cp.spawn);
  const track = <V>(promise: Promise<V>): Promise<V> => {
    tracked.add(promise);
    promise.then(() => tracked.delete(promise), () => tracked.delete(promise));
    return promise;
  };
  try {
    return await fn(children, fixtureController.signal, track);
  } finally {
    // Cancellation must reach the SUT before fake process close and hook
    // restoration, so its cleanup follows the same ordering as production.
    fixtureController.abort();
    for (const child of [...children]) child.forceClose();
    try {
      await awaitWithWatchdog(
        Promise.allSettled([...tracked]),
        "timing fixture cleanup",
        options.cleanupTimeoutMs ?? 5_000,
      );
    } finally {
      for (const child of [...children]) child.forceClose();
      stub.mock.restore();
    }
  }
}

export async function awaitNativeTurn(label: string, ms = 1_000): Promise<void> {
  await awaitWithWatchdog(new Promise<void>((resolve) => nativeSetImmediate(resolve)), label, ms);
}

export async function awaitWithWatchdog<T>(promise: Promise<T>, label: string, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof nativeSetTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = nativeSetTimeout(() => reject(new Error(`${label} watchdog expired`)), ms);
  });
  try {
    return await Promise.race([promise, watchdog]);
  } finally {
    if (timer !== undefined) nativeClearTimeout(timer);
  }
}
