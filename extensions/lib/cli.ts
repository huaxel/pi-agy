import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import {
  accumulateRunResult,
  appendStreamChunk,
  finalizeRunResult,
  formatStepProgress,
  parseStreamLine,
  type AgyProgressHandler,
  type AgyRunResult,
  type AgyStreamLine,
} from "./stream.js";

export { detectVerifyCommand } from "./verify.js";
export { parseJsonResponse } from "./parse.js";

const INSTALL_HINT = "Install agy: curl -fsSL https://antigravity.google/cli/install.sh | bash";

export type AgyModel =
  | "flash-low"
  | "flash-medium"
  | "flash-high"
  | "pro-low"
  | "pro-high"
  | "sonnet"
  | "opus"
  | "gpt-oss";

export const AGY_MODEL_ALIASES: readonly AgyModel[] = [
  "flash-low",
  "flash-medium",
  "flash-high",
  "pro-low",
  "pro-high",
  "sonnet",
  "opus",
  "gpt-oss",
];

export function isAgyModel(value: unknown): value is AgyModel {
  return typeof value === "string" && (AGY_MODEL_ALIASES as readonly string[]).includes(value);
}

export type AgyEffort = "low" | "medium" | "high";

export interface AgyOptions {
  prompt: string;
  model?: AgyModel;
  tier?: "flash" | "flash-lo" | "pro";
  effort?: AgyEffort;
  mode?: "plan" | "accept-edits" | "sandbox";
  dir: string;
  timeout_ms: number;
  conversation_id?: string;
  continue?: boolean;
  stream?: boolean;
  skipPermissions?: boolean;
}

const PREFLIGHT_TIMEOUT_MS = 10_000;
// Raw stdout capture bound; only used as the non-streaming fallback — the
// stream-json path accumulates results incrementally and is not capped by it.
const MAX_CAPTURE_BYTES = 64 * 1024;
// Preview/experimental model ids must never win catalog resolution implicitly.
const UNSTABLE_MODEL_PATTERN = /(?:preview|experimental|beta|alpha|\brc\b|snapshot|\bnext\b)/i;

// Static fallback for when `agy models` output is unavailable. The live
// catalog (updated during preflight) overrides these per alias.
const MODEL_MAP: Record<AgyModel, string> = {
  "flash-low": "gemini-3.8-flash-low",
  "flash-medium": "gemini-3.8-flash-medium",
  "flash-high": "gemini-3.8-flash-high",
  "pro-low": "gemini-3.1-pro-low",
  "pro-high": "gemini-3.1-pro-high",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6-thinking",
  "gpt-oss": "gpt-oss-120b-medium",
};

const TIER_MAP: Record<NonNullable<AgyOptions["tier"]>, AgyModel> = {
  flash: "flash-high",
  "flash-lo": "flash-low",
  pro: "pro-high",
};

/** alias → pattern matching concrete model ids in `agy models` output. */
const UNSTABLE_SUFFIX = "(?:-(?:preview|experimental|beta|alpha|rc\\d*|snapshot|next))*";
const CATALOG_PATTERNS: Record<AgyModel, RegExp> = {
  "flash-low": new RegExp(`^gemini-\\d+(?:\\.\\d+)*-flash-low${UNSTABLE_SUFFIX}$`),
  "flash-medium": new RegExp(`^gemini-\\d+(?:\\.\\d+)*-flash-medium${UNSTABLE_SUFFIX}$`),
  "flash-high": new RegExp(`^gemini-\\d+(?:\\.\\d+)*-flash-high${UNSTABLE_SUFFIX}$`),
  "pro-low": new RegExp(`^gemini-\\d+(?:\\.\\d+)*-pro-low${UNSTABLE_SUFFIX}$`),
  "pro-high": new RegExp(`^gemini-\\d+(?:\\.\\d+)*-pro-high${UNSTABLE_SUFFIX}$`),
  sonnet: /^claude-sonnet-[\w.-]+$/,
  opus: /^claude-opus-[\w.-]+$/,
  "gpt-oss": /^gpt-oss-[\w.-]+$/,
};

export type AgyModelCatalog = Partial<Record<AgyModel, string>>;

let modelCatalog: AgyModelCatalog = {};

export function isStableModelId(id: string): boolean {
  return !UNSTABLE_MODEL_PATTERN.test(id);
}

/**
 * Parse `agy models` output into alias → concrete model id. Newer model
 * generations win over older ones so aliases track the latest catalog.
 * Preview/experimental ids are ignored unless `allowPreview` is set, so an
 * unstable catalog entry can never silently become the default model.
 */
