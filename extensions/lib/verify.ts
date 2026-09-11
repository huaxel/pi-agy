import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
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
  let current = path.resolve(cwd);
  while (true) {
    const command = await detectVerifyCommandAt(current, deps);
    if (command) return command;

    if (await fileExists(path.join(current, ".git"))) return null;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function detectVerifyCommandAt(
  cwd: string,
  deps: VerifyDetectionDeps,
): Promise<string | null> {
  if ((await hasJustCi(cwd)) && (await (deps.justAvailable?.() ?? justBinaryAvailable()))) {
    return "just ci";
  }

  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")) as PackageJson;
    const scripts = pkg.scripts ?? {};
    const runner = await detectPackageRunner(cwd, pkg.packageManager);
    if (typeof scripts.ci === "string" && scripts.ci.trim()) return runScript(runner, "ci");
    if (typeof scripts.test === "string" && scripts.test.trim()) return runScript(runner, "test");
  } catch {
    // no package.json or unreadable package metadata
  }

  return detectUvCommand(cwd);
}

async function hasJustCi(cwd: string): Promise<boolean> {
  for (const filename of ["justfile", "Justfile", ".justfile"]) {
    try {
      const justfile = await readFile(path.join(cwd, filename), "utf8");
      if (justfile.split("\n").some((line) => /^(?:alias\s+)?ci\s*(?::|:=)/.test(line))) {
        return true;
      }
    } catch {
      // try the next Justfile spelling
    }
  }
  return false;
}

let justBinaryProbe: Promise<boolean> | undefined;

async function justBinaryAvailable(): Promise<boolean> {
  justBinaryProbe ??= (async () => {
    try {
      await execFileAsync("just", ["--version"], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  })();
  return justBinaryProbe;
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
