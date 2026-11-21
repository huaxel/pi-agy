/**
 * Pi Agent Skills discovery and catalog loader for the MCP bridge.
 *
 * Scans Pi and agents skill locations:
 * - Global: ~/.pi/agent/skills and ~/.agents/skills
 * - Project: .pi/skills and .agents/skills in cwd + ancestors up to git root
 *
 * Exposes a tool `activate_skill` to agy via MCP with an enum of available skills.
 * When called, returns the raw markdown content of the selected skill's SKILL.md.
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MAX_SKILL_BYTES, readFileBoundedSync } from "./safe-read.js";

export const ACTIVATE_SKILL_TOOL_NAME = "activate_skill";

export interface SkillEntry {
  name: string;
  description: string;
  filePath: string;
  dir: string;
}

export interface SkillLocation {
  dir: string;
  style: "pi" | "agents";
  /**
   * Whether entries may resolve outside `dir`.
   *
   * The home roots are the user's own configuration and are routinely symlink
   * farms (`~/.agents/skills` is often itself a link), so a link leaving the
   * directory is the user's intent there. A project root belongs to a checkout,
   * and there a link leaving the directory is how an untrusted repository
   * offers up any readable Markdown file on the machine.
   */
  trusted: boolean;
}

const MAX_DEPTH = 16;

/** Parse `name:` and `description:` out of SKILL.md YAML frontmatter. */
export function parseSkillFrontmatter(raw: string): { name?: string; description?: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const nameMatch = line.match(/^name:\s*(.+)$/);
    if (nameMatch && !out.name) {
      out.name = nameMatch[1].trim();
    }
    const descMatch = line.match(/^description:\s*(.+)$/);
    if (descMatch && !out.description) {
      out.description = descMatch[1].trim();
    }
  }
  return out;
}

/** Get search directories for skills according to Pi & agents conventions. */
export function getSkillLocations(projectDir?: string, home: string = os.homedir()): SkillLocation[] {
  const locs: SkillLocation[] = [
    { dir: path.join(home, ".pi", "agent", "skills"), style: "pi", trusted: true },
    { dir: path.join(home, ".agents", "skills"), style: "agents", trusted: true },
  ];
  if (!projectDir) return locs;

  locs.push({ dir: path.join(projectDir, ".pi", "skills"), style: "pi", trusted: false });

  let cur = path.resolve(projectDir);
  while (true) {
    locs.push({ dir: path.join(cur, ".agents", "skills"), style: "agents", trusted: false });
    const parent = path.dirname(cur);
    if (parent === cur || existsSync(path.join(cur, ".git"))) break;
    cur = parent;
  }

  return locs;
}

function readSkillFile(file: string, fallbackName: string): SkillEntry | null {
  // Bounded and regular-file-only. Discovery runs synchronously inside the
  // bridge's tool-list handler, so a project-controlled `SKILL.md` that is a
  // FIFO, a device, or a multi-gigabyte file would block or exhaust Pi before
  // anything inspected its frontmatter.
  const raw = readFileBoundedSync(file, { maxBytes: MAX_SKILL_BYTES });
  if (raw === null) return null;
  const fm = parseSkillFrontmatter(raw.replace(/^\uFEFF/, ""));
  const description = (fm.description ?? "").trim();
  if (!description) return null;

  return {
    name: fm.name?.trim() || fallbackName,
    description: description.replace(/\s+/g, " ").slice(0, 160),
    filePath: file,
    dir: path.dirname(file),
  };
}

/**
 * Resolve a candidate and require it to stay inside the skill root.
 *
 * Discovery followed symlinks, so a checkout could point a skill entry at any
 * user-readable Markdown file — or at a directory tree outside the root — and
 * have `activate_skill` return its body to agy. The canonical path is what
 * decides: a link is usable only when it still lands under the root it was
 * found in.
 */
function containedPath(candidate: string, root: string): string | null {
  let resolved: string;
  let resolvedRoot: string;
  try {
    resolved = realpathSync(candidate);
    resolvedRoot = realpathSync(root);
  } catch {
    return null;
  }
  if (resolved === resolvedRoot) return resolved;
  return resolved.startsWith(resolvedRoot + path.sep) ? resolved : null;
}

function scanLocation(loc: SkillLocation): SkillEntry[] {
  const walk = (dir: string, depth: number): SkillEntry[] => {
    if (depth > MAX_DEPTH) return [];
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    const found: SkillEntry[] = [];
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      // Only a checkout's roots are confined; see SkillLocation.trusted.
      const candidate = path.join(dir, entry);
      const full = loc.trusted ? candidate : containedPath(candidate, loc.dir);
      if (full === null) continue;
      let isDir = false;
      try {
        const s = statSync(full);
        isDir = s.isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        const skillMd = path.join(full, "SKILL.md");
        if (existsSync(skillMd)) {
          const skill = readSkillFile(skillMd, entry);
          if (skill) found.push(skill);
        } else {
          found.push(...walk(full, depth + 1));
        }
        continue;
      }
      if (!entry.endsWith(".md") || entry === "SKILL.md") continue;
      const standalone = loc.style === "pi" ? depth === 0 : depth > 0;
      if (!standalone) continue;
      const skill = readSkillFile(full, entry.replace(/\.md$/, ""));
      if (skill) found.push(skill);
    }
    return found;
  };
  return walk(loc.dir, 0);
}

/**
 * Scan for all available Pi skills across standard locations.
 * Deduped by skill name (first found wins).
 */
export function scanSkills(projectDir?: string, home: string = os.homedir()): SkillEntry[] {
  const seen = new Set<string>();
  const out: SkillEntry[] = [];
  for (const loc of getSkillLocations(projectDir, home)) {
    for (const skill of scanLocation(loc)) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      out.push(skill);
    }
  }
  return out;
}

/** Format skills for the MCP tool description. */
export function formatSkillsSummary(skills: SkillEntry[]): string {
  if (skills.length === 0) return "No skills available.";
  return skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
}

/** Read the markdown content of a skill. */
export function readSkillContent(skill: SkillEntry): string {
  const body = readFileBoundedSync(skill.filePath, { maxBytes: MAX_SKILL_BYTES });
  if (body === null) {
    return "Error reading skill file: not a regular file, unreadable, or larger than 1 MiB";
  }
  return body;
}
