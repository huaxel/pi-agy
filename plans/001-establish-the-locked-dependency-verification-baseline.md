# Plan 001: Establish the locked-dependency verification baseline

> **Executor instructions:** Read this entire plan, follow the steps in order, and run each verification. Do not improvise around STOP conditions. Update only your status row in `plans/README.md` when complete, unless the reviewer owns the index.
>
> **Drift check (first):** `git diff --stat 1bf9d29..HEAD -- package.json package-lock.json .github/workflows/ci.yml .github/workflows/publish.yml`. Also run `git status --short` and inspect uncommitted changes. Compare the excerpts below with live code. Any material mismatch requires an updated plan before editing; preserve other workers' changes.

## Status

- **Priority:** P1
- **Effort:** S (investigation; remediation is a separate decision)
- **Risk:** LOW (isolated installation only)
- **Depends on:** none
- **Category:** dx / security investigation
- **Planned at:** commit `1bf9d29`, 2026-11-11

## Repository and execution conventions

This is `@juanbenjumea/pi-agy` 0.7.9: an ESM TypeScript Pi extension distributed as source through npm. Delegation tools launch the Antigravity CLI; provider turns use a persistent process and a localhost MCP bridge. There is no compiler-output build, lint script, or `just ci` gate. Use explicit `.js` relative imports in TypeScript, strict types, `node:test`, and `node:assert/strict`. Tests resolve sibling TypeScript through `tests/resolve-hook.mjs`; invoke the exact commands below, not a guessed test-runner filter.

The audited environment used Node 24.22.1. CI uses Node 22, while the manifest claims >=20.3.0; do not change runtime support in this task. Initial gates passed with installed dependencies: 305 tests, typecheck, package dry-run. Those installed versions differed from the lockfile, so do not describe them as clean-install proof.

Work on an operator-provided branch/worktree or an isolated branch named `advisor/001-establish-the-locked-dependency-verification-baseline`. **Do not commit, push, publish, deploy, open issues/PRs, or merge without separate explicit authorization.** If authorized to commit, match Conventional Commit history (for example `23a0bf2 refactor: simplify agy extension guidance and modules`).

## Why this matters

The audit's passing tests used SDK 1.32.2 and Zod 4.6.7, but the lockfile pins SDK 1.31.0 and Zod 4.6.5. CI installs the locked graph with `npm ci`. Establish whether that graph passes before trusting later fixes, and distinguish advisory exposure from merely having a named dependency.

## Current state

- `package.json:27–31` defines:
  ```json
  "test": "node --import ./tests/resolve-hook.mjs --test tests/*.test.ts",
  "typecheck": "tsc --noEmit --pretty false",
  "pack:check": "npm pack --dry-run --json"
  ```
- `.github/workflows/ci.yml` runs Node 22, `npm ci`, all three commands, and `git diff --exit-code`. Publication verification follows the same pattern.
- `package.json:68–70`: `"@modelcontextprotocol/sdk": "^1.31.0"`.
- `package-lock.json:2556–2558`:
  ```json
  "node_modules/@modelcontextprotocol/sdk": {
    "version": "1.31.0",
  ```
- `package-lock.json:4453–4455` similarly records Zod `4.6.5`; body-parser is `2.3.0` at line 2867.
- `extensions/lib/provider-mcp.ts` imports the low-level SDK `Server` as `McpServer`, not the higher-level `server/mcp.js` class. It implements its own token/Host checks and 1 MiB body reader. Do not transfer a higher-level API advisory to this implementation without tracing it.
- On the audit date, `npm audit --omit=dev --json` exited 1 with 3 high and 5 moderate entries. Advisory data changes; these numbers are observations, not done criteria.

## Scope

**May write:** `plans/evidence/001-dependency-baseline.md` (create), this plan's status row.
**May read:** manifests, lockfile, workflows, imported runtime modules, registry advisories, installed dependency sources.
**May install/run:** only inside a newly created, task-owned disposable checkout, never the user's existing working tree.
**Out of scope:** package upgrades, lockfile edits, production code, test fixes, workflow edits, publishing, credentials, inference turns. An investigation can finish with a failing baseline honestly recorded.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Runtime | `node --version; npm --version` | Versions recorded |
| Lock versions | `node --input-type=module -e 'import fs from "node:fs"; const p=JSON.parse(fs.readFileSync("package-lock.json","utf8")).packages; for(const n of ["@modelcontextprotocol/sdk","zod","body-parser"]) console.log(n,p["node_modules/"+n]?.version)'` | Locked versions printed |
| Safe install | `npm ci --ignore-scripts` in disposable checkout | Exit 0 or exact failure captured |
| Tests | `npm test` in disposable checkout | All pass, or baseline failure recorded |
| Types | `npm run typecheck` there | Exit 0, or failure recorded |
| Package | `npm run pack:check` there | Exit 0, no tarball |
| Advisories | `npm audit --omit=dev --json` there | JSON; exit 1 is expected when advisories exist |
| Tree integrity | `git diff --exit-code` there | Exit 0 |

