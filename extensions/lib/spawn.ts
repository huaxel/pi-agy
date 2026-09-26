/**
 * Process primitives for running the agy CLI.
 *
 * Split out of `lib/cli.ts`: child-process spawning, bounded output capture,
 * process-tree termination, and the preflight command runner. No catalog,
 * arg-building, or stream-parsing state — `cli.ts` imports `runPreflightCommand`
 * for its inspect checks and re-exports `killProcessTree` for existing importers.
 */

import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

import type { ChildProcess } from "node:child_process";

// Ported from upstream pi-agy 0.3.4: Windows ENOENT errors must not suggest
// a bash one-liner.
export const INSTALL_HINT =
  process.platform === "win32"
    ? "Install agy: irm https://antigravity.google/cli/install.ps1 | iex"
    : "Install agy: curl -fsSL https://antigravity.google/cli/install.sh | bash";

const PREFLIGHT_TIMEOUT_MS = 10_000;
// Raw stdout capture bound; only the non-streaming/parse-failure fallback —
// the stream-json path accumulates results incrementally and is not capped by
// it. Large enough that plain-text fallbacks rarely truncate.
export const MAX_CAPTURE_BYTES = 1024 * 1024;

export function getSpawn() {
  return _require("node:child_process").spawn;
}

export function appendBounded(chunks: Buffer[], total: number, data: Buffer): number {
  const remaining = MAX_CAPTURE_BYTES - total;
  if (remaining > 0) chunks.push(data.subarray(0, remaining));
  return Math.min(MAX_CAPTURE_BYTES, total + data.length);
}

/**
 * Terminate a spawned agy process and any tools it started. Node's `signal`
 * and `timeout` spawn options only kill the direct child, so cancel/timeout
 * must kill the whole process group — otherwise a nested tool can keep
 * modifying files after Pi reported cancellation.
 */
export function killProcessTree(child: ChildProcess): void {
  try {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.pid && process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    return;
  }
  const escalate = setTimeout(() => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        if (child.pid && process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGKILL");
            return;
          } catch {
            // Fall through to direct kill.
          }
        }
        child.kill("SIGKILL");
      }
    } catch {
      // Best effort: the close handler reports the real outcome.
    }
  }, 2000);
  (escalate as unknown as { unref?: () => void }).unref?.();
}

export async function runPreflightCommand(
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  label: string,
  capture: boolean,
  timeoutMs?: number,
): Promise<string> {
  if (signal?.aborted) throw new Error(`${label} was cancelled`);
  const spawn = getSpawn();
  const timeout = Math.max(1, Math.min(PREFLIGHT_TIMEOUT_MS, timeoutMs ?? PREFLIGHT_TIMEOUT_MS));
  const child = spawn("agy", args, {
    cwd,
    stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"],
    // Managed manually below so cancellation kills the process group.
    detached: process.platform !== "win32",
  });
  let timedOut = false;
  const onAbort = () => killProcessTree(child);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child);
  }, timeout);
  (timer as unknown as { unref?: () => void }).unref?.();

  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr.on("data", (d: Buffer) => {
    stderrBytes = appendBounded(stderr, stderrBytes, d);
  });

  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  if (capture) {
    child.stdout?.on("data", (d: Buffer) => {
      stdoutBytes = appendBounded(stdout, stdoutBytes, d);
    });
  }

  let settled = false;

  await new Promise<void>((resolve, reject) => {
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    child.on("error", (err: Error) => {
      done(() => {
        if (signal?.aborted && !timedOut) reject(new Error(`${label} was cancelled`));
        else if (timedOut) reject(new Error(`${label} timed out`));
        else if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(`Antigravity CLI is not installed. ${INSTALL_HINT}`));
        } else reject(new Error(`${label} failed: ${err.message}`));
      });
    });

    child.on("close", (code: number | null) => {
      done(() => {
        if (signal?.aborted && !timedOut) {
          reject(new Error(`${label} was cancelled`));
          return;
        }
        if (code === 0 && !timedOut) resolve();
        else if (timedOut || code === null) {
          reject(new Error(`${label} timed out`));
        } else {
          const msg = Buffer.concat(stderr).toString("utf8").trim();
          const status = `exit ${code}`;
          // A failing --version probe usually means the CLI is present but
          // not authenticated; every failure names the check that failed.
          const authHint =
            args[0] === "--version"
              ? " — Antigravity CLI is not authenticated or not working"
              : "";
          reject(
            new Error(
              `${label} failed${authHint} (${status}). ${msg || "Run 'agy' interactively to authenticate."}`,
            ),
          );
        }
      });
    });
  });

  const stdoutText = capture ? Buffer.concat(stdout).toString("utf8") : "";
  // Stdout only: stderr diagnostics must never leak into catalog parsing.
  return stdoutText;
}

