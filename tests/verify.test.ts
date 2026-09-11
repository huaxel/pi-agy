import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat as statFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const execAsync = promisify(execFile);

import {
  buildAgyArgs,
  buildAgyPrompt,
  isAgyModel,
  isTransientAgyFailure,
  parseModelCatalog,
  resetModelCatalog,
  resolveAgyModelId,
  updateModelCatalog,
} from "../extensions/lib/cli.js";
import { resolveAgyMode, truncate } from "../extensions/index.js";
import piAgyExtension from "../extensions/index.js";
import { registerAgyCommand } from "../extensions/commands.js";
import { executeAgyTask } from "../extensions/lib/execute.js";
import { resetPreflightCache } from "../extensions/lib/preflight.js";
import { withDirLock } from "../extensions/lib/lock.js";
import { detectVerifyCommand } from "../extensions/lib/verify.js";
import { summarizeGitDiff } from "../extensions/lib/postflight.js";
import { loadAgyConfig, resetDefaultModelCache, resolveDefaultModel } from "../extensions/lib/config.js";
import {
  accumulateRunResult,
  finalizeRunResult,
  formatStepProgress,
  parseStreamLine,
} from "../extensions/lib/stream.js";
import { parseJsonResponse } from "../extensions/lib/parse.js";
import { parseAgyCommandArgs } from "../extensions/commands.js";
import { createSessionStore, getDefaultStorePath } from "../extensions/lib/sessions.js";
describe("detectVerifyCommand", () => {
  it("prefers just ci when justfile has ci recipe", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-verify-"));
    await writeFile(path.join(tmp, "justfile"), "ci:\n  echo ok\n");
    assert.equal(await detectVerifyCommand(tmp, { justAvailable: async () => true }), "just ci");
  });

  it("falls back to npm test", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-verify-"));
    await writeFile(
      path.join(tmp, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
    assert.equal(await detectVerifyCommand(tmp), "npm test");
  });

  it("prefers a package ci script and package manager", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-verify-"));
    await writeFile(
      path.join(tmp, "package.json"),
      JSON.stringify({ packageManager: "pnpm@9", scripts: { ci: "pnpm lint && pnpm test" } }),
    );
    assert.equal(await detectVerifyCommand(tmp), "pnpm run ci");
  });

  it("recognizes uppercase Justfile aliases", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-verify-"));
    await writeFile(path.join(tmp, "Justfile"), "alias ci := check\n");
    assert.equal(await detectVerifyCommand(tmp, { justAvailable: async () => true }), "just ci");
  });

  it("finds verification commands in a repository ancestor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-agy-verify-"));
    const nested = path.join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(root, "justfile"), "ci:\n  echo ok\n");
    assert.equal(await detectVerifyCommand(nested, { justAvailable: async () => true }), "just ci");
  });

  it("recognizes hidden .justfile", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-verify-"));
    await writeFile(path.join(tmp, ".justfile"), "ci:\n  echo ok\n");
    assert.equal(await detectVerifyCommand(tmp, { justAvailable: async () => true }), "just ci");
  });

  it("stops at the repository boundary", async () => {
    const outer = await mkdtemp(path.join(os.tmpdir(), "pi-agy-verify-"));
    await writeFile(path.join(outer, "justfile"), "ci:\n  echo ok\n");
    const repo = path.join(outer, "repo");
    await mkdir(repo, { recursive: true });
    await execAsync("git", ["init", "-q"], { cwd: repo });
    const nested = path.join(repo, "packages", "app");
    await mkdir(nested, { recursive: true });
    assert.equal(await detectVerifyCommand(nested), null);
  });

  it("falls back to npm test when just is not installed", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-verify-"));
    await writeFile(path.join(tmp, "justfile"), "ci:\n  echo ok\n");
    await writeFile(
      path.join(tmp, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
    assert.equal(
      await detectVerifyCommand(tmp, { justAvailable: async () => false }),
      "npm test",
    );
  });

  it("detects uv run pytest for Python projects", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-verify-"));
    await writeFile(
      path.join(tmp, "pyproject.toml"),
      "[project]\nname = 'x'\n[dependency-groups]\ndev = ['pytest']\n",
    );
    await writeFile(path.join(tmp, "uv.lock"), "");
    assert.equal(await detectVerifyCommand(tmp), "uv run pytest");
  });
});


