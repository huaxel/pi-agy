export interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export interface AgyStepUpdate {
  conversation_id?: string;
  step_index?: number;
  state?: string;
  step_type?: string;
  tool_name?: string;
  text_delta?: string;
  duration_seconds?: number;
  usage?: AgyUsage;
  tool_info?: {
    name?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface AgyStreamLine {
  event?: string;
  conversation_id?: string;
  init?: { model?: string; cwd?: string };
  step_update?: AgyStepUpdate;
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    duration_seconds?: number;
    usage?: AgyUsage;
  };
}

export interface AgyRunResult {
  response: string;
  /** Internal marker distinguishing a valid empty response from no response. */
  response_complete?: boolean;
  conversation_id?: string;
  usage?: AgyUsage;
  duration_seconds?: number;
}

export type AgyProgressHandler = (
  message: string,
  /** "activity" = real agy work (tool step or response text); "status" = lifecycle chatter. */
  kind?: "status" | "activity",
) => void;

export function parseStreamLine(line: string): AgyStreamLine | null {
  const trimmed = line.trim().replace(/^\uFEFF/, "");
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as AgyStreamLine)
      : null;
  } catch {
    return null;
  }
}

export function formatStepProgress(parsed: AgyStreamLine): string | null {
  if (parsed.event === "init") {
    const model = parsed.init?.model ?? "agy";
    return `agy: session started (${model})`;
  }

  // Result events do not contain step_update, so handle them before the
  // step guard below. This also gives users a visible terminal status.
  if (parsed.event === "result" && parsed.result?.status) {
    const secs = parsed.result.duration_seconds;
    const dur = typeof secs === "number" ? ` in ${secs.toFixed(1)}s` : "";
    return `agy: ${parsed.result.status}${dur}`;
  }

  const step = parsed.step_update;
  if (!step) return null;

  if (step.step_type === "tool" && step.state === "ACTIVE") {
    const name = step.tool_name ?? step.tool_info?.name ?? "tool";
    const target = step.tool_info?.parameters?.TargetFile;
    return target ? `▸ ${name} → ${String(target)}` : `▸ ${name}`;
  }

  if (step.step_type === "agent_response" && step.text_delta) {
    return "agy: generating response…";
  }

  return null;
}

export const MAX_RESPONSE_CHARS = 1_000_000;
// One JSONL record is bounded at the largest legitimate result event:
// MAX_RESPONSE_CHARS with worst-case JSON escaping (\uXXXX = 6 bytes per
// char) plus envelope headroom. A record that grows past this is either
// malfunctioning or hostile, so it is discarded with a warning — the bound
// applies equally to terminated records and to an unterminated buffer,
// because a legitimate large result is itself unterminated while it streams.
export const MAX_STREAM_LINE_BYTES = 8 * 1024 * 1024;

export interface StreamChunk {
  /** Complete newline-terminated records ready to parse. */
  lines: string[];
  /** Unterminated remainder to prepend to the next chunk. */
  lineBuffer: string;
}

/**
 * Accumulate stdout text into newline-delimited records. An unterminated
 * remainder past the bound is discarded with a warning, as are oversized
 * complete records — neighbors are still delivered.
 */
export function appendStreamChunk(
  lineBuffer: string,
  chunk: string,
  onProgress?: AgyProgressHandler,
): StreamChunk {
  const warn = () =>
    onProgress?.("agy: warning — discarded oversized stream record", "status");
  const combined = lineBuffer + chunk;
  if (!combined.includes("\n")) {
    if (Buffer.byteLength(combined, "utf8") > MAX_STREAM_LINE_BYTES) {
      warn();
      return { lines: [], lineBuffer: "" };
    }
    return { lines: [], lineBuffer: combined };
  }
  const parts = combined.split("\n");
  let remainder = parts.pop() ?? "";
  if (Buffer.byteLength(remainder, "utf8") > MAX_STREAM_LINE_BYTES) {
    warn();
    remainder = "";
  }
  const lines: string[] = [];
  for (const line of parts) {
    if (Buffer.byteLength(line, "utf8") > MAX_STREAM_LINE_BYTES) {
      warn();
      continue;
    }
    lines.push(line);
  }
  return { lines, lineBuffer: remainder };
}

export function accumulateRunResult(parsed: AgyStreamLine, current: AgyRunResult): AgyRunResult {
  const next = { ...current };

  if (typeof parsed.conversation_id === "string") next.conversation_id = parsed.conversation_id;

  const step = parsed.step_update;
  if (typeof step?.conversation_id === "string") next.conversation_id = step.conversation_id;

  if (parsed.result) {
    if (typeof parsed.result.conversation_id === "string") {
      next.conversation_id = parsed.result.conversation_id;
    }
    if (typeof parsed.result.response === "string") {
      next.response =
        parsed.result.response.length > MAX_RESPONSE_CHARS
          ? parsed.result.response.slice(0, MAX_RESPONSE_CHARS) + "\n\n(response truncated)"
          : parsed.result.response;
      next.response_complete = true;
    }
    if (typeof parsed.result.usage === "object" && parsed.result.usage !== null) {
      next.usage = parsed.result.usage;
    }
    if (
      typeof parsed.result.duration_seconds === "number" &&
      Number.isFinite(parsed.result.duration_seconds)
    ) {
      next.duration_seconds = parsed.result.duration_seconds;
    }
  }

  return next;
}

export function finalizeRunResult(rawStdout: string, current: AgyRunResult): AgyRunResult {
  if (current.response_complete || current.response) return current;

  // Fall back to plain json envelope or raw text when stream-json had no result event.
  for (const line of rawStdout.split("\n")) {
    const parsed = parseStreamLine(line);
    if (typeof parsed?.result?.response === "string") {
      return accumulateRunResult(parsed, { ...current, response: parsed.result.response });
    }
  }

  try {
    const parsed: unknown = JSON.parse(rawStdout);
    const next = mergeJsonEnvelope(parsed, current);
    if (next) return next;
  } catch {
    // not json
  }

  return { ...current, response: rawStdout.trim() || "(empty response)" };
}

/** Preserve metadata from agy's non-stream JSON envelope when available. */
function mergeJsonEnvelope(parsed: unknown, current: AgyRunResult): AgyRunResult | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  let next = { ...current };
  let found = false;

  if (typeof record.conversation_id === "string") {
    next.conversation_id = record.conversation_id;
    found = true;
  }
  if (typeof record.response === "string") {
    next.response = record.response;
    next.response_complete = true;
    found = true;
  }
  if (typeof record.duration_seconds === "number") {
    next.duration_seconds = record.duration_seconds;
    found = true;
  }
  if (typeof record.usage === "object" && record.usage !== null) {
    next.usage = record.usage as AgyUsage;
    found = true;
  }

  return found ? next : null;
}
