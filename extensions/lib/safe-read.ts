/**
 * Bounded, type-checked file reads for host-process paths.
 *
 * Two classes of file are read outside any approval step: git/project markers
 * that decide whether a verify loop gets injected (`justfile`, `package.json`,
 * `pyproject.toml`), and skill files that a project checkout controls and that
 * the bridge then lists and returns to agy. Reading either with a plain
 * `readFile` is a denial-of-service primitive in someone else's checkout — a
 * marker symlinked to `/dev/zero` never reaches EOF, and a multi-gigabyte
 * `SKILL.md` is read to completion before anything inspects it.
 *
 * Both readers here open the path, judge the *opened handle* rather than the
 * path, and read at most `maxBytes`:
 *
 * - `stat()` on the handle resolves symlinks but cannot be swapped afterwards,
 *   so a symlink is followed only if it lands on a regular, small-enough file.
 * - The open itself is non-blocking (`O_NONBLOCK`): opening a FIFO for reading
 *   waits for a writer, so a plain `open` hangs before `stat` can reject it —
 *   the exact DoS this module exists to prevent. With the flag the open returns
 *   immediately, `fstat` reports a FIFO, and nothing is read. The flag is inert
 *   for regular files, and no read is issued for a rejected handle.
 * - Character devices, FIFOs and sockets are rejected before any read, so there
 *   is nothing to block on.
 * - Anything larger than the cap is rejected instead of truncated: a truncated
 *   `package.json` parses as nothing, and a truncated skill body would be
 *   served to the model as if it were complete.
 *
 * Callers get `null` for every failure — absent, unreadable, wrong type, too
 * large, cancelled — because all of these mean the same thing to a caller:
 * this candidate is not usable, and it must not be fatal.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

/** Cap for project markers that decide a verify loop (`justfile`, `package.json`). */
export const MAX_MARKER_BYTES = 1024 * 1024;

/** Cap for a skill body: generous for Markdown, far below a memory hazard. */
export const MAX_SKILL_BYTES = 1024 * 1024;

export interface BoundedRead {
  /** Reject anything larger than this. */
  maxBytes: number;
}

function readHandleSync(handle: number, size: number): string | null {
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(handle, buffer, offset, size - offset, offset);
    // A short read means the file shrank under us; deliver what exists rather
    // than a buffer with uninitialized tail bytes.
    if (read <= 0) return buffer.subarray(0, offset).toString("utf8");
    offset += read;
  }
  return buffer.toString("utf8");
}

/** Read a regular file of at most `maxBytes`, or `null` for anything else. */
export function readFileBoundedSync(file: string, { maxBytes }: BoundedRead): string | null {
  let handle: number | undefined;
  try {
    handle = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(handle);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return readHandleSync(handle, stat.size);
  } catch {
    return null;
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        // Nothing useful to do; the descriptor is abandoned, not reused.
      }
    }
  }
}

async function readHandle(handle: FileHandle, size: number, signal?: AbortSignal): Promise<string | null> {
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead <= 0) return buffer.subarray(0, offset).toString("utf8");
    offset += bytesRead;
  }
  return buffer.toString("utf8");
}

/** Async form of {@link readFileBoundedSync}; honours `signal` between reads. */
export async function readFileBounded(
  file: string,
  { maxBytes }: BoundedRead,
  signal?: AbortSignal,
): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    signal?.throwIfAborted();
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return await readHandle(handle, stat.size, signal);
  } catch {
    // A cancelled read reports as unusable; the caller's own abort check
    // decides whether that is an error.
    return null;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Nothing useful to do; the descriptor is abandoned, not reused.
      }
    }
  }
}
