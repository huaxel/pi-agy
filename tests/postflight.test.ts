import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat as statFile,
  writeFile,
} from "node:fs/promises";
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
import {
  type GitBaseline,
  summarizeGitDiff,
  captureGitBaseline,
  summarizeGitDiffSince,
  parsePorcelainStatus,
} from "../extensions/lib/postflight.js";
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
describe("git probes cannot execute repository configuration", () => {
  it("does not run a configured core.fsmonitor program", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-fsmon-"));
    await execAsync("git", ["init", "-q"], { cwd: tmp });
    await writeFile(path.join(tmp, "tracked.txt"), "hello\n");
    const hook = path.join(tmp, "hook.sh");
    await writeFile(hook, '#!/bin/sh\ntouch "$(dirname "$0")/EXECUTED"\necho "1 .Q"\n');
    await chmod(hook, 0o755);
    await execAsync("git", ["config", "core.fsmonitor", hook], { cwd: tmp });

    // Sanity: plain git status does run the hook on this machine, so the case
    // measures the guard rather than git's own behaviour.
    const exposed = path.join(tmp, "EXECUTED");
    await execAsync("git", ["status", "--porcelain"], { cwd: tmp }).catch(() => undefined);
    assert.equal(await statFile(exposed).then(() => true, () => false), true);

    await rm(exposed);
    await captureGitBaseline(tmp);
    assert.equal(await statFile(exposed).then(() => true, () => false), false);
  });
});

describe("change attribution", () => {
  it("attributes a file created inside an already-untracked directory", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-attrib-"));
    await execAsync("git", ["init", "-q"], { cwd: tmp });
    await writeFile(path.join(tmp, "tracked.txt"), "hello\n");
    await execAsync("git", ["add", "tracked.txt"], { cwd: tmp });
    await execAsync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], {
      cwd: tmp,
    });

    // Already untracked before the run: git status collapses it to `notes/`.
    await mkdir(path.join(tmp, "notes"));
    await writeFile(path.join(tmp, "notes", "old.md"), "old\n");
    const baseline = await captureGitBaseline(tmp);

    // The run creates one file here and changes nothing tracked.
    await writeFile(path.join(tmp, "notes", "new.md"), "new\n");

    const attribution = await summarizeGitDiffSince(baseline, tmp);
    assert.deepEqual(attribution.newFiles, ["notes/new.md"]);
    assert.deepEqual(attribution.preexistingFiles, ["notes/old.md"]);
  });
});

describe("changed-file attribution", () => {
  it("lists every changed path past the display cut, never the marker", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-trunc-"));
    await execAsync("git", ["init", "-q"], { cwd: tmp });
    await writeFile(path.join(tmp, "seed.txt"), "seed\n");
    await execAsync("git", ["add", "seed.txt"], { cwd: tmp });
    await execAsync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], {
      cwd: tmp,
    });
    // Enough names that the display summary is cut well before the last one.
    const created: string[] = [];
    for (let index = 0; index < 120; index += 1) {
      const name = `notes/created-with-a-long-name-${String(index).padStart(3, "0")}.md`;
      await mkdir(path.join(tmp, "notes"), { recursive: true });
      await writeFile(path.join(tmp, name), "x\n");
      created.push(name);
    }
    const baseline: GitBaseline = { dirtyFiles: new Set(), unavailable: false };
    const attribution = await summarizeGitDiffSince(baseline, tmp);
    assert.equal(attribution.newFiles.length, created.length);
    assert.deepEqual(attribution.newFiles, [...created].sort());
    assert.ok(!attribution.newFiles.some((file) => file.includes("truncated")));
    assert.match(attribution.summary ?? "", /diff summary truncated/);
  });
});

describe("parsePorcelainStatus", () => {
  it("keeps fixed porcelain columns for unstaged statuses", () => {
    const files = parsePorcelainStatus(" M src.ts\nA  added.ts\nM  staged.ts\n?? untracked.txt\n");
    for (const expected of ["src.ts", "added.ts", "staged.ts", "untracked.txt"]) {
      assert.ok(files.has(expected), `missing ${expected}`);
    }
  });

  it("records both sides of renames and copies across XY variants", () => {
    const files = parsePorcelainStatus(
      "R  old.ts -> new.ts\nRM old2.ts -> new2.ts\n R wt-old.ts -> wt-new.ts\nC  c-old.ts -> c-new.ts\n",
    );
    for (const expected of [
      "old.ts",
      "new.ts",
      "old2.ts",
      "new2.ts",
      "wt-old.ts",
      "wt-new.ts",
      "c-old.ts",
      "c-new.ts",
    ]) {
      assert.ok(files.has(expected), `missing ${expected}`);
    }
  });

  it("splits renames at the last arrow when paths contain arrows", () => {
    const files = parsePorcelainStatus("R  a -> b -> c\n");
    assert.ok(files.has("a -> b"));
    assert.ok(files.has("c"));
    assert.equal(files.size, 2);
  });

  it("never splits non-rename paths that contain arrows", () => {
    const files = parsePorcelainStatus(" M odd -> name.txt\n");
    assert.deepEqual([...files], ["odd -> name.txt"]);
  });

  it("keeps git quoting verbatim on rename halves", () => {
    const files = parsePorcelainStatus('R  "old -> a" -> "new file"\n');
    assert.ok(files.has('"old -> a"'));
    assert.ok(files.has('"new file"'));
  });

  it("ignores blank lines", () => {
    assert.equal(parsePorcelainStatus("\n   \n").size, 0);
  });
});