export function parseModelCatalog(output: string, allowPreview = false): AgyModelCatalog {
  const allow = allowPreview || process.env.PI_AGY_ALLOW_PREVIEW === "1";
  const found: AgyModelCatalog = {};
  for (const line of output.split("\n")) {
    const id = line.trim().split(/\s+/)[0] ?? "";
    if (!id) continue;
    if (!allow && !isStableModelId(id)) continue;
    for (const [alias, pattern] of Object.entries(CATALOG_PATTERNS) as Array<[AgyModel, RegExp]>) {
      if (pattern.test(id) && compareModelIds(id, found[alias] ?? "") > 0) {
        found[alias] = id;
      }
    }
  }
  return found;
}

function compareModelIds(a: string, b: string): number {
  if (!b) return 1;
  const versionA = /^gemini-(\d+(?:\.\d+)*)-/.exec(a)?.[1];
  const versionB = /^gemini-(\d+(?:\.\d+)*)-/.exec(b)?.[1];
  if (versionA && versionB) return compareDottedVersions(versionA, versionB);
  // Numeric-aware compare so claude-sonnet-4-10 sorts above claude-sonnet-4-6.
  return compareNatural(a, b);
}

function compareNatural(a: string, b: string): number {
  const sa = a.split(/(\d+)/);
  const sb = b.split(/(\d+)/);
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const pa = sa[i] ?? "";
    const pb = sb[i] ?? "";
    if (pa === pb) continue;
    if (/^\d+$/.test(pa) && /^\d+$/.test(pb)) {
      const na = Number(pa);
      const nb = Number(pb);
      if (na !== nb) return na < nb ? -1 : 1;
    }
    return pa < pb ? -1 : 1;
  }
  return 0;
}

function compareDottedVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const delta = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Merge freshly observed catalog entries over the in-process catalog. */
export function updateModelCatalog(catalog: AgyModelCatalog): void {
  modelCatalog = { ...modelCatalog, ...catalog };
}

export function getModelCatalog(): AgyModelCatalog {
  return { ...modelCatalog };
}

/** Test helper — drop in-process catalog state. */
export function resetModelCatalog(): void {
  modelCatalog = {};
}

/** Resolve explicit model or legacy tier to the internal alias. */
export function resolveAgyModelAlias(
  model?: AgyModel,
  tier?: AgyOptions["tier"],
): AgyModel | undefined {
  return model ?? (tier ? TIER_MAP[tier] : undefined);
}

/** Resolve a model alias to a concrete agy model id, preferring the live catalog. */
export function resolveAgyModelId(model?: AgyModel, tier?: AgyOptions["tier"]): string {
  const alias = resolveAgyModelAlias(model, tier) ?? "flash-medium";
  return modelCatalog[alias] ?? MODEL_MAP[alias];
}

const TRANSIENT_FAILURE_PATTERN =
  /rate.?limit|429|overloaded|temporarily unavailable|network|connection (reset|refused)|econnreset|etimedout|socket hang up|\b50[023]\b/i;

/** Heuristic for transient agy failures that are safe to retry once. */
export function isTransientAgyFailure(message: string): boolean {
  return TRANSIENT_FAILURE_PATTERN.test(message);
}

export function buildAgyArgs(options: AgyOptions): string[] {
  if (options.continue && options.conversation_id) {
    throw new Error("agy cannot use --continue and --conversation together");
  }

  const model = resolveAgyModelId(options.model, options.tier);
  const timeoutSec = Math.ceil(options.timeout_ms / 1000);
  const mode = options.mode ?? "accept-edits";
  const writes = mode === "accept-edits";
  const skipPermissions = options.skipPermissions ?? true;
  const useStream = options.stream ?? true;
  const structured = mode !== "accept-edits" || useStream;

  const args = [
    "--model",
    model,
    "--print-timeout",
    `${timeoutSec}s`,
    "--add-dir",
    options.dir,
    // Task text must never be interpreted as agy slash commands or skills.
    "--disable-slash-commands",
    ...(mode === "sandbox" ? ["--sandbox"] : ["--mode", mode]),
    ...(writes && skipPermissions ? ["--dangerously-skip-permissions"] : []),
    ...(options.effort ? ["--effort", options.effort] : []),
  ];

  if (options.continue) {
    args.push("--continue");
  } else if (options.conversation_id) {
    args.push("--conversation", options.conversation_id);
  }

  if (structured) {
    args.push("--output-format", useStream ? "stream-json" : "json");
  }

  args.push("-p", options.prompt);
  return args;
}

