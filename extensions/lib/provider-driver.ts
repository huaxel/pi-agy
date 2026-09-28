/**
 * Persistent agy driver for provider turns.
 *
 * One long-lived `agy --input-format stream-json --output-format stream-json`
 * child per profile (working directory + model + effort + permissions).
 * Turns serialize through a per-driver queue; each turn is one
 * `{"event":"user",...}` stdin line, and stdout NDJSON (`init` / `step_update`
 * / `result`) is routed to the active turn.
 *
 * Reuse rules: a turn reuses the live child when the profile matches and the
 * requested conversation matches the bound one (including both unset — agy
 * keeps the conversation natively, so follow-ups skip cold start and OAuth
 * refresh). Anything else recycles the child (kill + respawn) with a recorded
 * reason. Abort/timeout kills the child — a single turn cannot be cancelled
 * reliably headless — and partial text settles with an explicit flag, never
 * as a clean stop. Idle children are reaped; `close()` disposes everything
 * (wire to `session_shutdown`).
 *
 * Terminal envelopes fail closed, mirroring the per-turn runner this
 * replaces: only SUCCESS/OK statuses are accepted, and a denied run with no
 * response rejects instead of answering empty.
 */

import { StringDecoder } from "node:string_decoder";

import type { ChildProcess } from "node:child_process";

import { getSpawn, killProcessTree } from "./spawn.js";
import {
  accumulateRunResult,
  appendStreamChunk,
  formatStepProgress,
  parseStreamLine,
  type AgyRunResult,
} from "./stream.js";
import type {
  AgyProviderEffort,
} from "./provider-models.js";

export interface ProviderDriverProfile {
  dir: string;
  fullModel: string;
  effort?: AgyProviderEffort;
  skipPermissions: boolean;
  /** Bridge config dir for an extra `--add-dir` (MCP tool discovery). */
  bridgeDir?: string;
  /** Image staging root for an extra `--add-dir` (sandboxed file reads). */
  imageRoot?: string;
  /** Fingerprint of the bridged Pi-tool catalog; changes recycle (fresh ListTools). */
  bridgeTools?: string;
}

export interface ProviderDriverTurn {
  prompt: string;
  resumeConversationId?: string;
  signal: AbortSignal;
  timeoutMs: number;
  onText?: (delta: string) => void;
  onActivity?: (label: string) => void;
}

export interface ProviderDriverOutcome {
  text: string;
  truncated: boolean;
  aborted?: boolean;
  timedOut?: boolean;
  conversationId?: string;
  activity: string[];
  deniedActions?: Array<{ action?: string; display_name?: string }>;
}

/** A bridged Pi-tool call parked mid-turn: agy waits on the MCP response. */
export interface DriverPark {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * One phase of a driver turn ends parked (resume with continueTurn after
 * delivering tool results) or done (terminal outcome).
 */
export type DriverTurnEnd =
  | { kind: "done"; outcome: ProviderDriverOutcome }
  | { kind: "parked"; park: DriverPark };

export interface ProviderDriverStats {
  spawns: number;
  turns: number;
  reuses: number;
  recycles: number;
  lastRecycleReason?: string;
}

export interface ProviderDriverSnapshot {
  state: "idle" | "running" | "dead";
  pid?: number;
  boundConversationId?: string;
  stats: ProviderDriverStats;
  lifecycle: string[];
}

/** Idle children are reaped so stale auth/processes never linger. */
export const PROVIDER_DRIVER_IDLE_MS = 5 * 60_000;
/** Cap streamed response text per turn. */
const MAX_TURN_TEXT_CHARS = 512_000;
const MAX_ACTIVITY_ENTRIES = 32;
const MAX_STDERR_TAIL_CHARS = 8_000;
const LIFECYCLE_LIMIT = 24;

interface TurnPhase {
  resolve: (end: DriverTurnEnd) => void;
  reject: (error: Error) => void;
}

/** Wall-clock cap for a suspended (parked) turn without Pi progress. */
export const SUSPENDED_TURN_MAX_MS = 30 * 60_000;

interface ActiveTurn {
  signal: AbortSignal;
  timeoutMs: number;
  onText?: (delta: string) => void;
  onActivity?: (label: string) => void;
  text: string;
  truncated: boolean;
  activity: string[];
  seenActivity: Set<string>;
  runResult: AgyRunResult;
  /** Terminally settled (done/error/abort/timeout): the record is over. */
  settled: boolean;
  /** Suspended mid-turn on a parked bridge call: child alive, timers off. */
  suspended: boolean;
  /** Live waiter for the current phase (turn() or continueTurn()). */
  phase?: TurnPhase;
  timer?: NodeJS.Timeout;
  suspendedTimer?: NodeJS.Timeout;
  onAbort?: () => void;
}

function profileKey(profile: ProviderDriverProfile): string {
  return `${profile.dir}::${profile.fullModel}::${profile.effort ?? ""}::${profile.skipPermissions ? "skip" : "ask"}::${profile.bridgeDir ?? ""}::${profile.bridgeTools ?? ""}::${profile.imageRoot ?? ""}`;
}

export class AgyProviderDriver {
  private child?: ChildProcess;
  private generation = 0;
  private profile?: ProviderDriverProfile;
  private boundConversationId?: string;
  private active?: ActiveTurn;
  private queue: Promise<void> = Promise.resolve();
  private idleTimer?: NodeJS.Timeout;
  private readonly idleMs: number;
  private lineBuffer = "";
  private readonly decoder = new StringDecoder("utf8");
  /**
   * Stdout lines that arrived with no turn to route to (startup chatter,
   * eager single-shot processes). Replayed into the first turn on this
   * process incarnation, then dropped — late lines between settled turns
   * belong to no turn and must never leak into the next one.
   */
  private pendingLines: string[] = [];
  private primed = false;
  private static readonly MAX_PENDING_LINES = 64;
  private stderrTail = "";
  private stats: ProviderDriverStats = { spawns: 0, turns: 0, reuses: 0, recycles: 0 };
  private lifecycle: string[] = [];
  private closed = false;