describe("summarizeGitDiff", () => {
  it("reports untracked files", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-diff-"));
    await execAsync("git", ["init", "-q"], { cwd: tmp });
    await execAsync("git", ["config", "user.email", "t@t"], { cwd: tmp });
    await execAsync("git", ["config", "user.name", "t"], { cwd: tmp });
    await writeFile(path.join(tmp, "new.txt"), "hello");
    const summary = await summarizeGitDiff(tmp);
    assert.ok(summary);
    assert.match(summary!, /untracked files/);
    assert.match(summary!, /new\.txt/);
  });

  it("reports staged tracked files", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-diff-"));
    await execAsync("git", ["init", "-q"], { cwd: tmp });
    await execAsync("git", ["config", "user.email", "t@t"], { cwd: tmp });
    await execAsync("git", ["config", "user.name", "t"], { cwd: tmp });
    await writeFile(path.join(tmp, "tracked.txt"), "before\n");
    await execAsync("git", ["add", "tracked.txt"], { cwd: tmp });
    await execAsync("git", ["commit", "-qm", "initial"], { cwd: tmp });
    await writeFile(path.join(tmp, "tracked.txt"), "after\n");
    await execAsync("git", ["add", "tracked.txt"], { cwd: tmp });

    const summary = await summarizeGitDiff(tmp);
    assert.ok(summary);
    assert.match(summary!, /git diff --cached --stat/);
    assert.match(summary!, /tracked\.txt/);
  });

  it("returns null on a clean repo", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-diff-"));
    await execAsync("git", ["init", "-q"], { cwd: tmp });
    assert.equal(await summarizeGitDiff(tmp), null);
  });

  it("attributes pre-existing unstaged modifications to the baseline, not agy", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-unstaged-"));
    await execAsync("git", ["init", "-q"], { cwd: tmp });
    await execAsync("git", ["config", "user.email", "t@t"], { cwd: tmp });
    await execAsync("git", ["config", "user.name", "t"], { cwd: tmp });
    await writeFile(path.join(tmp, "src.ts"), "one\n");
    await execAsync("git", ["add", "src.ts"], { cwd: tmp });
    await execAsync("git", ["commit", "-qm", "initial"], { cwd: tmp });
    // Unstaged modification — porcelain prints ` M src.ts` with a leading
    // space; trim-then-slice used to mangle it into `rc.ts`.
    await writeFile(path.join(tmp, "src.ts"), "two\n");
    const baseline = await captureGitBaseline(tmp);
    assert.ok(baseline.dirtyFiles.has("src.ts"), "unstaged path recorded verbatim");

    await writeFile(path.join(tmp, "agy-made.txt"), "agy\n");
    const diff = await summarizeGitDiffSince(baseline, tmp);
    assert.deepEqual(diff.newFiles, ["agy-made.txt"]);
    assert.deepEqual(diff.preexistingFiles, ["src.ts"]);
  });

  it("attributes pre-existing staged renames to the baseline, not agy", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-rename-"));
    await execAsync("git", ["init", "-q"], { cwd: tmp });
    await execAsync("git", ["config", "user.email", "t@t"], { cwd: tmp });
    await execAsync("git", ["config", "user.name", "t"], { cwd: tmp });
    await writeFile(path.join(tmp, "old.txt"), "before\n");
    await execAsync("git", ["add", "old.txt"], { cwd: tmp });
    await execAsync("git", ["commit", "-qm", "initial"], { cwd: tmp });
    await execAsync("git", ["mv", "old.txt", "new.txt"], { cwd: tmp });

    // `git status --porcelain` prints `R  old.txt -> new.txt`, while
    // `diff --name-only` lists only new.txt — both sides must be recorded.
    const baseline = await captureGitBaseline(tmp);
    assert.equal(baseline.unavailable, false);
    assert.ok(baseline.dirtyFiles.has("old.txt"), "baseline keeps the original name");
    assert.ok(baseline.dirtyFiles.has("new.txt"), "baseline keeps the new name");
    assert.equal(baseline.dirtyFiles.has("old.txt -> new.txt"), false);

    // agy then touches an unrelated file; the rename must not look new.
    await writeFile(path.join(tmp, "agy-made.txt"), "agy\n");
    const diff = await summarizeGitDiffSince(baseline, tmp);
    assert.deepEqual(diff.newFiles, ["agy-made.txt"]);
    assert.ok(diff.preexistingFiles.includes("new.txt"));
    assert.ok(!diff.preexistingFiles.includes("agy-made.txt"));
    assert.match(diff.summary!, /pre-existing dirty files/);
  });

  it("propagates cancellation while collecting the diff", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-agy-diff-"));
    await execAsync("git", ["init", "-q"], { cwd: tmp });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(summarizeGitDiff(tmp, controller.signal));
  });
});


