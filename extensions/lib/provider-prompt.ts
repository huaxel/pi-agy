import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Bounds for transcript rendering into a single turn prompt. */
const MAX_HISTORY_CHARS = 24_000;
const MAX_SYSTEM_CHARS = 8_000;
const MAX_MESSAGE_CHARS = 6_000;

/** Minimal structural transcript message (subset of Pi's Message). */
export interface ProviderTranscriptMessage {
  role: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
}

export function textOfContent(content: unknown, imagePath?: (block: object) => string | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block && typeof block === "object") {
        const record = block as Record<string, unknown>;
        if (record.type === "text" && typeof record.text === "string") {
          parts.push(record.text);
        } else if (record.type === "image") {
          const staged = imagePath?.(block);
          parts.push(
            staged ?? "[image omitted: agy provider turns are text-only]",
          );
        } else if (record.type === "toolCall") {
          parts.push(`[tool call: ${String(record.name ?? "unknown")}]`);
        } else if (record.type === "thinking" && typeof record.thinking === "string") {
          parts.push(record.thinking);
        }
      }
    }
    return parts.join("\n");
  }
  return "";
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

export interface PromptImageBlock {
  /** Identity of the transcript block (lookup key, never serialized). */
  block: object;
  data: string;
  mimeType: string;
}

export interface StagedImages {
  /** Per-turn subdir, undefined when nothing stageable. */
  dir: string | undefined;
  /** Block identity → absolute path (order-independent lookup). */
  paths: Map<object, string>;
  /** Remove this staging (idempotent, never throws). */
  cleanup: () => Promise<void>;
}

/** Cap staged images per invocation (count and per-file size). */
export const MAX_STAGED_IMAGES = 8;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

export function imageExtension(mimeType: string): string {
  return IMAGE_EXTENSIONS[mimeType.toLowerCase()] ?? "bin";
}

/** Collect image blocks in transcript order, optionally only one tool result. */
export function collectImageBlocks(
  messages: ProviderTranscriptMessage[],
  onlyToolCallId?: string,
): PromptImageBlock[] {
  const blocks: PromptImageBlock[] = [];
  for (const message of messages) {
    if (onlyToolCallId !== undefined) {
      if (message.role !== "toolResult" || message.toolCallId !== onlyToolCallId) continue;
    }
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const record = block as Record<string, unknown>;
      if (record.type !== "image") continue;
      if (typeof record.data !== "string" || typeof record.mimeType !== "string") continue;
      blocks.push({ block, data: record.data, mimeType: record.mimeType });
    }
  }
  return blocks;
}

/** Strict base64 (Node's decoder silently strips non-alphabet chars). */
const STRICT_BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeImageData(data: string): Buffer | undefined {
  if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0) return undefined;
  if (!STRICT_BASE64_RE.test(data)) return undefined;
  try {
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}

/** Process-stable staging root (0700): per-turn subdirs, one --add-dir. */
let imageStagingRoot: string | undefined;

/** Live staging dirs (teardown sweep; per-turn cleanup disposes handles). */
const liveStagingDirs = new Set<string>();

export function getLiveImageStagingCount(): number {
  return liveStagingDirs.size;
}

/** Resolve (creating once) the process staging root for agy --add-dir. */
export async function ensureImageStagingRoot(): Promise<string> {
  if (!imageStagingRoot) {
    // mkdtemp (not join+mkdir): atomic, unique, 0700 — no pre-creation or
    // symlink race between check and creation.
    imageStagingRoot = await mkdtemp(path.join(os.tmpdir(), "pi-agy-images-"));
    try {
      await chmod(imageStagingRoot, 0o700);
    } catch {
      // mkdtemp already guarantees 0700; best effort.
    }
  }
  return imageStagingRoot;
}