  constructor(options?: { idleMs?: number }) {
    this.idleMs = options?.idleMs ?? PROVIDER_DRIVER_IDLE_MS;
  }

  /**
   * Submit a turn; concurrent turns queue behind the active one. Resolves
   * with the first phase end: terminal `done`, or `parked` when agy calls a
   * bridged Pi tool (resume with continueTurn after delivering results).
   */
  turn(profile: ProviderDriverProfile, turn: ProviderDriverTurn): Promise<DriverTurnEnd> {
    if (this.closed) return Promise.reject(new Error("agy provider driver is closed"));
    if (turn.signal.aborted) return Promise.reject(new Error("agy provider turn was cancelled"));
    const run = this.queue.then(() => this.runTurn(profile, turn));
    // A rejection must not break the chain for later turns.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Called when parked bridge calls are orphaned (never completed). */
  onParksOrphaned?: (message: string) => void;

  /**
   * Accept a parked bridge call for the active turn. Suspends the turn
   * (timers off, child alive) and ends the current phase as parked.
   * Returns false when no turn can take the park — the caller must fail it.
   */
  notifyPark(park: DriverPark): boolean {
    const turn = this.active;
    if (!turn || turn.settled || turn.suspended || !turn.phase) return false;
    turn.suspended = true;
    if (turn.timer) {
      clearTimeout(turn.timer);
      turn.timer = undefined;
    }
    // Abandoned suspensions (Pi session died without shutdown) must not
    // hold the child forever.
    turn.suspendedTimer = setTimeout(() => {
      turn.suspendedTimer = undefined;
      this.killChild();
      this.failParksOrphaned("agy provider turn was abandoned while awaiting Pi tools");
      this.settleError(turn, new Error("agy provider turn was abandoned while awaiting Pi tools"));
    }, SUSPENDED_TURN_MAX_MS);
    (turn.suspendedTimer as unknown as { unref?: () => void }).unref?.();
    const phase = turn.phase;
    turn.phase = undefined;
    this.log(`park:${park.toolName}`);
    phase.resolve({ kind: "parked", park });
    return true;
  }

  private clearSuspendedTimer(turn: ActiveTurn): void {
    if (turn.suspendedTimer) {
      clearTimeout(turn.suspendedTimer);
      turn.suspendedTimer = undefined;
    }
  }

  private failParksOrphaned(message: string): void {
    try {
      this.onParksOrphaned?.(message);
    } catch {
      // A failing orphan hook must never break turn teardown.
    }
  }

  /**
   * Resume a suspended turn after its parked calls were completed.
   * Re-arms the full turn timeout (round-trips wait on user approvals) and
   * waits for the next phase end. Signal, timeout, and callbacks rebind to
   * the current Pi turn: the previous turn's stream — and its abort signal
   * — are over, and a stale abort must never kill the resumed child.
   */
  continueTurn(options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    onText?: (delta: string) => void;
    onActivity?: (label: string) => void;
  }): Promise<DriverTurnEnd> {
    const turn = this.active;
    if (this.closed) throw new Error("agy provider driver was closed");
    if (!turn || turn.settled || !turn.suspended) {
      throw new Error("agy provider driver has no suspended turn");
    }
    if (!this.child) throw new Error("agy provider turn lost its process while suspended");
    turn.suspended = false;
    this.clearSuspendedTimer(turn);
    if (options?.onText) turn.onText = options.onText;
    if (options?.onActivity) turn.onActivity = options.onActivity;
    if (options?.timeoutMs !== undefined) turn.timeoutMs = options.timeoutMs;
    if (turn.onAbort) {
      turn.signal.removeEventListener("abort", turn.onAbort);
      turn.onAbort = undefined;
    }
    if (options?.signal) {
      turn.signal = options.signal;
      const onAbort = (): void => {
        if (turn.settled) return;
        this.killChild();
        if (turn.text) this.settleDone(turn, { aborted: true });
        else this.settleError(turn, new Error("agy provider turn was cancelled"));
      };
      turn.onAbort = onAbort;
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) onAbort();
    }
    return new Promise<DriverTurnEnd>((resolve, reject) => {
      turn.phase = { resolve, reject };
      turn.timer = setTimeout(() => {
        // A resumed timeout kills the hung child like a fresh one: never
        // leave it running to be reused.
        this.killChild();
        if (turn.text) this.settleDone(turn, { timedOut: true });
        else this.settleError(turn, new Error("agy provider turn timed out"));
      }, Math.max(1, Math.min(PROVIDER_TURN_TIMEOUT_MS, turn.timeoutMs)));
      (turn.timer as unknown as { unref?: () => void }).unref?.();
    });
  }

