export type AgyContextMode = "none" | "summary" | "recent";

export const SUMMARY_CONTEXT_MAX_CHARS = 12_000;
export const RECENT_CONTEXT_MAX_CHARS = 40_000;

interface ContextItem {
  role: "user" | "assistant" | "summary";
  text: string;
}

/**
 * Build an explicit, bounded handoff from Pi's active context.
 *
 * Deliberately excluded: system messages, thinking, tool arguments, tool
 * results, images, and extension custom messages. The current agy task is
 * appended separately and remains authoritative.
 */
export function buildAgyContext(
  messages: readonly unknown[],
  mode: AgyContextMode,
): string | undefined {
  if (mode === "none") return undefined;

  const items = messages.flatMap(contextItemsFromMessage);
  if (items.length === 0) return undefined;

  const selected = mode === "summary" ? summaryItems(items) : items;
  const rendered = selected.map(renderContextItem).join("\n\n");
  const limit = mode === "summary" ? SUMMARY_CONTEXT_MAX_CHARS : RECENT_CONTEXT_MAX_CHARS;
  return tailBound(rendered, limit);
}

/** Convert active session entries into the same privacy-filtered handoff. */
export function buildAgyContextFromEntries(
  entries: readonly unknown[],
  mode: AgyContextMode,
): string | undefined {
  const messages = entries.flatMap((entry): unknown[] => {
    if (!isRecord(entry) || typeof entry.type !== "string") return [];
    if (entry.type === "message") return [entry.message];
    // buildContextEntries emits the compaction summary first and retained
    // conversational entries separately as ordinary message entries.
    if (entry.type === "compaction" && typeof entry.summary === "string") {
      return [{ role: "compactionSummary", summary: entry.summary }];
    }
    if (entry.type === "branch_summary" && typeof entry.summary === "string") {
      return [{ role: "branchSummary", summary: entry.summary }];
    }
    return [];
  });
  return buildAgyContext(messages, mode);
}

function contextItemsFromMessage(value: unknown): ContextItem[] {
  if (!isRecord(value) || typeof value.role !== "string") return [];

  if (value.role === "compactionSummary" || value.role === "branchSummary") {
    return typeof value.summary === "string" && value.summary.trim()
      ? [{ role: "summary", text: value.summary.trim() }]
      : [];
  }

  if (value.role !== "user" && value.role !== "assistant") return [];
  const text = textOnlyContent(value.content);
  return text ? [{ role: value.role, text }] : [];
}

/** Extract visible text only; never serialize thinking, tool calls, or images. */
function textOnlyContent(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(
      (part): part is { type: "text"; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

/** Keep durable summaries plus the latest four conversational messages. */
function summaryItems(items: ContextItem[]): ContextItem[] {
  const summaries = items.filter((item) => item.role === "summary").slice(-2);
  const conversation = items.filter((item) => item.role !== "summary").slice(-4);
  return [...summaries, ...conversation];
}

function renderContextItem(item: ContextItem): string {
  const label = item.role === "summary" ? "PI SUMMARY" : item.role.toUpperCase();
  return `${label}:\n${item.text}`;
}

function tailBound(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = "[Earlier Pi context omitted]\n";
  return marker + value.slice(-(limit - marker.length));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
