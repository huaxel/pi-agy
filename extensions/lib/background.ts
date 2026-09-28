/**
 * Background agy tasks: detached delegation runs with poll/collect.
 *
 * `start` launches the runner without awaiting it and returns a handle
 * immediately. The run keeps its own timeout deadline (enforced by aborting
 * the task controller, which kills the agy process group downstream) and
 * participates in the per-directory lock like a foreground run — lock waits
 * count against its timeout. `collect` returns the terminal outcome and
 * frees the record; session durability comes from the executor itself,
 * which records conversations on completion, timeout, and cancellation.
 *
 * Records are in-process only: a Pi restart orphans nothing (every live
 * child is killed on shutdown) but drops uncollected payloads — the session
 * store keeps those conversations resumable.
 */

import { randomBytes } from "node:crypto";

import { conversationSummary } from "./sessions.js";

export type BackgroundTaskState = "running" | "done" | "error" | "cancelled" | "timeout";

export interface BackgroundRunCallbacks {
  onProgress: (message: string) => void;
  signal: AbortSignal;
}

export interface BackgroundRunOutcome {
  text: string;
  conversationId?: string;
  details?: unknown;
}

export interface BackgroundStartOptions {
  dir: string;
  summary: string;
  model?: string;
  agent?: string;
  timeoutMs: number;
  run: (callbacks: BackgroundRunCallbacks) => Promise<BackgroundRunOutcome>;
}

export interface BackgroundTaskSnapshot {
  handle: string;
  dir: string;
  summary: string;
  model?: string;
  agent?: string;
  state: BackgroundTaskState;
  startedAt: number;
  updatedAt: number;
  /** Bounded recent progress lines (newest last). */
  progress: string[];
  text?: string;
  error?: string;
  conversationId?: string;
  details?: unknown;
}

const MAX_TASKS = 32;
const MAX_PROGRESS_LINES = 20;
const MAX_PROGRESS_CHARS = 500;

interface TaskRecord {
  handle: string;
  dir: string;
  summary: string;
  model?: string;
  agent?: string;
  state: BackgroundTaskState;
  startedAt: number;
  updatedAt: number;
  progress: string[];
  text?: string;
  error?: string;
  conversationId?: string;
  details?: unknown;
  controller: AbortController;
  timer?: NodeJS.Timeout;
  cancelled: boolean;
  timedOut: boolean;
  settled: Promise<void>;
}

function clipProgress(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > MAX_PROGRESS_CHARS ? flat.slice(0, MAX_PROGRESS_CHARS - 1) + "…" : flat;
}

export class BackgroundTaskRunner {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly maxTasks: number;
  private readonly shutdownTimeoutMs: number;

  constructor(options?: { maxTasks?: number; shutdownTimeoutMs?: number }) {
    this.maxTasks = Math.max(1, options?.maxTasks ?? MAX_TASKS);
    this.shutdownTimeoutMs = Math.max(1, options?.shutdownTimeoutMs ?? 15_000);
  }

  /**
   * Start a detached run. Finished records are never evicted behind the
   * agent's back (collect frees them explicitly); when every slot holds a
   * live or uncollected task, starting fails with a state-aware message.
   */
  start(options: BackgroundStartOptions): string {
    if (this.tasks.size >= this.maxTasks) {
      const states = [...this.tasks.values()].map((record) => record.state);
      const finished = states.filter((state) => state !== "running").length;
      throw new Error(
        finished > 0
          ? `background task list is full (${this.maxTasks}); collect finished tasks first`
          : `background task list is full of active runs (${this.maxTasks}); cancel running tasks first`,
      );
    }
    const handle = `agybg-${randomBytes(8).toString("hex")}`;
    const controller = new AbortController();
    const now = Date.now();
    const record: TaskRecord = {
      handle,
      dir: options.dir,
      summary: options.summary,
      model: options.model,
      agent: options.agent,
      state: "running",
      startedAt: now,
      updatedAt: now,
      progress: [],
      controller,
      cancelled: false,
      timedOut: false,
      settled: Promise.resolve(),
    };
    // Ref'd deliberately: this timer guarantees the run settles even if
    // nothing else holds the loop (an unref'd timer lets the loop drain
    // with the task pending, hanging collectors forever). Cleared on settle.
    record.timer = setTimeout(() => {
      record.timedOut = true;
      controller.abort();
    }, Math.max(1, options.timeoutMs));

    this.tasks.set(handle, record);
    let runPromise: Promise<BackgroundRunOutcome>;
    try {
      runPromise = Promise.resolve(
        options.run({
          onProgress: (message) => {
            const line = clipProgress(message);
            if (!line) return;
            record.progress.push(line);
            if (record.progress.length > MAX_PROGRESS_LINES) {
              record.progress.splice(0, record.progress.length - MAX_PROGRESS_LINES);
            }
            record.updatedAt = Date.now();
          },
          signal: controller.signal,
        }),
      );
    } catch (error) {
      runPromise = Promise.reject(error);
    }
    record.settled = runPromise
      .then(
        (outcome) => {
          record.state = "done";
          record.text = outcome.text;
          record.conversationId = outcome.conversationId;
          record.details = outcome.details;
          record.updatedAt = Date.now();
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          // Cancelled wins: only our cancel/shutdown abort with the flag
          // set (the timer is cleared in cancel, so a late fire cannot
          // overwrite). Timeout flag next; the message regex is a backstop
          // for executor-internal deadlines only — never for cancellation,
          // whose wording may appear in unrelated child output.
          if (record.cancelled) record.state = "cancelled";
          else if (record.timedOut || /timed out/i.test(message)) record.state = "timeout";
          else record.state = "error";
          record.error = message;
          const conversationId =
            typeof error === "object" && error !== null
              ? (error as { conversation_id?: unknown }).conversation_id
              : undefined;
          if (typeof conversationId === "string") record.conversationId = conversationId;
          record.updatedAt = Date.now();
        },
      )
      .finally(() => {
        if (record.timer) {
          clearTimeout(record.timer);
          record.timer = undefined;
        }
      });
    // A settlement rejection here would be an unhandled rejection: the
    // handlers above never throw, but belt-and-braces costs nothing.
    record.settled.catch(() => undefined);
    return handle;
  }