  /** Abandon the active turn (suspended or not): kill the child and fail loudly. */
  cancelSuspended(message: string): void {
    const turn = this.active;
    if (!turn) return;
    this.killChild();
    this.failParksOrphaned(message);
    this.settleError(turn, new Error(message));
  }

  snapshot(): ProviderDriverSnapshot {
    return {
      state: this.child ? (this.active ? "running" : "idle") : "dead",
      pid: this.child?.pid,
      boundConversationId: this.boundConversationId,
      stats: { ...this.stats },
      lifecycle: [...this.lifecycle],
    };
  }

  /** Kill the child and reset; the next turn respawns lazily. */
  async close(): Promise<void> {
    this.closed = true;
    this.clearIdleTimer();
    if (this.active && !this.active.settled) {
      // Never strand a caller: a closed driver fails its turns loudly.
      this.settleError(this.active, new Error("agy provider driver was closed"));
    }
    this.killChild();
  }

  private log(event: string): void {
    this.lifecycle.push(`${new Date().toISOString()} ${event}`);
    if (this.lifecycle.length > LIFECYCLE_LIMIT) {
      this.lifecycle.splice(0, this.lifecycle.length - LIFECYCLE_LIMIT);
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.closed) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (!this.active && this.child) {
        this.log("idle-reap");
        this.killChild();
        this.child = undefined;
        this.profile = undefined;
        this.boundConversationId = undefined;
      }
    }, this.idleMs);
    (this.idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  private recycleReason(profile: ProviderDriverProfile, resume?: string): string | undefined {
    if (!this.child || !this.profile) return "no-process";
    if (profileKey(this.profile) !== profileKey(profile)) {
      if (this.profile.dir !== profile.dir) return "dir-changed";
      if (this.profile.fullModel !== profile.fullModel) return "model-changed";
      if ((this.profile.effort ?? "") !== (profile.effort ?? "")) return "effort-changed";
      if ((this.profile.bridgeDir ?? "") !== (profile.bridgeDir ?? "")) return "bridge-changed";
      if ((this.profile.imageRoot ?? "") !== (profile.imageRoot ?? "")) return "images-changed";
      if ((this.profile.bridgeTools ?? "") !== (profile.bridgeTools ?? "")) return "tools-changed";
      return "permissions-changed";
    }
    if ((resume ?? undefined) !== this.boundConversationId) return "conversation-changed";
    return undefined;
  }

  private killChild(): void {
    this.generation += 1;
    const child = this.child;
    this.child = undefined;
    this.profile = undefined;
    this.boundConversationId = undefined;
    if (child) killProcessTree(child);
  }

  private spawn(profile: ProviderDriverProfile, resume?: string): void {
    const spawn = getSpawn();
    const args = ["--add-dir", profile.dir, "--model", profile.fullModel];
    if (profile.effort) args.push("--effort", profile.effort);
    if (resume) args.push("--conversation", resume);
    if (profile.skipPermissions) args.push("--dangerously-skip-permissions");
    if (profile.bridgeDir) args.push("--add-dir", profile.bridgeDir);
    if (profile.imageRoot) args.push("--add-dir", profile.imageRoot);
    // Same flags as the former per-turn spawn, minus `-p`: turns arrive on stdin.
    args.push("--input-format", "stream-json", "--output-format", "stream-json");

    const generation = this.generation;
    const child = spawn("agy", args, {
      cwd: profile.dir,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.child = child;
    this.profile = profile;
    this.boundConversationId = resume ?? undefined;
    this.lineBuffer = "";
    this.pendingLines = [];
    this.primed = false;
    this.stderrTail = "";
    this.stats.spawns += 1;
    this.log(`spawn:${child.pid ?? "?"}:${resume ? "resume" : "fresh"}`);

    // EPIPE surfaces async; without this listener a write to a dead child
    // throws uncaught and kills Pi. Deliberately no fail-fast here: the
    // child's stdout close/exit settles the turn (a terminal envelope
    // already in the pipe still wins over the transport error), and the
    // turn timeout bounds a child that stays alive with dead stdin.
    child.stdin?.on("error", (error: Error) => {
      if (generation !== this.generation) return;
      this.log(`stdin-error:${error.message}`);
    });
    child.stdout?.on("data", (data: Buffer) => {
      if (generation !== this.generation) return;
      this.onStdout(data);
    });
    child.stderr?.on("data", (data: Buffer) => {
      if (generation !== this.generation) return;
      this.stderrTail = (this.stderrTail + data.toString("utf8")).slice(-MAX_STDERR_TAIL_CHARS);
    });
    child.on("error", (error: Error) => {
      if (generation !== this.generation) return;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.failActive(
          "Antigravity CLI is not installed. Install agy: curl -fsSL https://antigravity.google/cli/install.sh | bash",
        );
      } else {
        this.failActive(`agy driver failed: ${error.message}`);
      }
      this.killChild();
    });
    child.on("close", (code: number | null) => {
      if (generation !== this.generation) return;
      const wasActive = this.active && !this.active.settled;
      this.child = undefined;
      this.profile = undefined;
      this.boundConversationId = undefined;
      this.log(`exit:${code ?? "signal"}`);
      // Abort/timeout paths settle the turn themselves before killing; an
      // unsettled turn here means the child died mid-turn: fail closed.
      if (wasActive) {
        this.failActive(
          `agy driver exited mid-turn (code ${code ?? "signal"})${this.stderrTail.trim() ? `: ${this.stderrTail.trim().slice(0, 300)}` : ""}`,
        );
      }
    });
  }

  private ensureProcess(profile: ProviderDriverProfile, resume?: string): void {
    const reason = this.recycleReason(profile, resume);
    if (reason === undefined && this.child) {
      this.stats.reuses += 1;
      this.log("reuse");
      return;
    }
    if (this.child) {
      this.stats.recycles += 1;
      this.stats.lastRecycleReason = reason ?? "unknown";
      this.log(`recycle:${reason ?? "unknown"}`);
      this.killChild();
    }
    this.spawn(profile, resume);
  }

  private pushText(turn: ActiveTurn, delta: string): void {
    if (!delta || turn.settled) return;
    const remaining = MAX_TURN_TEXT_CHARS - turn.text.length;
    if (remaining <= 0) {
      turn.truncated = true;
      return;
    }
    const slice = delta.slice(0, remaining);
    turn.text += slice;
    if (slice.length < delta.length) turn.truncated = true;
    try {
      turn.onText?.(slice);
    } catch {
      // Output for a suspended turn whose Pi stream already ended must
      // never crash the driver; the text is still recorded.
    }
  }

  private pushActivity(turn: ActiveTurn, label: string): void {
    if (turn.settled || turn.seenActivity.has(label) || turn.activity.length >= MAX_ACTIVITY_ENTRIES) return;
    turn.seenActivity.add(label);
    turn.activity.push(label);
    try {
      turn.onActivity?.(label);
    } catch {
      // Same dead-stream tolerance as text deltas.
    }
  }

  /** Append live agent_response text, tolerating delta and cumulative shapes. */
  private pushLiveText(turn: ActiveTurn, textDelta?: string, responseText?: string): void {
    if (typeof textDelta === "string" && textDelta) {
      this.pushText(turn, textDelta);
      return;
    }
    if (typeof responseText === "string" && responseText.length > turn.text.length) {
      this.pushText(turn, responseText.slice(turn.text.length));
    }
  }

  private onStdout(data: Buffer): void {
    const chunk = appendStreamChunk(this.lineBuffer, this.decoder.write(data), undefined);
    this.lineBuffer = chunk.lineBuffer;
    const turn = this.active;
    if (!turn || turn.settled) {
      if (!this.primed) {
        this.pendingLines.push(...chunk.lines);
        if (this.pendingLines.length > AgyProviderDriver.MAX_PENDING_LINES) {
          this.pendingLines.splice(0, this.pendingLines.length - AgyProviderDriver.MAX_PENDING_LINES);
        }
      }
      return;
    }
    for (const line of chunk.lines) this.handleLine(turn, line);
  }

  private handleLine(turn: ActiveTurn, line: string): void {
    if (turn.settled) return;
    const parsed = parseStreamLine(line);
    if (!parsed) return;
    const step = parsed.step_update;
    if (step?.step_type === "agent_response") {
      this.pushLiveText(turn, step.text_delta, undefined);
      // response_text may arrive on the same record family in other builds.
      const record = step as { response_text?: string };
      if (typeof record.response_text === "string") {
        this.pushLiveText(turn, undefined, record.response_text);
      }
    }
    const progress = formatStepProgress(parsed);
    if (progress && !parsed.result) this.pushActivity(turn, progress);
    // Shared accumulator: terminal status, usage, denied actions, and
    // conversation ids track exactly like the former per-turn runner.
    turn.runResult = accumulateRunResult(parsed, turn.runResult);
    if (parsed.event === "result" || parsed.result) {
      this.settleFromResult(turn);
    }
  }

  private settleFromResult(turn: ActiveTurn): void {
    if (turn.settled) return;
    const result = turn.runResult;
    const status = result.terminal_status;
    if (status && status !== "SUCCESS" && status !== "OK") {
      this.settleError(
        turn,
        new Error(
          `agy provider turn failed (${status})${result.terminal_error ? `: ${result.terminal_error}` : ""}`,
        ),
      );
      return;
    }
    if ((result.denied_actions?.length ?? 0) > 0 && !result.response_complete && !turn.text) {
      this.settleError(
        turn,
        new Error(
          "agy denied all actions for this turn with no response; retry with a narrower request or enable permissions",
        ),
      );
      return;
    }
    // The terminal response is authoritative when present (identical final
    // text to the per-turn runner); streamed deltas already reached the UI.
    const text = result.response_complete && result.response ? result.response : turn.text;
    this.settleDone(turn, { text });
  }

  private settleDone(
    turn: ActiveTurn,
    overrides?: { text?: string; aborted?: boolean; timedOut?: boolean },
  ): void {
    if (turn.settled) return;
    turn.settled = true;
    turn.suspended = false;
    this.clearSuspendedTimer(turn);
    if (turn.timer) {
      clearTimeout(turn.timer);
      turn.timer = undefined;
    }
    if (turn.onAbort) turn.signal.removeEventListener("abort", turn.onAbort);
    if (this.active === turn) this.active = undefined;
    // Bind the conversation the turn actually produced: the next turn
    // reuses only when it asks for this exact conversation (or a fresh
    // process when none is bound). Unterminated line remnants belong to no
    // turn and must never bleed into the next one.
    if (turn.runResult.conversation_id) {
      this.boundConversationId = turn.runResult.conversation_id;
    }
    this.lineBuffer = "";
    const phase = turn.phase;
    turn.phase = undefined;
    phase?.resolve({
      kind: "done",
      outcome: {
        text: overrides?.text ?? turn.text,
        truncated: turn.truncated,
        aborted: overrides?.aborted,
        timedOut: overrides?.timedOut,
        conversationId: turn.runResult.conversation_id,
        activity: turn.activity,
        deniedActions: turn.runResult.denied_actions,
      },
    });
    this.armIdleTimer();
  }

  private settleError(turn: ActiveTurn, error: Error): void {
    if (turn.settled) return;
    turn.settled = true;
    turn.suspended = false;
    this.clearSuspendedTimer(turn);
    if (turn.timer) {
      clearTimeout(turn.timer);
      turn.timer = undefined;
    }
    if (turn.onAbort) turn.signal.removeEventListener("abort", turn.onAbort);
    if (this.active === turn) this.active = undefined;
    const phase = turn.phase;
    turn.phase = undefined;
    phase?.reject(error);
    this.armIdleTimer();
  }

  private failActive(message: string): void {
    const turn = this.active;
    if (!turn || turn.settled) return;
    this.settleError(turn, new Error(message));
  }

  private async runTurn(
    profile: ProviderDriverProfile,
    options: ProviderDriverTurn,
  ): Promise<DriverTurnEnd> {
    // Queued turns may run after close(): fail closed instead of spawning.
    if (this.closed) throw new Error("agy provider driver was closed");
    return new Promise<DriverTurnEnd>((resolve, reject) => {
      if (options.signal.aborted) {
        reject(new Error("agy provider turn was cancelled"));
        return;
      }
      this.clearIdleTimer();
      // A suspended turn belongs to another Pi turn in flight: concurrent
      // bridged sessions in one directory are unsupported — fail fast
      // instead of stealing (or killing) the parked child.
      if (this.active && this.active.suspended && !this.active.settled) {
        throw new Error(
          "another agy turn is suspended awaiting Pi tools in this directory",
        );
      }
      this.ensureProcess(profile, options.resumeConversationId);
      const child = this.child;
      if (!child) {
        reject(new Error("agy provider driver has no process"));
        this.armIdleTimer();
        return;
      }
      // Replay anything the process emitted before this turn existed.
      const turn: ActiveTurn = {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        onText: options.onText,
        onActivity: options.onActivity,
        text: "",
        truncated: false,
        activity: [],
        seenActivity: new Set<string>(),
        runResult: { response: "" },
        settled: false,
        suspended: false,
        phase: { resolve, reject },
      };
      this.active = turn;
      this.stats.turns += 1;
      this.log(`turn:${profile.fullModel}:${options.resumeConversationId ? "resume" : "fresh"}`);
      if (!this.primed) {
        this.primed = true;
        const pending = this.pendingLines;
        this.pendingLines = [];
        for (const line of pending) this.handleLine(turn, line);
        if (turn.settled) return;
      }

      const killFor = (flag: "aborted" | "timedOut", message: string): void => {
        if (turn.settled) return;
        // A turn cannot be cancelled headless without killing the child; the
        // next turn respawns lazily. Partial text settles with a flag, never
        // as a clean result. A stale signal during suspension abandons the
        // turn: parks are orphaned loudly instead of stranding agy.
        if (turn.suspended) {
          this.killChild();
          this.failParksOrphaned(message);
          this.settleError(turn, new Error(message));
          return;
        }
        this.killChild();
        if (turn.text) {
          this.settleDone(turn, flag === "aborted" ? { aborted: true } : { timedOut: true });
        } else {
          this.settleError(turn, new Error(message));
        }
      };

      const onAbort = (): void => killFor("aborted", "agy provider turn was cancelled");
      turn.onAbort = onAbort;
      options.signal.addEventListener("abort", onAbort, { once: true });
      turn.timer = setTimeout(() => {
        killFor("timedOut", "agy provider turn timed out");
      }, Math.max(1, Math.min(PROVIDER_TURN_TIMEOUT_MS, options.timeoutMs)));
      (turn.timer as unknown as { unref?: () => void }).unref?.();

      const line = `${JSON.stringify({
        event: "user",
        message: { role: "user", content: options.prompt },
      })}\n`;
      try {
        const stdin = child.stdin;
        if (!stdin) throw new Error("agy driver stdin unavailable");
        stdin.write(line);
      } catch (error) {
        this.settleError(turn, new Error(`failed to write to agy driver: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }
}

/** Parent-side turn deadline shared with the per-turn runner. */
export const PROVIDER_TURN_TIMEOUT_MS = 600_000;
