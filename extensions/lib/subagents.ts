import { stripTerminalSequences } from "@earendil-works/pi-tui";

export type AgyObservedSubagentStatus = "active" | "done" | "error";

export interface AgyObservedSubagent {
  /** Correlation data from the agy stream; not an internal lifecycle handle. */
  step_index?: number;
  slot: number;
  name: string;
  type?: string;
  task?: string;
  status: AgyObservedSubagentStatus;
  duration_seconds?: number;
  error?: string;
}

export interface AgySubagentStep {
  step_index?: number;
  state?: string;
  step_type?: string;
  tool_name?: string;
  duration_seconds?: number;
  subagent_info?: { subagents?: unknown };
  tool_info?: {
    name?: string;
    parameters?: Record<string, unknown>;
    error?: { message?: unknown };
  };
  error?: { message?: unknown };
}

export const MAX_OBSERVED_SUBAGENTS = 32;
const MAX_REPORTED_SUBAGENTS = 12;

const SPAWN_TOOLS = new Set([
  "invoke_subagent",
  "run_subagent",
  "define_subagent",
  "browser_subagent",
]);
const NON_SPAWN_SUBAGENT_TOOLS = new Set(["send_message", "manage_subagents"]);

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = stripTerminalSequences(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function pick(record: Record<string, unknown>, keys: string[], max: number): string | undefined {
  for (const key of keys) {
    const value = clean(record[key], max);
    if (value) return value;
  }
  return undefined;
}

interface Candidate {
  slot: number;
  name: string;
  type?: string;
  task?: string;
}

function candidatesFromArray(raw: unknown[]): Candidate[] {
  return raw.slice(0, MAX_OBSERVED_SUBAGENTS).flatMap((value, slot) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const type = pick(record, ["type_name", "type", "Type"], 40);
    const name = pick(record, ["role", "name", "Name"], 80) ?? type ?? "subagent";
    const task = pick(record, ["initial_prompt", "task", "Task", "prompt", "Prompt"], 120);
    return [{ slot, name, type, task }];
  });
}

function candidates(step: AgySubagentStep): Candidate[] {
  const tool = clean(step.tool_name ?? step.tool_info?.name, 40);
  const raw = step.subagent_info?.subagents;
  if (Array.isArray(raw)) return candidatesFromArray(raw);

  if (!tool || !SPAWN_TOOLS.has(tool)) return [];
  const parameters = step.tool_info?.parameters ?? {};
  const nested = parameters.Subagents ?? parameters.subagents;
  if (Array.isArray(nested)) return candidatesFromArray(nested);
  const type = pick(parameters, ["Type", "type"], 40);
  return [{
    slot: 0,
    name:
      pick(parameters, ["Name", "name", "Role", "role", "Agent", "agent"], 80) ??
      type ??
      tool,
    type,
    task: pick(
      parameters,
      ["Task", "task", "Prompt", "prompt", "Instruction", "instruction", "Goal", "goal"],
      120,
    ),
  }];
}

function isSpawnStep(step: AgySubagentStep, tool: string | undefined): boolean {
  if (tool && NON_SPAWN_SUBAGENT_TOOLS.has(tool)) return false;
  return step.step_type === "subagent" || Boolean(tool && SPAWN_TOOLS.has(tool));
}

function statusFor(state: string | undefined): AgyObservedSubagentStatus | undefined {
  if (state === "ACTIVE") return "active";
  if (state === "DONE") return "done";
  if (state === "ERROR") return "error";
  return undefined;
}

function sameEntry(
  entry: AgyObservedSubagent,
  step: AgySubagentStep,
  candidate: Candidate,
): boolean {
  if (typeof step.step_index === "number") {
    return entry.step_index === step.step_index && entry.slot === candidate.slot;
  }
  return entry.step_index === undefined && entry.slot === candidate.slot && entry.name === candidate.name;
}

/**
 * Fold one agy stream step into a bounded observation list. This records what
 * the stream reported; it never claims the subagent is still live or exposes a
 * controllable lifecycle handle.
 */
