import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_DIFF_CHARS = 2000;

export interface GitBaseline {
  /** Porcelain paths that were already dirty before agy ran. */
  dirtyFiles: Set<string>;
  /** True when the baseline could not be captured (not a repo, git missing). */
  unavailable: boolean;
}

/** Parse `git status --porcelain` v1 output into the set of dirty paths. */
export function parsePorcelainStatus(stdout: string): Set<string> {
  const dirtyFiles = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    // Porcelain v1: `XY <path>` — two fixed status columns, one space, path.
    // Never trim before slicing: unstaged statuses (` M`) carry meaning in
    // the leading space, and trim-then-slice(3) eats the path's first char.
    const status = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (!file) continue;
    // Rename/copy entries print `ORIG -> NEW` while `diff --name-only`
    // reports only NEW, so record both sides — otherwise a pre-existing
    // rename looks newly-dirty after the run and is misattributed to agy.
    // Split at the LAST arrow (paths may contain " -> ") and keep git's
    // C-quoting verbatim so entries match `diff --name-only` output.
    const isRenameOrCopy = status.includes("R") || status.includes("C");
    const arrow = isRenameOrCopy ? file.lastIndexOf(" -> ") : -1;
    if (arrow !== -1) {
      const orig = file.slice(0, arrow).trim();
      const renamed = file.slice(arrow + " -> ".length).trim();
      if (orig) dirtyFiles.add(orig);
      if (renamed) dirtyFiles.add(renamed);
    } else {
      dirtyFiles.add(file);
    }
  }
  return dirtyFiles;
}

/** Capture dirty state before accept-edits so the summary can attribute only new changes to agy. */
export async function captureGitBaseline(cwd: string, signal?: AbortSignal): Promise<GitBaseline> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd,
      maxBuffer: 64 * 1024,
      signal,
      timeout: 10_000,
    });
    return { dirtyFiles: parsePorcelainStatus(stdout), unavailable: false };
  } catch {
    if (signal?.aborted) throw new Error("agy was cancelled");
    return { dirtyFiles: new Set(), unavailable: true };
  }
}

/** One-line pre-run dirty count for confirmation dialogs. Best effort; null when unknown. */
export async function describePreRunDirt(
  cwd: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const baseline = await captureGitBaseline(cwd, signal);
    if (baseline.unavailable) return null;
    if (baseline.dirtyFiles.size === 0) return "clean";
    return `${baseline.dirtyFiles.size} already-dirty file(s)`;
  } catch {
    return null;
  }
}

/**
 * Summarize workspace changes after accept-edits. Returns null when clean or not a git repo.
 * Covers staged and unstaged tracked modifications plus untracked files.
 */
export async function summarizeGitDiff(cwd: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const opts = { cwd, maxBuffer: 64 * 1024, signal, timeout: 10_000 };
    const [workingStat, stagedStat, workingNames, stagedNames, status] = await Promise.all([
      execFileAsync("git", ["diff", "--stat"], opts),
      execFileAsync("git", ["diff", "--cached", "--stat"], opts),
      execFileAsync("git", ["diff", "--name-only"], opts),
      execFileAsync("git", ["diff", "--cached", "--name-only"], opts),
      execFileAsync("git", ["status", "--short"], opts),
    ]);
    const unstagedStat = workingStat.stdout.trim();
    const cachedStat = stagedStat.stdout.trim();
    const names = uniqueLines(`${workingNames.stdout}\n${stagedNames.stdout}`);
    const untracked = status.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("??"))
      .map((line) => line.slice(2).trim());
    if (!unstagedStat && !cachedStat && names.length === 0 && untracked.length === 0) return null;

    const sections: string[] = [];
    if (unstagedStat) sections.push("## git diff --stat\n" + unstagedStat);
    if (cachedStat) sections.push("## git diff --cached --stat\n" + cachedStat);
    if (sections.length === 0) sections.push("## git diff --stat\n(no tracked diff)");

    let summary = sections.join("\n\n");
    if (names.length > 0) summary += "\n\n## changed files\n" + names.join("\n");
    if (untracked.length > 0) summary += "\n\n## untracked files\n" + untracked.join("\n");
    if (summary.length > MAX_DIFF_CHARS) {
      summary = summary.slice(0, MAX_DIFF_CHARS) + "\n\n(diff summary truncated)";
    }
    return summary;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/**
 * Filter a post-run summary to files agy newly touched. Files already dirty
 * in the baseline are listed separately so pre-existing work is never
 * misattributed to the delegation.
 */
export async function summarizeGitDiffSince(
  baseline: GitBaseline,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ summary: string | null; newFiles: string[]; preexistingFiles: string[] }> {
  const full = await summarizeGitDiff(cwd, signal);
  if (!full) return { summary: null, newFiles: [], preexistingFiles: [] };
  if (baseline.unavailable || baseline.dirtyFiles.size === 0) {
    return { summary: full, newFiles: listChangedFiles(full), preexistingFiles: [] };
  }
  try {
    const opts = { cwd, maxBuffer: 64 * 1024, signal, timeout: 10_000 };
    const [workingNames, stagedNames, status] = await Promise.all([
      execFileAsync("git", ["diff", "--name-only"], opts),
      execFileAsync("git", ["diff", "--cached", "--name-only"], opts),
      execFileAsync("git", ["status", "--porcelain"], opts),
    ]);
    const current = new Set<string>();
    for (const name of uniqueLines(`${workingNames.stdout}\n${stagedNames.stdout}`)) {
      current.add(name);
    }
    for (const line of status.stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("??")) {
        const file = trimmed.slice(2).trim();
        if (file) current.add(file);
      }
    }
    const newFiles = [...current].filter((f) => !baseline.dirtyFiles.has(f)).sort();
    const preexistingFiles = [...current].filter((f) => baseline.dirtyFiles.has(f)).sort();
    if (newFiles.length === 0) {
      const note =
        preexistingFiles.length > 0
          ? `agy made no newly-dirty files; ${preexistingFiles.length} pre-existing dirty file(s) unchanged in attribution:\n` +
            preexistingFiles.join("\n")
          : "agy made no newly-dirty files.";
      return { summary: note, newFiles, preexistingFiles };
    }
    let summary = full;
    if (preexistingFiles.length > 0) {
      summary +=
        `\n\n## pre-existing dirty files (not attributed to agy)\n` + preexistingFiles.join("\n");
    }
    return { summary, newFiles, preexistingFiles };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { summary: full, newFiles: listChangedFiles(full), preexistingFiles: [] };
  }
}

function uniqueLines(value: string): string[] {
  return [...new Set(value.split("\n").map((line) => line.trim()).filter(Boolean))];
}

function listChangedFiles(summary: string): string[] {
  const files: string[] = [];
  let inList = false;
  for (const line of summary.split("\n")) {
    if (line.startsWith("## changed files") || line.startsWith("## untracked files")) {
      inList = true;
      continue;
    }
    if (line.startsWith("## ")) {
      inList = false;
      continue;
    }
    if (inList && line.trim()) files.push(line.trim());
  }
  return files;
}
