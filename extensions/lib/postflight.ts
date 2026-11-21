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

/**
 * Git flags that keep these probes from executing repository configuration.
 *
 * `git status` runs the configured `core.fsmonitor` program, and `git diff`
 * honours `diff.external`/textconv drivers, so a probe whose only job is to
 * describe the tree could execute whatever a config file names. These
 * invocations run in a directory the caller (sometimes the model) chose, and
 * the dirt line is read before the user confirms anything — so they must not
 * be a way to run code. Verified against git 2.x: the fsmonitor hook fires on
 * `status --porcelain` and does not fire with `-c core.fsmonitor=false`.
 */
const SAFE_GIT_CONFIG = ["-c", "core.fsmonitor=false"];

/**
 * `git status` collapses a wholly-untracked directory to one `dir/` entry, so a
 * file created inside a directory that was already untracked leaves the status
 * output byte-identical — and the change attribution silently credits agy with
 * nothing. `--untracked-files=all` lists the files, which is what the summary
 * and the baseline comparison both need.
 */
const STATUS_ARGS = [...SAFE_GIT_CONFIG, "status", "--porcelain", "--untracked-files=all"];
const SAFE_DIFF_FLAGS = ["--no-ext-diff", "--no-textconv"];

/** Capture dirty state before accept-edits so the summary can attribute only new changes to agy. */
export async function captureGitBaseline(cwd: string, signal?: AbortSignal): Promise<GitBaseline> {
  try {
    const { stdout } = await execFileAsync("git", STATUS_ARGS, {
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

/** Paths git reports as changed, read directly rather than scraped from text. */
interface ChangedPaths {
  tracked: string[];
  untracked: string[];
}

async function readChangedPaths(cwd: string, signal?: AbortSignal): Promise<ChangedPaths> {
  const opts = { cwd, maxBuffer: 64 * 1024, signal, timeout: 10_000 };
  const [workingNames, stagedNames, status] = await Promise.all([
    execFileAsync("git", [...SAFE_GIT_CONFIG, "diff", ...SAFE_DIFF_FLAGS, "--name-only"], opts),
    execFileAsync(
      "git",
      [...SAFE_GIT_CONFIG, "diff", ...SAFE_DIFF_FLAGS, "--cached", "--name-only"],
      opts,
    ),
    execFileAsync("git", STATUS_ARGS, opts),
  ]);
  return {
    tracked: uniqueLines(`${workingNames.stdout}\n${stagedNames.stdout}`),
    untracked: status.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("??"))
      .map((line) => line.slice(2).trim())
      .filter(Boolean),
  };
}

/**
 * Summarize workspace changes after accept-edits. Returns null when clean or not a git repo.
 * Covers staged and unstaged tracked modifications plus untracked files.
 *
 * This is display text and is truncated for that purpose. Callers that need to
 * know *which* files changed must use `readChangedPaths` through
 * `summarizeGitDiffSince` — parsing this string loses paths past the cut and
 * can return half a path where it stops.
 */
export async function summarizeGitDiff(cwd: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const opts = { cwd, maxBuffer: 64 * 1024, signal, timeout: 10_000 };
    const [paths, workingStat, stagedStat] = await Promise.all([
      readChangedPaths(cwd, signal),
      execFileAsync("git", [...SAFE_GIT_CONFIG, "diff", ...SAFE_DIFF_FLAGS, "--stat"], opts),
      execFileAsync("git", [...SAFE_GIT_CONFIG, "diff", ...SAFE_DIFF_FLAGS, "--cached", "--stat"], opts),
    ]);
    const unstagedStat = workingStat.stdout.trim();
    const cachedStat = stagedStat.stdout.trim();
    const { tracked: names, untracked } = paths;
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
 *
 * The structured lists come from git, never from the display text: the receipt
 * quotes both the paths and their count, so a path past the display cut (or a
 * half path at it) would be a wrong statement about what the run did.
 */
export async function summarizeGitDiffSince(
  baseline: GitBaseline,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ summary: string | null; newFiles: string[]; preexistingFiles: string[] }> {
  const full = await summarizeGitDiff(cwd, signal);
  if (!full) return { summary: null, newFiles: [], preexistingFiles: [] };
  let paths: ChangedPaths;
  try {
    paths = await readChangedPaths(cwd, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      summary: `${full}\n\n(could not list changed paths; attribution unavailable)`,
      newFiles: [],
      preexistingFiles: [],
    };
  }
  const current = [...new Set([...paths.tracked, ...paths.untracked])];
  if (baseline.unavailable || baseline.dirtyFiles.size === 0) {
    return { summary: full, newFiles: current.sort(), preexistingFiles: [] };
  }
  const newFiles = current.filter((file) => !baseline.dirtyFiles.has(file)).sort();
  const preexistingFiles = current.filter((file) => baseline.dirtyFiles.has(file)).sort();
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
}

function uniqueLines(value: string): string[] {
  return [...new Set(value.split("\n").map((line) => line.trim()).filter(Boolean))];
}