export function buildAgyPrompt(
  prompt: string,
  mode: "plan" | "accept-edits" | "sandbox",
  useDigest: boolean,
  verifyCmd: string | null,
): string {
  const lines: string[] = [];
  if (mode === "plan") lines.push("Explore and produce an implementation plan only; do not edit.");
  else if (mode === "sandbox") lines.push("Work inside the sandbox; changes are isolated for preview.");
  else if (verifyCmd) lines.push(`After editing, run \`${verifyCmd}\` and fix failures until it passes.`);
  if (useDigest) lines.push("Use compact digests, not full file contents.");
  lines.push(prompt);
  return lines.join("\n");
}

function getSpawn() {
  return _require("node:child_process").spawn;
}

function appendBounded(chunks: Buffer[], total: number, data: Buffer): number {
  const remaining = MAX_CAPTURE_BYTES - total;
  if (remaining > 0) chunks.push(data.subarray(0, remaining));
  return Math.min(MAX_CAPTURE_BYTES, total + data.length);
}

export async function checkAgyHealth(
  cwd: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<void> {
  await runPreflightCommand(["--version"], cwd, signal, "agy health check", false, timeoutMs);
}

export async function checkAgyConnectivity(
  cwd: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<void> {
  const output = await runPreflightCommand(
    ["models"],
    cwd,
    signal,
    "agy connectivity check",
    true,
    timeoutMs,
  );
  const catalog = parseModelCatalog(output);
  if (Object.keys(catalog).length > 0) updateModelCatalog(catalog);
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

async function runPreflightCommand(
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
          const authHint =
            args[0] === "--version"
              ? "Antigravity CLI is not authenticated or not working"
              : "agy connectivity check failed";
          reject(new Error(`${authHint} (${status}). ${msg || "Run 'agy' interactively to authenticate."}`));
        }
      });
    });
  });

  const stdoutText = capture ? Buffer.concat(stdout).toString("utf8") : "";
  // Stdout only: stderr diagnostics must never leak into catalog parsing.
  return stdoutText;
}

export function getAgyConversationId(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const conversationId = (error as { conversation_id?: unknown }).conversation_id;
  return typeof conversationId === "string" ? conversationId : undefined;
}

export function spawnAgy(options: AgyOptions, signal: AbortSignal): Promise<string> {
  return spawnAgyInternal(options, signal).then((result) => result.response);
}

/** Real agy work (tool steps / model responses), as opposed to lifecycle chatter. */
function isActivityProgress(parsed: AgyStreamLine): boolean {
  const step = parsed.step_update;
  return step?.step_type === "tool" || step?.step_type === "agent_response";
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
    let lineBuffer = "";
    let runResult: AgyRunResult = { response: "" };

    child.stdout.on("data", (d: Buffer) => {
      stdoutBytes = appendBounded(stdout, stdoutBytes, d);
      const chunk = appendStreamChunk(lineBuffer, d.toString("utf8"), onProgress);
      lineBuffer = chunk.lineBuffer;
      for (const line of chunk.lines) {
        runResult = processStreamLine(line, runResult, onProgress);
      }
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

        // JSONL producers normally terminate every record with a newline, but
        // process failures can leave the final record unterminated. Parse it
        // before handling the exit code so retry logic sees real activity and
        // users still receive the terminal progress update. The remainder is
        // bounded by appendStreamChunk, so no length check is needed here.
        if (lineBuffer.trim()) {
          runResult = processStreamLine(lineBuffer, runResult, onProgress);
        }

        if (sig === "SIGTERM" || sig === "SIGKILL" || code === null) {
          reject(
            withConversationId(
              signal.aborted && !timedOut ? "agy was cancelled" : "agy timed out",
              runResult,
            ),
          );
          return;
        }

        if (code !== 0) {
          const detail = (err || out).slice(0, 2000).trim();
          reject(withConversationId(`agy exited with code ${code}:\n${detail || "(no output)"}`, runResult));
          return;
        }

        // agy writes diagnostics to stderr even on successful runs. Keep it
        // out of the response so JSON/stream parsing remains deterministic.
        resolve(finalizeRunResult(out, runResult));
      });
    });
  });
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

// Re-export for tests that imported detectVerifyCommand from cli in upstream.
export async function detectVerifyCommandFromPackageJson(cwd: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    if (pkg?.scripts?.test) return "npm test";
  } catch {
    // ignore
  }
  return null;
}