import { StringDecoder } from "node:string_decoder";

import { buildAgyArgs } from "./args.js";
import {
  accumulateRunResult,
  appendStreamChunk,
  finalizeRunResult,
  formatStepProgress,
  parseStreamLine,
  summarizeAgyDeniedActions,
  type AgyProgressHandler,
  type AgyRunResult,
  type AgyStreamLine,
} from "./stream.js";
import type { AgyOptions } from "./cli.js";

export function spawnAgy(options: AgyOptions, signal: AbortSignal): Promise<string> {
  return spawnAgyInternal(options, signal).then((result) => result.response);
}

/** Real agy work (tool steps / model responses), as opposed to lifecycle chatter. */
function isActivityProgress(parsed: AgyStreamLine): boolean {
  const step = parsed.step_update;
  return (
    step?.step_type === "tool" ||
    step?.step_type === "subagent" ||
    step?.step_type === "agent_response"
  );
}

export function spawnAgyStream(
  options: AgyOptions,
  signal: AbortSignal,
  onProgress?: AgyProgressHandler,
): Promise<AgyRunResult> {
  return spawnAgyInternal(options, signal, onProgress);
}

function spawnAgyInternal(
  options: AgyOptions,
  signal: AbortSignal,
  onProgress?: AgyProgressHandler,
): Promise<AgyRunResult> {
  const spawn = getSpawn();
  const args = buildAgyArgs(options);
  // The parent process owns the hard deadline; agy's second-based timeout is
  // rounded up, so do not add grace time here.
  const alignedTimeout = Math.max(1, options.timeout_ms);

  return new Promise<AgyRunResult>((resolve, reject) => {
    if (signal.aborted) {
      reject(withConversationId("agy was cancelled", { response: "" }));
      return;
    }
    const child = spawn("agy", args, {
      cwd: options.dir,
      stdio: ["ignore", "pipe", "pipe"],
      // Managed manually so abort/timeout kills nested tool processes too.
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    const onAbort = () => killProcessTree(child);
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, alignedTimeout);
    (timer as unknown as { unref?: () => void }).unref?.();

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let lineBuffer = "";
    let runResult: AgyRunResult = { response: "" };
    const decoder = new StringDecoder("utf8");

    const processStdoutText = (text: string): void => {
      if (!text) return;
      const chunk = appendStreamChunk(lineBuffer, text, onProgress);
      lineBuffer = chunk.lineBuffer;
      for (const line of chunk.lines) {
        runResult = processStreamLine(line, runResult, onProgress);
      }
    };

    child.stdout.on("data", (d: Buffer) => {
      const before = stdoutBytes;
      stdoutBytes = appendBounded(stdout, stdoutBytes, d);
      // The raw buffer is only a fallback; flag overflow so a verbatim
      // response is never served as silently truncated text.
      if (before + d.length > stdoutBytes) stdoutTruncated = true;
      processStdoutText(decoder.write(d));
    });

    child.stderr.on("data", (d: Buffer) => {
      stderrBytes = appendBounded(stderr, stderrBytes, d);
    });

    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };

    child.on("error", (err: Error) => {
      done(() => {
        const message =
          signal.aborted && !timedOut
            ? "agy was cancelled"
            : timedOut
              ? "agy timed out"
              : (err as NodeJS.ErrnoException).code === "ENOENT"
                ? `Antigravity CLI not found in PATH. ${INSTALL_HINT}`
                : `agy spawn failed: ${err.message}`;
        reject(withConversationId(message, runResult));
      });
    });

    child.on("close", (code: number | null, sig: string | null) => {
      done(() => {
        const out = Buffer.concat(stdout).toString("utf8");
        const err = Buffer.concat(stderr).toString("utf8");

        // Flush a partial UTF-8 sequence before handling the final record.
        processStdoutText(decoder.end());

        // JSONL producers normally terminate every record with a newline, but
        // process failures can leave the final record unterminated. Parse it
        // before handling the exit code so retry logic sees real activity and
        // users still receive the terminal progress update. The remainder is
        // bounded by appendStreamChunk, so no length check is needed here.
        if (lineBuffer.trim()) {
          runResult = processStreamLine(lineBuffer, runResult, onProgress);
        }

        // Finalization also parses whole top-level JSON envelopes, including
        // pretty-printed output that cannot be consumed one line at a time.
        const finalized = finalizeRunResult(out, runResult);

        // Terminal status is authoritative when present. agy can emit an
        // ERROR envelope with response: "" and even exit 0; response
        // completeness must never turn that failed turn into success.
        const terminalFailure = terminalFailureMessage(finalized, err);
        if (terminalFailure) {
          reject(withConversationId(terminalFailure, finalized));
          return;
        }

        // Headless permission denials are intentionally nonfatal in agy and
        // can therefore arrive as SUCCESS with an empty response. Never turn
        // that incomplete delegation into a silent successful tool result.
        if (finalized.denied_actions?.length && !finalized.response.trim()) {
          const denied = summarizeAgyDeniedActions(finalized.denied_actions);
          reject(withConversationId(`agy denied tool actions: ${denied}`, finalized));
          return;
        }

        // A fully delivered successful result outranks the kill: when
        // cancellation or timeout lands after the response arrived, the work
        // is done and the response must not be discarded.
        if (finalized.response_complete) {
          resolve(finalized);
          return;
        }

        if (sig === "SIGTERM" || sig === "SIGKILL" || code === null) {
          reject(
            withConversationId(
              signal.aborted && !timedOut ? "agy was cancelled" : "agy timed out",
              finalized,
            ),
          );
          return;
        }

        if (code !== 0) {
          const detail = (err || out).slice(0, 2000).trim();
          reject(withConversationId(`agy exited with code ${code}:\n${detail || "(no output)"}`, finalized));
          return;
        }

        // agy writes diagnostics to stderr even on successful runs. Keep it
        // out of the response so JSON/stream parsing remains deterministic.
        // Only responses served verbatim from the bounded raw capture can be
        // incomplete; anything parsed from a record was delivered in full.
        if (stdoutTruncated && !finalized.response_complete) {
          finalized.response += `\n\n(raw stdout capture was truncated at the ${MAX_CAPTURE_BYTES / 1024} KB fallback bound)`;
        }
        resolve(finalized);
      });
    });
  });
}

