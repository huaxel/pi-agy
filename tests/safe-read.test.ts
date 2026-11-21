import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { MAX_MARKER_BYTES, MAX_SKILL_BYTES, readFileBounded, readFileBoundedSync } from "../extensions/lib/safe-read.js";
import { scanSkills } from "../extensions/lib/skills.js";

const skillBody = (name: string): string =>
  `---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n\nbody\n`;

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `pi-agy-${prefix}-`));
}

describe("bounded file reads", () => {
  it("reads a regular file and follows a symlink that lands on one", async () => {
    const dir = await tempDir("safe-read");
    try {
      const real = path.join(dir, "real.md");
      await writeFile(real, "hello");
      await symlink(real, path.join(dir, "link.md"));
      assert.equal(readFileBoundedSync(real, { maxBytes: 1024 }), "hello");
      assert.equal(readFileBoundedSync(path.join(dir, "link.md"), { maxBytes: 1024 }), "hello");
      assert.equal(await readFileBounded(path.join(dir, "link.md"), { maxBytes: 1024 }), "hello");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a file larger than the cap instead of truncating it", async () => {
    const dir = await tempDir("safe-read-big");
    try {
      const big = path.join(dir, "big.json");
      await writeFile(big, JSON.stringify({ pad: "x".repeat(4096) }));
      assert.equal(readFileBoundedSync(big, { maxBytes: 1024 }), null);
      assert.equal(await readFileBounded(big, { maxBytes: 1024 }), null);
      assert.ok(readFileBoundedSync(big, { maxBytes: 8192 }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a character device and a directory before reading", async () => {
    const dir = await tempDir("safe-read-dev");
    try {
      // /dev/zero never reaches EOF: this is the read that used to hang the
      // caller, and it must fail on the handle stat, not on the read.
      assert.equal(readFileBoundedSync("/dev/zero", { maxBytes: 1024 }), null);
      assert.equal(await readFileBounded("/dev/zero", { maxBytes: 1024 }), null);
      assert.equal(readFileBoundedSync(dir, { maxBytes: 1024 }), null);
      assert.equal(readFileBoundedSync(path.join(dir, "absent"), { maxBytes: 1024 }), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("honours an already-aborted signal", async () => {
    const dir = await tempDir("safe-read-abort");
    try {
      const file = path.join(dir, "a.md");
      await writeFile(file, "x");
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        async () => {
          const text = await readFileBounded(file, { maxBytes: MAX_MARKER_BYTES }, controller.signal);
          if (text === null) throw new Error("aborted read reported as unusable");
        },
        /aborted|unusable/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("skill discovery containment and bounds", () => {
  it("does not catalogue a project skill that resolves outside the checkout", async () => {
    const root = await tempDir("skills-escape");
    try {
      const home = path.join(root, "home");
      const project = path.join(root, "project");
      const outside = path.join(root, "outside");
      await mkdir(path.join(project, ".git"), { recursive: true });
      await mkdir(path.join(project, ".pi", "skills"), { recursive: true });
      await mkdir(path.join(home, ".agents", "skills"), { recursive: true });
      await mkdir(path.join(outside, "secret"), { recursive: true });
      await writeFile(path.join(outside, "secret", "SKILL.md"), skillBody("secret"));

      // A checkout offering up a file it does not own.
      await symlink(outside, path.join(project, ".pi", "skills", "escape"));

      assert.deepEqual(scanSkills(project, home).map((s) => s.name), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still follows a symlink inside the user's own skill root", async () => {
    const root = await tempDir("skills-trusted");
    try {
      const home = path.join(root, "home");
      const central = path.join(root, "central");
      await mkdir(path.join(home, ".pi", "agent", "skills"), { recursive: true });
      await mkdir(central, { recursive: true });
      await writeFile(path.join(central, "SKILL.md"), skillBody("linked"));
      // The documented pattern: ~/.pi/agent/skills/<name> is a link to the real
      // skill elsewhere. Only a checkout's roots are confined.
      await symlink(central, path.join(home, ".pi", "agent", "skills", "linked"));

      assert.deepEqual(scanSkills(undefined, home).map((s) => s.name), ["linked"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips an oversized skill file instead of reading it whole", async () => {
    const root = await tempDir("skills-big");
    try {
      const home = path.join(root, "home");
      const project = path.join(root, "project");
      const big = path.join(project, ".pi", "skills", "big");
      await mkdir(path.join(project, ".git"), { recursive: true });
      await mkdir(big, { recursive: true });
      await mkdir(path.join(home, ".agents", "skills"), { recursive: true });
      const body = skillBody("big") + "x".repeat(MAX_SKILL_BYTES);
      await writeFile(path.join(big, "SKILL.md"), body);

      assert.deepEqual(scanSkills(project, home).map((s) => s.name), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not block on a skill file that is a pipe", async (t) => {
    if (process.platform === "win32") {
      t.skip("mkfifo is POSIX only");
      return;
    }
    const root = await tempDir("skills-fifo");
    try {
      const home = path.join(root, "home");
      const project = path.join(root, "project");
      const dir = path.join(project, ".pi", "skills", "pipe");
      await mkdir(path.join(project, ".git"), { recursive: true });
      await mkdir(dir, { recursive: true });
      await mkdir(path.join(home, ".agents", "skills"), { recursive: true });
      execFileSync("mkfifo", [path.join(dir, "SKILL.md")]);

      // Reading this would wait for a writer forever; discovery must not open it.
      assert.deepEqual(scanSkills(project, home).map((s) => s.name), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