  get(handle: string): BackgroundTaskSnapshot | undefined {
    const record = this.tasks.get(handle);
    return record ? snapshotOf(record) : undefined;
  }

  /** Snapshots for a directory (exact resolved match), newest last. */
  list(dir?: string): BackgroundTaskSnapshot[] {
    const out: BackgroundTaskSnapshot[] = [];
    for (const record of this.tasks.values()) {
      if (dir !== undefined && record.dir !== dir) continue;
      out.push(snapshotOf(record));
    }
    return out.sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Return the terminal outcome and free the record. Throws for unknown
   * handles and for tasks that are still running (poll status instead).
   */
  collect(handle: string): BackgroundTaskSnapshot {
    const record = this.tasks.get(handle);
    if (!record) throw new Error(`unknown background task '${handle}'`);
    if (record.state === "running") {
      throw new Error(`background task '${handle}' is still running; poll status instead`);
    }
    this.tasks.delete(handle);
    return snapshotOf(record);
  }

  /** Cancel a running task; false when unknown or already terminal. */
  cancel(handle: string): boolean {
    const record = this.tasks.get(handle);
    if (!record || record.state !== "running" || record.cancelled) return false;
    record.cancelled = true;
    if (record.timer) {
      clearTimeout(record.timer);
      record.timer = undefined;
    }
    controllerAbort(record);
    return true;
  }

  /**
   * Abort every running task (session shutdown) and wait for settlement —
   * bounded, so an abort-ignoring runner can delay but never hang teardown.
   */
  async shutdown(): Promise<void> {
    const pending: Array<Promise<void>> = [];
    for (const record of this.tasks.values()) {
      if (record.state === "running") {
        record.cancelled = true;
        // Timers are moot past teardown: clear them so abandoned tasks
        // cannot pin the process open after shutdown returns.
        if (record.timer) {
          clearTimeout(record.timer);
          record.timer = undefined;
        }
        controllerAbort(record);
        pending.push(record.settled);
      }
    }
    if (pending.length === 0) return;
    // Ref'd like the task timers: the bound must hold the loop, or teardown
    // races an empty loop the same way. Cleared below either way.
    let waiter: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(pending).then(() => undefined),
        new Promise<void>((resolve) => {
          waiter = setTimeout(resolve, this.shutdownTimeoutMs);
        }),
      ]);
    } finally {
      if (waiter !== undefined) clearTimeout(waiter);
    }
  }
}

function controllerAbort(record: TaskRecord): void {
  try {
    record.controller.abort();
  } catch {
    // AbortController.abort never throws in practice; guard anyway.
  }
}

function snapshotOf(record: TaskRecord): BackgroundTaskSnapshot {
  return {
    handle: record.handle,
    dir: record.dir,
    summary: record.summary,
    model: record.model,
    agent: record.agent,
    state: record.state,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    progress: [...record.progress],
    text: record.text,
    error: record.error,
    conversationId: record.conversationId,
    details: record.details,
  };
}

/** Prompt summary helper shared with the session store format. */
export function summarizeTaskPrompt(prompt: string): string {
  return conversationSummary(prompt);
}
