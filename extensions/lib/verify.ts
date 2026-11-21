import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface PackageJson {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
}

export interface VerifyDetectionDeps {
  /** Test hook — override the `just` binary availability probe. */
  justAvailable?: () => Promise<boolean>;
  /** Cancels the upward walk; checked once per directory level. */
  signal?: AbortSignal;
}

/**
 * A detected verify loop plus where it came from.
 *
 * The command string is safe to inject, but the code it runs is defined by the
 * checkout (`just ci` is whatever `justfile` says, `npm run ci` is whatever
 * `package.json` says). An approval dialog that shows only "run commands"
 * approves source the user never saw, so detection reports the defining file
 * alongside the command.
 */
export interface VerifyCommandSource {
  /** Command injected into the agy prompt, e.g. `just ci`. */
  command: string;
  /** Defining file, relative to the workspace: `justfile`, `package.json`, `pyproject.toml`. */
  definedIn: string;
}

/** Detection result before the defining file is expressed relative to the workspace. */
interface DetectedVerify extends VerifyCommandSource {
  /** Directory the defining file was found in. */
  dir: string;
}

// Detection walks up to the repo boundary reading several marker files per
// level on every accept-edits run. Cache per starting directory with a short
// TTL: project config rarely changes mid-session, and a stale hit only
// reuses an equivalent verify loop for under a minute. Bypassed when the
// test hook overrides the `just` probe so tests never poison each other.
const VERIFY_CACHE_TTL_MS = 60_000;
const verifyCache = new Map<string, { at: number; source: VerifyCommandSource | null }>();

/** Test helper — drop cached verify-command detections. */
export function resetVerifyDetectionCache(): void {
  verifyCache.clear();
}

/**
 * Detect a local verification command for accept-edits verify-loop injection.
 * The upward walk stops at the repository boundary (a directory containing
 * `.git`) so a parent checkout or stray `$HOME` justfile cannot leak an
 * unrelated command into a nested repo or worktree.
 */
export async function detectVerifyCommand(
  cwd: string,
  deps: VerifyDetectionDeps = {},
): Promise<string | null> {
  return (await detectVerifyCommandSource(cwd, deps))?.command ?? null;
}

/**
 * The command as it belongs in the agent prompt.
 *
 * A gate discovered in an ancestor directory must say where it lives: agy runs
 * in the workspace, and the same `pnpm run ci` there resolves this directory's
 * nearest manifest instead — a different project, or no script at all.
 */
export function formatVerifyCommand(source: VerifyCommandSource): string {
  const dir = path.posix.dirname(source.definedIn);
  if (dir === "." || dir === "") return source.command;
  return `${source.command} (defined in ${source.definedIn}; run it from that directory)`;
}

/** As {@link detectVerifyCommand}, but naming the file that defines the command. */
export async function detectVerifyCommandSource(
  cwd: string,
  deps: VerifyDetectionDeps = {},
): Promise<VerifyCommandSource | null> {
  // Canonicalize before walking: a symlinked working directory must inspect the
  // physical checkout, or the ancestor walk never reaches its `.git` boundary
  // and reports no gate at all.
  const key = await realpath(cwd).catch(() => path.resolve(cwd));
  if (deps.justAvailable === undefined) {
    const hit = verifyCache.get(key);
    if (hit && Date.now() - hit.at < VERIFY_CACHE_TTL_MS) return hit.source;
  }
  const source = await detectVerifyCommandUncached(key, deps);
  if (deps.justAvailable === undefined) {
    verifyCache.set(key, { at: Date.now(), source });
  }
  return source;
}

async function detectVerifyCommandUncached(
  startDir: string,
  deps: VerifyDetectionDeps,
): Promise<VerifyCommandSource | null> {
  let current = startDir;
  while (true) {
    deps.signal?.throwIfAborted();
    const found = await detectVerifyCommandAt(current, deps);
    if (found) {
      const marker = path.join(found.dir, found.definedIn);
      return { command: found.command, definedIn: path.relative(startDir, marker) || found.definedIn };
    }

    if (await fileExists(path.join(current, ".git"))) return null;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function detectVerifyCommandAt(
  cwd: string,
  deps: VerifyDetectionDeps,
): Promise<DetectedVerify | null> {
  const justfile = await findJustCi(cwd);
  if (justfile && (await (deps.justAvailable?.() ?? justBinaryAvailable()))) {
    return { command: "just ci", definedIn: justfile, dir: cwd };
  }

  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")) as PackageJson;
    const scripts = pkg.scripts ?? {};
    const runner = await detectPackageRunner(cwd, pkg.packageManager);
    const definedIn = "package.json";
    if (typeof scripts.ci === "string" && scripts.ci.trim()) {
      return { command: runScript(runner, "ci"), definedIn, dir: cwd };
    }
    if (typeof scripts.test === "string" && scripts.test.trim()) {
      return { command: runScript(runner, "test"), definedIn, dir: cwd };
    }
  } catch {
    // no package.json or unreadable package metadata
  }

  const uv = await detectUvCommand(cwd);
  return uv ? { command: uv, definedIn: "pyproject.toml", dir: cwd } : null;
}

/** The Justfile spelling that defines a `ci` recipe, if any. */
async function findJustCi(cwd: string): Promise<string | null> {
  for (const filename of ["justfile", "Justfile", ".justfile"]) {
    try {
      const justfile = await readFile(path.join(cwd, filename), "utf8");
      if (justfile.split("\n").some((line) => /^(?:alias\s+)?ci\s*(?::|:=)/.test(line))) {
        return filename;
      }
    } catch {
      // try the next Justfile spelling
    }
  }
  return null;
}

let justBinaryProbe: Promise<boolean> | undefined;

async function justBinaryAvailable(): Promise<boolean> {
  // Cache only while positive: `just` may be installed mid-session, and a
  // failed probe is cheap (ENOENT fails without actually spawning a process).
  if (!justBinaryProbe) {
    justBinaryProbe = execFileAsync("just", ["--version"], { timeout: 5_000 }).then(
      () => true,
      () => false,
    );
  }
  const available = await justBinaryProbe;
  if (!available) justBinaryProbe = undefined;
  return available;
}

/** Python projects: `uv run pytest` when pyproject uses uv and references pytest. */
async function detectUvCommand(cwd: string): Promise<string | null> {
  let pyproject: string;
  try {
    pyproject = await readFile(path.join(cwd, "pyproject.toml"), "utf8");
  } catch {
    return null;
  }
  const hasUv = (await fileExists(path.join(cwd, "uv.lock"))) || pyproject.includes("[tool.uv]");
  const hasPytest = pyproject.includes("pytest");
  return hasUv && hasPytest ? "uv run pytest" : null;
}

async function detectPackageRunner(cwd: string, declared: unknown): Promise<string> {
  if (typeof declared === "string") {
    const runner = declared.split("@", 1)[0];
    if (["npm", "pnpm", "yarn", "bun"].includes(runner)) return runner;
  }

  for (const [filename, runner] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ] as const) {
    if (await fileExists(path.join(cwd, filename))) return runner;
  }
  return "npm";
}

async function fileExists(filename: string): Promise<boolean> {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

function runScript(runner: string, script: string): string {
  return runner === "npm" && script === "test" ? "npm test" : `${runner} run ${script}`;
}

// Kept alongside detectVerifyCommand: tests imported it from cli in upstream.
export async function detectVerifyCommandFromPackageJson(cwd: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    if (pkg?.scripts?.test) return "npm test";
  } catch {
    // ignore
  }
  return null;
}
