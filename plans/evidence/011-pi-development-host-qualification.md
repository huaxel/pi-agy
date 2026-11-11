# 011 Pi 1.5.2 development-fixture qualification

> **Historical isolated-qualification phase.** The user subsequently authorized applying this patch and replacing the original project's dependency install while retaining its previous tree. That operation is complete and verified; see the [original-checkout integration receipt](011-original-checkout-integration.md). Statements below about an unchanged original install describe this earlier phase.

## Verdict

**APPROVE — qualified in an isolated worktree only.** The user explicitly selected major-version qualification of the development fixture, with STOP on source/API/test/support changes. No such changes were needed.

Three files changed: `package.json`, `package-lock.json`, `README.md`. The development Pi family is pinned to exact **1.5.2**; the existing **341/341 tests**, typecheck and packaging pass. Both candidate audits have **0 high/critical and 4 moderate package entries**. The 12 targeted advisory identities are absent.

**Resolved development graph qualified; embedded Undici not independently attested.** This is not approval of complete runtime security, every downstream host, legacy support removal or integration into the original checkout.

No commits, staging, pushes, publishing, global installations, original dependency replacement, source/test changes, nested Pi launch or live agy/provider inference occurred. The original integrated 17-file change remains intact and uncommitted ;011 is not applied there.

## Provenance and artifact

- Worker: separate native Codex executor `pi-011-qualifier`; advisor owned review/evidence, not production implementation.
- Worktree: `/private/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-011-h7wjxawe/worktree`, detached at `1bf9d29` plus reviewed patches 002,003,004,009,005,006,010.
- All 74 source files matched the integrated baseline before qualification. Immutable copies are in that worktree's `.pi/baseline`.
- Private Node 22.23.4/npm 10.9.9 environment: HOME, agent dir, TMPDIR and npm cache are task-owned; agent dir is outside TMPDIR. Full values are in `plans/execution/011/worker.json` and the worktree's `.pi/qualification-env.json`; no personal configuration/credentials were used.
- Incremental patch: [`011-pi-development-host.patch`](../patches/011-pi-development-host.patch).
- SHA-256: `dd1879865101d0d38974edb62067f52fdda44960a2ff726f3c51e5aa50258d0c`.
- `git apply --check` passes against the current original checkout; that was a check only, not integration.

The worker edited the development pins and final README note. Registry access and lock resolution/install were performed as reviewer verification commands **inside the disposable executor tree**, after worker-local network failures. These generated the candidate lockfile; no hand-written integrity/version substitutions were used.

## Exact delta and unchanged contracts

`package.json` changes only:

| Development fixture | Before | Qualified |
|---|---|---|
| `@earendil-works/pi-ai` |`^0.87.1` |`1.5.2` |
| `@earendil-works/pi-coding-agent` |`^0.87.1` |`1.5.2` |
| `@earendil-works/pi-tui` |`^0.87.1` |`1.5.2` |

Public peer ranges, engines, scripts, package version and runtime dependency floor are unchanged. README adds only a development/testing paragraph naming the fixture, Node>=22.19.0 SDK prerequisite, actual qualification Node 22.23.4 and embedded-Undici caveat. It does not change a public support promise or replace a managed host.

The 155 changed lock entries are in the old/new Pi development closure, including removal of duplicated legacy SDK/AWS/provider subtrees and adoption of the current Pi schema/MCP/codemode packages. All **94 production SDK closure entries remain identical in full**, not merely at the same version. In particular SDK1.32.2, Zod4.6.7 and body-parser2.4.0 remediation is preserved.

All 71 baseline files outside the three permitted paths remain byte-identical. No additional source files, compatibility shim, vendor patch, weakened test or workflow change was introduced.

## Verification actually performed

Logs/exit receipts below are relative to the isolated worktree's ignored `.pi/`. The executor's progress history and reports distinguish its attempts from reviewer successes.

| Check | Who/result | Receipt |
|---|---|---|
|74-file baseline comparison | Executor/reviewer pass | baseline hashes and qualification progress |
| Candidate lifecycle metadata | Reviewer lookup success; no install/postinstall needed for the three direct targets | `reviewer-registry.log`, reviewer package metadata |
| Lock resolution, scripts disabled | Reviewer exit 0 | `reviewer-lock-resolution.log`, `.exit` |
| Clean locked install, scripts disabled | Reviewer exit 0 | `reviewer-locked-install.log`, `.exit` |
| Typecheck, before any source adaptation | Reviewer exit 0 | `reviewer-typecheck.log`, `.exit` |
| Actual dependency resolutions | Executor exit 0 | `offline-dependency-tree.log`, `.exit` |
| Focused provider/driver/MCP/budget/render tests | Reviewer **99/99**,0 failed/cancelled/skipped | `reviewer-focused.log`, `.exit` |
| Full `npm test` | Reviewer **341/341**,54 suites,0 failed/cancelled/skipped | `reviewer-full.log`, `.exit` |
| Package dry-run after README note | Executor and reviewer exit 0; 43 entries, budget helper included | executor pack receipt and `reviewer-pack-check.log`, `.exit` |
| All-dependency audit | Reviewer exit 1; **0 high/critical,4 moderate** | `reviewer-audit-all.json`, `.exit` |
| Production-only audit | Reviewer exit 1; **0 high/critical,4 moderate** | `reviewer-audit-prod.json`, `.exit` |
| Target identities and SDK closure | Reviewer pass | `reviewer-delta-checks.json` |
| Full source/diff scope, staging | Pass; three incremental files, no staged changes | worker final scope receipts and reviewer checks |