export function observeAgySubagents(
  current: AgyObservedSubagent[] | undefined,
  step: AgySubagentStep,
): AgyObservedSubagent[] | undefined {
  const tool = clean(step.tool_name ?? step.tool_info?.name, 40);
  if (!isSpawnStep(step, tool)) return current;

  const status = statusFor(step.state);
  if (!status) return current;
  const next = (current ?? []).map((entry) => ({ ...entry }));
  const found = candidates(step);
  const duration =
    typeof step.duration_seconds === "number" &&
    Number.isFinite(step.duration_seconds) &&
    step.duration_seconds >= 0
      ? step.duration_seconds
      : undefined;
  const error =
    status === "error"
      ? clean(step.error?.message ?? step.tool_info?.error?.message, 120) ?? "subagent step error"
      : undefined;

  // Completion records can omit their original payload. Update every entry
  // correlated to the step rather than inventing a nameless replacement.
  if (found.length === 0 && typeof step.step_index === "number") {
    for (const entry of next) {
      if (entry.step_index !== step.step_index) continue;
      entry.status = status;
      if (duration !== undefined) entry.duration_seconds = duration;
      if (error) entry.error = error;
    }
    return next.length ? next : undefined;
  }

  for (const candidate of found) {
    const existing = next.find((entry) => sameEntry(entry, step, candidate));
    if (existing) {
      existing.name = candidate.name;
      existing.type = candidate.type ?? existing.type;
      existing.task = candidate.task ?? existing.task;
      existing.status = status;
      if (duration !== undefined) existing.duration_seconds = duration;
      if (error) existing.error = error;
      continue;
    }
    if (next.length >= MAX_OBSERVED_SUBAGENTS) break;
    next.push({
      ...(typeof step.step_index === "number" ? { step_index: step.step_index } : {}),
      slot: candidate.slot,
      name: candidate.name,
      type: candidate.type,
      task: candidate.task,
      status,
      duration_seconds: duration,
      error,
    });
  }
  return next.length ? next : undefined;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
}

/** Bounded final report suitable for tool content and native rendering. */
export function formatAgySubagentObservations(
  entries: readonly AgyObservedSubagent[] | undefined,
): string | undefined {
  if (!entries?.length) return undefined;
  const lines = [`agy subagents observed: ${entries.length}`];
  for (const entry of entries.slice(0, MAX_REPORTED_SUBAGENTS)) {
    const status = entry.status === "active" ? "active at last event" : entry.status;
    const parts = [
      `- ${clean(entry.name, 80) ?? "subagent"}`,
      status,
      typeof entry.duration_seconds === "number"
        ? formatDuration(entry.duration_seconds)
        : undefined,
      entry.type ? `type ${clean(entry.type, 40)}` : undefined,
      entry.task ? `“${clean(entry.task, 120)}”` : undefined,
      entry.error ? clean(entry.error, 120) : undefined,
    ].filter((part): part is string => Boolean(part));
    lines.push(parts.join(" · "));
  }
  if (entries.length > MAX_REPORTED_SUBAGENTS) {
    lines.push(`- … ${entries.length - MAX_REPORTED_SUBAGENTS} more in structured details`);
  }
  return lines.join("\n");
}

/** Compact progress text for a native subagent stream step. */
export function formatAgySubagentProgress(step: AgySubagentStep): string | undefined {
  const tool = clean(step.tool_name ?? step.tool_info?.name, 40);
  if (!isSpawnStep(step, tool)) return undefined;
  const found = candidates(step);
  if (found.length === 0) return undefined;
  const first = found[0];
  const extra = found.length > 1 ? ` +${found.length - 1}` : "";
  const task = first.task ? ` — ${first.task}` : "";
  if (step.state === "ACTIVE") return `▸ subagent ${first.name}${extra}${task}`;
  if (step.state === "DONE") return `✓ subagent ${first.name}${extra} completed`;
  if (step.state === "ERROR") return `✗ subagent ${first.name}${extra} errored`;
  return undefined;
}