/**
 * Materialize image blocks as files agy's tools can open. Newest transcript
 * images win (oldest starve first) so a fresh attachment is never dropped
 * behind history. Failures degrade to omitted notes, never to turn
 * failures. Each call owns its subdir; dispose via the returned cleanup.
 */
export async function stageImages(blocks: PromptImageBlock[]): Promise<StagedImages> {
  const paths = new Map<object, string>();
  const noop = async (): Promise<void> => undefined;
  const bounded = blocks.slice(-MAX_STAGED_IMAGES);
  if (bounded.length === 0) return { dir: undefined, paths, cleanup: noop };
  let root: string;
  try {
    root = await ensureImageStagingRoot();
  } catch {
    return { dir: undefined, paths, cleanup: noop };
  }
  const dir = path.join(root, randomBytes(8).toString("hex"));
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch {
    return { dir: undefined, paths, cleanup: noop };
  }
  liveStagingDirs.add(dir);
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    liveStagingDirs.delete(dir);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
  for (let index = 0; index < bounded.length; index++) {
    const block = bounded[index];
    const bytes = decodeImageData(block.data);
    if (!bytes) continue;
    const file = path.join(dir, `image-${index}.${imageExtension(block.mimeType)}`);
    try {
      await writeFile(file, bytes, { mode: 0o600 });
      await chmod(file, 0o600);
    } catch {
      continue;
    }
    paths.set(block.block, file);
  }
  if (paths.size === 0) {
    await cleanup();
    return { dir: undefined, paths, cleanup: noop };
  }
  return { dir, paths, cleanup };
}

/** Remove every staging dir and the root (teardown, tests). */
export async function clearImageStaging(): Promise<void> {
  const dirs = [...liveStagingDirs];
  liveStagingDirs.clear();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
  if (imageStagingRoot) {
    const root = imageStagingRoot;
    imageStagingRoot = undefined;
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Render Pi transcript messages into a single agy `-p` prompt. The latest
 * user message is authoritative; earlier history is bounded reference. Pi
 * tool definitions are intentionally NOT translated — agy runs its own tool
 * loop (see the module wall note).
 */
export function renderProviderPrompt(
  messages: ProviderTranscriptMessage[],
  systemPrompt?: string,
  imagePaths?: Map<object, string>,
): string {
  const imageRef = (block: object): string | undefined => {
    const file = imagePaths?.get(block);
    return file
      ? `[attached image saved at ${file} — open it with your file tools to view it]`
      : undefined;
  };
  const lines: string[] = [];
  if (systemPrompt?.trim()) {
    lines.push("System instructions:", clip(systemPrompt.trim(), MAX_SYSTEM_CHARS), "");
  }
  const history = messages.slice(0, -1);
  const rendered: string[] = [];
  let budget = MAX_HISTORY_CHARS;
  for (let i = history.length - 1; i >= 0 && budget > 0; i--) {
    const message = history[i];
    const text = clip(textOfContent(message.content, imageRef).trim(), MAX_MESSAGE_CHARS);
    if (!text) continue;
    let label: string;
    if (message.role === "user") label = "User";
    else if (message.role === "assistant") label = "Assistant (previous turn)";
    else if (message.role === "toolResult") {
      label = `Tool result (${message.toolName ?? "tool"}${message.isError ? ", error" : ""})`;
    } else if (message.role === "system") label = "System";
    else label = message.role;
    const entry = `${label}: ${text}`;
    if (entry.length > budget) break;
    budget -= entry.length;
    rendered.unshift(entry);
  }
  if (rendered.length > 0) {
    lines.push("Conversation history (reference only; the current message is authoritative):", ...rendered, "");
  }
  const last = messages[messages.length - 1];
  const current = last ? textOfContent(last.content, imageRef).trim() : "";
  const currentLabel = last && last.role !== "user" ? `Current message (${last.role}):` : "Current message:";
  lines.push(currentLabel, current || "(empty — respond with a brief acknowledgement)");
  return lines.join("\n");
}