const SUCCESSFUL_TERMINAL_STATUSES = new Set(["SUCCESS", "OK"]);

function terminalFailureMessage(runResult: AgyRunResult, stderr: string): string | undefined {
  if (runResult.terminal_status === undefined) return undefined;
  const status = runResult.terminal_status
    .trim()
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .slice(0, 64);
  if (SUCCESSFUL_TERMINAL_STATUSES.has(status.toUpperCase())) return undefined;

  const detail = runResult.terminal_error?.trim();
  let message = `agy reported terminal status ${status || "(empty)"}`;
  if (detail) message += `: ${detail}`;
  const stderrDetail = stderr.trim().slice(0, 2_000);
  if (stderrDetail && !message.includes(stderrDetail)) message += `\n${stderrDetail}`;
  return message;
}

function withConversationId(message: string, runResult: AgyRunResult): Error {
  const error = new Error(message) as Error & { conversation_id?: string };
  if (runResult.conversation_id) error.conversation_id = runResult.conversation_id;
  return error;
}

function processStreamLine(
  line: string,
  current: AgyRunResult,
  onProgress?: AgyProgressHandler,
): AgyRunResult {
  const parsed = parseStreamLine(line);
  if (!parsed) return current;

  const next = accumulateRunResult(parsed, current);
  const activity = isActivityProgress(parsed);
  const progress = formatStepProgress(parsed);
  if (progress) onProgress?.(progress, activity ? "activity" : "status");
  else if (activity) onProgress?.("agy: working…", "activity");
  return next;
}