Audit exit 1 means the remaining four moderate package entries still exist; it is not an install/test failure. Counts describe package-entry severity, not unique vulnerabilities or a guarantee of runtime exploitability.

The removed target set comprises the 11 primary brace/Undici advisory IDs and related minimatch globparts-amplification ID recorded in `plans/execution/011/primary-advisories.json` and `related-minimatch-advisory.json`. Remaining entries are `@hono/node-server`, fast-uri, Hono and ip-address, unchanged from the prior qualified production graph. Their earlier API/reachability qualifications still apply; no unrelated remediation was added.

## Failed attempts and execution-lane diagnosis

These failures are retained, not represented as successful executor verification:

1. Executor registry requests failed twice with **`getaddrinfo ENOTFOUND registry.npmjs.org`**, including a bounded retry. The executor stopped without changing source. A reviewer command using the same private environment and working directory successfully queried the registry; reviewer setup then resolved/installed the authorized candidate. This supports a worker-local execution restriction, not a claim the registry or candidate was unavailable globally.
2. Executor focused tests returned **72 pass/27 fail**, with bridge-start failures. A minimal owned loopback listener reproduced **`listen EPERM: operation not permitted 127.0.0.1`**. The same listener succeeded in the reviewer lane; unchanged focused tests then passed 99/99 and the full suite 341/341. No assertion, production timeout, permission check or SDK/source code was altered to obtain green.
3. Two static-inspection helper commands exited1 because of inspection-script assumptions, including looking for transcript helpers in pi-coding-agent rather than pi-ai. These were not SDK typecheck failures. The relevant helper exports are in pi-ai's public transcript utility; the actual project typecheck passed. Correct partial bundle data was preserved, then inspected independently.

The advisor did not enable lifecycle scripts, bypass source STOP conditions or infer permissions from configuration flags. It attempted the actual operations, recorded failures, and used the permitted reviewer verification lane. The separate executor retained source-edit ownership and ultimately reported COMPLETE for the bounded qualification, accurately attributing reviewer commands.

## Bundle evidence and what remains unproved

Static import traversal from candidate CLI/RPC entrypoints found 73 reachable JavaScript files. The candidate chunk `dist/bundle/chunks/chunk-VEJDBY3O.js` contains an iterative comma parser and element-by-element append helper. No legacy recursive remainder signature was found in the inspected reachable graph. Candidate bundle evidence is recorded in `.pi/bundle-evidence.json`; the identified chunk hash is `effbbd5d6247983dc11c7ae5796eb24bda88f9ebf78c707d3f92ca73cbb8b51e`.

Undici module markers are present, but the shipped bundle has no source maps/version marker establishing every embedded Undici fix. **Embedded Undici is not independently attested.** Resolved-package/audit facts and static parser evidence are deliberately not promoted into proof of the complete running bundle, live process globals or protection against all upstream attacks.

No stack/heap exhaustion, malicious TLS server, WebSocket flood, hostile HTTP encoding, provider turn or other advisory exploit probe was executed. Linux, Windows, minimum-Node and arbitrary Pi SDK versions were not tested. Qualification is for this exact development fixture on the recorded macOS/Node 22 environment.

## Independent final review

A fresh native Codex **read-only** reviewer compared the final three-file change against immutable baseline copies and inspected receipts. Verdict: **APPROVE**, no important actionable findings. It independently confirmed three-file scope, unchanged public contracts, all 155 lock deltas in the development closure and 94 unchanged production entries. It did not rerun tests/install/audits or claim ownership of the reviewer's executed results.

The review explicitly limits approval to the isolated fixture, not integration, legacy support removal, universal host remediation or complete runtime security. Raw review: `plans/execution/011/final-review.md`; CLI exit 0 and completed report are retained. Executor and reviewer have finished with no pending work/questions.

## Handoff

[Open the qualified worktree's development README](http://dawn.localhost:9898/d/Mh9U9-1iPVQDBL0j).

`python3 plans/execution/011/validate-qualification.py` passed **33 artifact/scope/receipt checks**. It verified original source/install preservation, all production closure entries, actual gate/audit receipts, advisory identity removal and patch application to a separate baseline copy matching all three qualified files. It does not rerun the software gate.

The patch/worktree and all evidence are retained. Original source and installed dependencies remain unchanged by011; the existing approved local integration is not discarded or replaced. Applying011 to the original checkout, replacing its development install, changing public support/peer floors, committing or publishing would require a new explicit scope/authorization.