## Steps

### Step 1: Make an isolated reproducible checkout

Record HEAD, runtime versions, lockfile SHA-256, and whether earlier work is dirty. Create a new task-owned detached worktree using `scratch=$(mktemp -d "${TMPDIR:-/tmp}/pi-agy-baseline.XXXXXX"); git worktree add --detach "$scratch/checkout" HEAD`. Keep its path in your report. Do not reuse a worker's checkout. Record that uncommitted source changes are not included.

Read dependency installation scripts before permitting them. Start with `npm ci --ignore-scripts` in that checkout. If a gate requires an installation script, identify the exact dependency/script and STOP for review rather than enabling every script. Do not install a Node version globally; use an already available Node 22 runtime if possible and record the exact version. If only another version is available, report that limit.

**Verify:** the lock-version command and `npm ls @modelcontextprotocol/sdk zod body-parser --all` → installed tree matches the lock, or an exact installation/peer-resolution discrepancy is recorded.

### Step 2: Run the real verification commands

In the disposable checkout run tests, typecheck, pack dry-run, and `git diff --exit-code` individually; save exit codes and concise failure excerpts in the evidence report. Do not fix failures. If run on Node 24 only, explicitly leave Node 22 verification unperformed.

**Verify:** `npm test; npm run typecheck; npm run pack:check; git diff --exit-code` → record each command's own exit code, not just the last command's status. Passing means zero failing/cancelled tests and zero type errors.

### Step 3: Triage advisories by actual imports and APIs

Run the audit command. For each high/critical entry, record the advisory URL, installed/locked version, fixed-version guidance, API preconditions, and a source-backed reachability verdict: reachable / not used / unresolved. Trace `extensions/lib/provider-mcp.ts` through SDK request parsing, custom authentication, and request-body handling. Do not execute exploit payloads or destructive memory probes.

The primary advisory consulted in the initial audit was https://github.com/advisories/GHSA-46jr-4wx8-v453. It says upgrading alone does not enable the new tool-input bound; it describes a higher-level `McpServer` option. Verify applicability to this low-level server rather than prescribing that option blindly. Similarly check task APIs, OAuth bearer auth, Express/body-parser, and Zod constrained-collection validation before asserting exposure.

**Verify:** `npm audit --omit=dev --json` → every current high/critical result has a row with evidence or an explicit unresolved question. A count of zero is not required for completing this investigation.

### Step 4: Deliver the baseline decision

Write the evidence report with sections: Provenance, Installed-versus-locked versions, Verification results, Advisory reachability, Recommended follow-up, Limitations. Recommend narrowly scoped upgrades only when warranted; do not implement them. Keep the disposable worktree unless the operator authorizes its removal; report its path and leave no processes running.

**Verify:** `test -s plans/evidence/001-dependency-baseline.md; git diff --exit-code -- package.json package-lock.json .github extensions tests` → report exists; original tracked implementation files are unchanged. Set the index to DONE only when the report distinguishes passed, failed, and unperformed gates.

## Test plan

No tests are added. Run the existing 305-test baseline under the locked graph, and report any drift in the count. Do not call a partial or interrupted run a pass.

## Done criteria

- [ ] Evidence report exists with every required section and exact runtime/version provenance.
- [ ] Every listed verification has an exit code or a concrete not-attempted reason.
- [ ] Every high/critical advisory has a supported reachability disposition.
- [ ] No production, manifest, lockfile, test, or workflow changes were made.
- [ ] Index says whether later plans have a passing locked baseline or must stop first.

## STOP conditions

Stop and report a blocker if installation needs unreviewed scripts, network/auth failures prevent establishing the graph, or an advisory cannot be assessed without handling credentials. If locked tests fail, complete the evidence report but block dependent implementation until the operator approves a baseline remedy. Never copy credential values or personal session-store contents into the report.

## Maintenance notes

Repeat this baseline after dependency changes; security advisory counts are time-sensitive. Future fixes should quote the tested graph and Node version, not infer them from the manifest. A package update or new CI gate needs a separate scoped implementation decision.

