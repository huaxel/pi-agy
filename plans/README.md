# pi-agy improvement plans

## Full /agy command model discovery — 018

**DONE — integrated locally, independently approved; uncommitted/unpublished.**
User's remaining issue was the separate /agy picker: even successful discovery
still rendered only fixed alias rows. Full raw roster, exact-ID execution and
resume now work, with visible failures/last-good fallback and model=<id> syntax.
Advisor isolated and original gates:106/106 focused,490/490 full,types/45-entrypack.
[Current diagnosis/acceptance](evidence/018-agy-command-model-discovery.md),
[independent review](evidence/018-command-models-independent-review.md).
User subsequently authorized commit/push/publication as v0.7.13 and updating Pi's
installed extension. The implementation checkpoint above predates that release.
Baseline89a805a; release and managed-update outcomes are reported separately.

## Automatic full model catalog refresh — 017

User clarified that the goal includes new Sonnet/Opus generations, not just
Argon parsing. **DONE — integrated, independently approved; advisor 78/78
focused, 465/465 full, types/pack passed.** Native refresh runs at session startup
and automatically on every `/model` picker opening; failures preserve last-good
catalog and retry on subsequent opens. No static new-model list or polling loop.
[Current acceptance](evidence/017-automatic-model-refresh.md),
[independent review](evidence/017-native-refresh-independent-review.md).
User authorized commit/push/publication as v0.7.12; installed Pi copy stays unchanged.
The earlier016 parser-only checkpoint below is superseded by this full fix.

## Nonhyphen provider model discovery — 016

**DONE — integrated locally, uncommitted/unpublished.** Model IDs such as `argon`
were rejected solely for lacking a hyphen. Generic nonhyphen parsing and public
registration regressions now pass: advisor 70/70 focused, 457/457 full, types/pack.
[Diagnosis and evidence](evidence/016-nonhyphen-model-discovery.md).
Installed Pi package remains 0.7.11, unchanged; live `agy models` currently fails
authentication. No claim of live Argon access. Baseline HEAD `ed9adcc`.

## Provider lifecycle fixes — 015

User requested fixes for the state-machine audit at `82af24b`. **DONE —
implemented, independently approved, integrated; 124/124 focused and 455/455
full tests, typecheck and packaging passed in the original checkout.**
[Current acceptance/evidence](evidence/015-provider-state-fixes.md),
[reviewed patch](patches/015-provider-state-ownership.patch).
No commit, push or publication of 015. Earlier 012–014 changes were committed
and pushed in `82af24b` / tag `v0.7.10`; historical checkpoints below retain
then-current statements. Current HEAD is `82af24b`.

Fixes cover exclusive turn ownership, retained parked terminal delivery,
repeat-safe orphan cleanup, catalog admission, suspension-publication races and
owned escalation-payload disposal. One independent review revision was required.

## Incremental simplification follow-up — 2026-11-11

User selected **simplify both incrementally** at commit `8a5d592`.
All three are now implemented, independently reviewed, and **integrated into the
original checkout with explicit user authorization**. Fresh original-checkout
verification: 139/139 focused, 414/414 full tests, typecheck and packaging pass.
All 11 changed files match the reviewed worktree exactly; no commit or push. See the
[acceptance report](evidence/012-014-simplification-review.md) and
[retained implementation patch](patches/012-014-incremental-simplification.patch).
Fresh baseline: **341/341 tests**, typecheck, **43-entry package dry-run** pass.

| Plan | Deliverable | Effort | Risk | Depends on | Status |
|---|---|---|---|---|---|
| [012](012-canonical-model-aliases.md) | Canonical delegation model aliases | S | LOW | — | DONE — approved isolated worktree; advisor 344/344, types/pack pass; integrated; original-checkout gate passed |
| [013](013-lightweight-background-status.md) | Result-free background polling | S | LOW | 012 editing order | DONE — approved isolated worktree; advisor 344/344, types/pack pass; integrated; original-checkout gate passed |
| [014](014-normalize-delegation-requests.md) | Pure conversation-choice normalization | M | MED | 012, 013 editing order | DONE — approved isolated worktree; advisor 139/139 focused, 414/414 full, types/pack pass; integrated; original-checkout gate passed |

Execute serially: all touch tools.ts. Preserve public options. 013 deliberately
changes completed status text. 014 preserves CLI-latest versus recorded-latest
semantics and session lookup/approval timing; independent review required.

Deferred: provider resource ownership, typed Pi events, independently enabled
subsystems. Reuse existing 007/008 designs rather than duplicate them.
Rejected: removing cancellation/auth/input budgets, or forcing one-shot and
persistent execution into a generic runner. No fresh security audit or live
provider validation was performed.

Historical sections below retain execution-time claims. HEAD is now `8a5d592`;
older "uncommitted/not applied" statements describe earlier checkpoints.


Generated by the improve audit on **2026-11-11**, against **`1bf9d29`** (`chore: release v0.7.9`). The maintainer selected all five reproduced defects, the dependency-baseline investigation, and both direction options. No source implementation, dependency installation, commit, publication, or live inference was performed by the advisor.

Read a plan completely before executing it. Each is self-contained; follow its drift checks, scope, verification commands, and STOP conditions. Preserve other workers' changes. Do not commit, push, merge, publish, or open issues/PRs without separate explicit authorization.

## Completion summary

**All originally selected deliverables are complete and reviewed.** The dependency investigation, five correctness fixes and bounded timing-fixture follow-up are approved. The two direction reports are **design complete; implementation unstarted**. No new feature implementation is implied by their DONE status.

- Final all-fixes worktree: `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-006-yxx758z7/worktree`. Independent Node22 verification: **330/330 tests**, typecheck and package dry-run pass; named cancellation3/3, driver19/19, provider40/40, diagnostic/MCP/parser51/51.
- [Final correctness/composition review](evidence/006-cancelled-resume-review.md). Retained patch order:002,003,004,009,005,006;005/006 are incremental. All remain uncommitted and unapplied to the original checkout.
- [007 bridge-diagnostic design](evidence/007-bridge-diagnostics-design.md): truthful passive status and an isolated, explicit test-only contract gate; no live-park injection or inference.
- [008 usage design](evidence/008-provider-usage-design.md): official protocol confirms session-cumulative counters, requiring scoped baselines/deltas rather than repeated lifetime snapshots. Numeric inclusivity, resumed-process continuity and version/peer qualification remain explicit implementation blockers.
- [Independent approval of both designs](evidence/007-008-independent-design-review.md). Their verified software baseline was reused, not needlessly rerun; conditional accounting arithmetic was checked separately.

**Authorized follow-up 010 is implemented and independently approved.** [Isolated execution evidence](evidence/010-input-budget-dependencies-review.md): SDK 1.32.2/Zod 4.6.7/body-parser 2.4.0, approved whole-body 10,000-element/64-level guard, **341/341 tests**, typecheck, packaging and installed-consumer smoke pass. The incremental patch remains `plans/patches/010-input-budget-dependencies.patch`.

**Authorized local integration through010 is complete:** all seven patches (002,003,004,009,005,006,010) were applied to the original checkout and verified against its then-preserved install. [Historical receipt](evidence/010-original-checkout-integration.md). The subsequent explicit011 authorization below supersedes that preserved-active-install phase, not its evidence.

**011 is qualified, independently approved, applied and clean-installed in the original checkout:** [qualification review](evidence/011-pi-development-host-qualification.md), [current original-integration receipt](evidence/011-original-checkout-integration.md). The user explicitly approved applying the reviewed three-file patch and aligning this project's install, retaining the previous tree. Exact Pi1.5.2 passes **341/341 unchanged tests**, typecheck and43-entry package dry-run in the original checkout. Both actual root audits show **0 high/critical,4 moderate**; all12 target IDs are absent. Installed-lock drift is **0**, with no missing required paths. All74 source hashes match the reviewed stack;27 integration/receipt checks pass. The old33,428-entry install and prior metadata/docs are intact under `.pi/dependency-backups/011-3i3yjwa8/`. HEAD unchanged, staging empty, source uncommitted; no managed-host change, global installation, push or publication.

Remaining limits: four moderate production SDK package entries remain. The installed-consumer smoke confirms the SDK can resolve an older host Zod despite a patched repository lock; the bridge-local guard is defense-in-depth, not a universal downstream dependency guarantee. The old36-path divergent/vulnerable install is retained in the ignored backup, not the active Node resolution graph. Embedded Undici remains not independently attested. Linux/Windows/minimum-Node/live-inference coverage was not added. Publishing, committing, deleting retained backups and implementing007/008 still need separate authorization/scope.

## Execution order and status

| Plan | Deliverable | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| [001](001-establish-the-locked-dependency-verification-baseline.md) | Investigate the locked dependency graph and security-advisory reachability | P1 | S | — | DONE — APPROVE; locked graph passes on Node 22 and 24 |
| [002](002-terminate-surviving-process-group-descendants.md) | Fix descendant process-group termination | P1 | M | 001 baseline decision | DONE — APPROVE in isolated worktree; 307/307 independent tests |
| [003](003-forward-active-pi-tools-into-every-provider-turn.md) | Fix active Pi tool forwarding, including registration coverage | P1 | S | 001; approved009 verification fixtures | DONE — APPROVE with009; exact combined tree314/314 twice independently |
| [004](004-allow-fresh-mcp-sessions-on-a-persistent-workspace-bridge.md) | Fix fresh-client initialization on reused bridges | P1 | M | 001 baseline decision | DONE — APPROVE in isolated worktree; 311/311 independent tests |
| [009](009-stabilize-timing-verification.md) | Diagnose and stabilize timing verification without production deadline changes | P1 | M | 001; blocked003 evidence as input | DONE — APPROVE; base309/309; combined003+009314/314 twice independently |
| [005](005-preserve-authoritative-terminal-provider-responses.md) | Fix final response reconciliation and preserve provider bounds | P1 | S–M | 001; accepted003+009 bundle | DONE — APPROVE; independent319/319, typecheck and packaging |
| [006](006-settle-provider-resumes-with-already-aborted-signals.md) | Fix pre-aborted continuation settlement | P1 | S | 001; approved prior patches | DONE — APPROVE; all-fixes stack330/330 independently, types/pack pass |
| [007](007-design-truthful-end-to-end-bridge-diagnostics.md) | Design a truthful, bounded, zero-inference bridge diagnostic | P2 | S design | 003, 004, 006 | DONE — design complete; implementation unstarted; independently approved |
| [008](008-design-native-provider-token-usage-accounting.md) | Design native usage mapping and phase accounting | P2 | S design | 005, 006 | DONE — design complete; implementation unstarted; explicit semantic blockers |
| [010](010-bound-mcp-validation-and-refresh-vulnerable-dependencies.md) | Bound bridge validation and refresh vulnerable dependencies | P1 | M implementation | 001; accepted all-fixes stack through006 | DONE — APPROVE; subsequently applied locally; isolated and original-checkout341/341, types/pack pass |
| [011](011-qualify-patched-pi-development-host.md) | Qualify a patched Pi development-host baseline | P2 | M qualification | Integrated stack through010 | DONE — APPROVE; explicitly applied and clean-installed locally;341/341, types/pack,0 high/critical root audits,0 installed-lock drift; old tree retained |

Effort: S = hours; M = about a day; estimates include regression tests for fixes. Status values: **TODO**, **IN PROGRESS**, **DONE**, **BLOCKED** (reason), **REJECTED** (reason). Append “design complete; implementation unstarted” when closing 007/008. Closing 001 means the investigation is complete, not necessarily that its baseline passes.

## Dependency and ownership notes

```text
001 baseline investigation and operator decision
 ├─ 002 process-tree termination
 ├─ 003 tool catalog ──────────────┐
 ├─ 004 bridge sessions ──────┐    │
 └─ 005 terminal response ◀───┼────┘ (003 → 005 is editing order)
     └─ 006 cancelled resume  │       (005 → 006 is editing order)
         ├─ 007 diagnostics ◀┘       (also requires 003)
         └─ 008 usage design         (also requires 005)
```

- **Baseline gate:** 001 must produce a passing locked-install baseline, or the operator must explicitly approve a documented exception/remedy, before dependent implementation begins. A failing baseline is not authorization to modify packages or tests outside a plan's scope.
- After that decision, **002, 003, and 004 can run in separate worktrees**: their implementation files do not overlap. Have one coordinator update this shared index to avoid README write conflicts.
- **003 and 005 both own `extensions/lib/provider.ts` and `tests/provider.test.ts`.** Run serially and preserve earlier changes. **005 and 006 both may own `provider-driver.ts` and its tests**; serialize them too.
- All plans stamp the original audit commit. Expected prerequisite edits still need excerpt comparison; refresh a plan's drift notes before handing it to a weaker executor if its exact target block changed. Do not overwrite another plan's fix to restore an old excerpt.
- 003's registration scenarios use distinct temporary workspaces and reset owned drivers, so its regression does not accidentally depend on 004's reconnect repair.
- 007/008 are **design reports, not feature implementations**. Their deliverables go under `plans/evidence/`; they may not change production code. New implementation work requires a separately bounded plan/approval.
- 010 began as planning-only; the user subsequently explicitly selected **full implementation**, including 10,000 elements/64 container levels. Its seven-file incremental change is complete and independently approved by a native Codex read-only reviewer; no nested Pi was launched. Preserve patch order002,003,004,009,005,006,010. SDK 1.32.2 still accepts older Zod through `^3.25 || ^4.0`; the consumer caveat was verified against the installed local tarball, not assumed away.
- 011 began as assessment-only, then the user explicitly approved isolated qualification. It is now complete without source/API/test changes, host replacement or altered public peer/Node support. Its155 lock deltas are confined to the Pi development closure; all94 production SDK entries remain identical. Worker-local DNS/loopback errors were reproduced, while the reviewer lane ran successful setup/tests unchanged; no claims rely on failed worker commands. The iterative brace parser is verified, but embedded Undici provenance remains explicitly unattested. The user subsequently explicitly authorized original-checkout application and install alignment; both are now verified, with the old install and source copies retained. See `plans/execution/011/integration.json` and its27-check validator. The managed host and public support promises remain unchanged; no commit, push or publication.

## Vetted findings and evidence

All five defects below have **HIGH confidence**, based on source reads plus focused reproductions without inference. Risk means risk of the proposed fix.

| Audit finding | Plan | Impact | Fix risk | Evidence |
|---|---|---|---|---|
| Leader exit suppresses descendant escalation | 002 | A tool can survive cancellation and keep modifying files | MED: process-group lifecycle | `extensions/lib/spawn.ts:45–77`; existing incomplete coverage at `tests/regression.test.ts:39–89` |
| Provider ignores per-invocation tools | 003 | Advertised Pi-tool bridge receives no active catalog from registration | LOW | `extensions/index.ts:89–95`; `extensions/lib/provider.ts:729–730`; test injection only through deps at `tests/provider.test.ts:337–342` |
| Reused singleton transport rejects fresh clients | 004 | Driver recycling can leave its memoized bridge unusable | MED: session/transport teardown | `extensions/lib/provider-mcp.ts:470–475`; `extensions/lib/provider.ts:266–279` |
| Terminal answer discarded after live deltas | 005 | Final Pi message can silently lose terminal content | MED: stream/event semantics | `extensions/lib/provider-driver.ts:563–566`; `extensions/lib/provider.ts:779–798` |
| Abort settles continuation before waiter exists | 006 | Resume promise stays pending beyond its own deadline | LOW | `extensions/lib/provider-driver.ts:265–287` |

### Reproduction observations

- **002:** a task-owned POSIX parent exited on SIGTERM; its harmless SIGTERM-resistant descendant was still alive after 2.3 seconds. The probe explicitly killed its owned group/descendant in cleanup. The defect is leader-dependent escalation, not proof of immediate tree quiescence or a Windows fix.
- **003:** one tool supplied via invocation options produced `request.bridgedTools.length === 0` in a fake runner.
- **004:** first fresh MCP initialize returned HTTP 200; second returned HTTP 400, `Invalid Request: Server already initialized`. Both used one task-owned bridge/config directory, which was removed on teardown; no generated header value was recorded.
- **005:** fake runner streamed `partial`, returned `partial plus terminal remainder`; completed Pi content remained `partial`.
- **006:** fake child parked; resumption with `AbortSignal.abort()` remained unsettled beyond its configured short deadline. The race guard was bounded and driver closed.

Each fix plan includes the corresponding regression before implementation, plus edge cases and the full project gate. These observations are not committed automated tests yet.

## Direction options selected for design

### 007: Functional bridge diagnostics

`extensions/lib/doctor.ts:303–330` reports driver existence and bridge tool count, and `extensions/lib/provider.ts:338–375` exposes only a passive snapshot. A positive count includes builtins and cannot prove active-tool forwarding or reconnect health. A zero-inference, fake-backed integration diagnostic could close that evidence gap, but must not disturb a live park or conflate simulated wiring with actual agy/model behavior.

### 008: Native usage accounting

`extensions/lib/provider.ts:634` increments output usage by character length, while `extensions/lib/stream.ts` already parses native token fields that the driver does not forward. Native counts could improve usage visibility, but input/cache/thinking inclusivity and multi-park counter ownership need primary-source verification; absent usage and unpriced cost must not be fabricated.

## Verification actually run by the advisor

| Check | Result | Qualification |
|---|---|---|
| `npm test` | 305 tests passed, 0 failed/cancelled/skipped | Installed dependency graph, Node 24.22.1 |
| `npm run typecheck` | Passed | Installed dependency graph |
| `npm run pack:check` | Passed; dry-run lists 42 entries | No tarball produced |
| Five focused probes above | Defects reproduced | Temporary/fake resources only; no inference |
| `npm audit --omit=dev --json` | Exit 1; 3 high and 5 moderate dependency entries | Lockfile/registry assessment, not blanket reachability proof |
| Git working tree before plans | Clean | Only `plans/` is intentionally added |

**Installed/locked discrepancy:** SDK installed **1.32.2**, locked **1.31.0** (`package-lock.json:2556`); Zod installed **4.6.7**, locked **4.6.5** (`package-lock.json:4453`); locked body-parser **2.3.0** (`package-lock.json:2867`). CI uses Node 22 and `npm ci`; this clean locked graph was **not installed or executed** by the advisor. See 001.

The repository has no lint script, compiler-output build, or `just ci`. The verified gate is `npm test && npm run typecheck && npm run pack:check`. An executor must record actual counts/results, not copy these audit results as its own verification.

### Dependency source consulted

[GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453) documents an SDK validation-memory issue and says upgrading alone does not enable its added input-element bound. This package imports the **low-level** SDK `Server` and implements a custom authenticated 1 MiB body reader, so the higher-level `McpServer` configuration guidance cannot be prescribed blindly. 001 must trace the actual locked APIs and every high/critical audit result. No malicious memory-exhaustion payload was run.

## Plan 001 execution and review

**Verdict: APPROVE.** Executed with the user-requested Pi worker, model `openai-codex/gpt-5.6-luna`. [Read the dependency-baseline evidence](evidence/001-dependency-baseline.md). The advisor requested two report revisions, checked the cited implementation paths, independently repeated the gate and audit, and accepted only the corrected evidence. No implementation, package upgrade, commit, merge, push, or publication occurred.

- Clean locked install: `npm ci --ignore-scripts` succeeded under Node 24.22.1/npm 11.19.1. SDK 1.31.0, Zod 4.6.5 and body-parser 2.3.0 match `package-lock.json`.
- Executor Node 24 gate: **305/305 tests**, typecheck and package dry-run passed.
- Independent reviewer Node 22.23.4/npm 10.9.9 gate: **305/305 tests**, typecheck and package dry-run passed. These were macOS runs; a Node 22 Linux fresh install was not performed.
- Independent audit: **3 high and 5 moderate vulnerable package entries**; that is not a count of reachable vulnerabilities or unique advisories. SDK/Zod validation-memory exposure remains unresolved. Task APIs, bearer middleware, static-file APIs and body-parser are distinguished from the actual reviewed bridge path; the Hono Node adapter itself is runtime-reachable.
- Scope checks: tracked implementation/manifests unchanged in the original checkout and both task-owned detached worktrees. Report sections, source citations, lock checksum, versions, command exits and index links checked.
- Executor worktree (report/session task): `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-001.9lr2PJ/worktree`.
- Final verification worktree: `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-baseline.vTbjT8/checkout`. Stable raw logs are in its ignored `.pi/`, including `.pi/reviewer/` for independent checks. Both worktrees are retained.
- Execution provenance: the worker created the second checkout despite being assigned the first. Its superseded initial install was removed; an early reviewer run racing that removal was discarded. Only stable-checkout verification is accepted. This deviation changed no user source and is documented in the evidence report.
- Worker completed with no pending work/questions. Execution metadata is in `plans/execution/001/worker.json`; native worker event logs there are ignored by Git.

**Follow-through:** 002, 003 and 004 have a passing locked baseline and are now assigned to separate Pi/Luna worktrees. Their source-file ownership does not overlap. The advisor will review each uncommitted diff and independently rerun its gates; nothing is merged into the original checkout. Dependency upgrades require their own scoped change, not an incidental modification in those fixes.

## Fix execution follow-through

All fix source changes remain **uncommitted in dedicated worktrees**, not applied to the original checkout. The advisor only updates `plans/` and reviews/verifies executor changes.

- **002 APPROVE:** [independent review and evidence](evidence/002-process-tree-review.md); [durable patch](patches/002-process-tree.patch). Independent Node 22 checks: focused 6/6, full suite 307/307, typecheck and package dry-run passed. The earlier executor STOP and timing failures are preserved in the report.
- **003 APPROVE with009:** [final matching-tree review](evidence/009-timing-followup-review.md); [unchanged catalog patch](patches/003-tool-catalog.patch), paired with the [approved009 test-fixture patch](patches/009-timing-tests.patch). Independent exact003+009 gates pass twice: **314/314**, typecheck and packaging exit0. The earlier [309/310 failures](evidence/003-tool-catalog-review.md) remain historical evidence, not current acceptance. Use the accepted bundle for subsequent work; the old standalone003 checkout is not the final verified tree. Plan005's predecessor gate is satisfied.
- **004 APPROVE:** [independent review and evidence](evidence/004-bridge-sessions-review.md); [durable patch](patches/004-bridge-sessions.patch); [repeatable raw lifecycle probes](evidence/004-review-probes.mjs). Review reproduced and resolved DELETE slot retention, active escalated-park expiry, and a synchronous-completion phantom-park leak. Independent Node 22 checks pass: MCP 21/21, consumers 46/46, full suite 311/311, typecheck, packaging, and direct lifecycle probes including bounded two-client/pending-park shutdown. Some edge cases live in the separate review probe script rather than npm test; that coverage-placement deviation and remaining limits are explicit in the report.

- **005 APPROVE:** [final independent review](evidence/005-terminal-response-review.md); [incremental005 patch](patches/005-terminal-response.patch), applied after accepted003+009. Canonical final text replaces provisional drafts; annotations share one path; terminal driver text stays inside512,000 characters. Parked content/toolCall preservation and real pi-ai iteration/result are tested with bounded completion. Independent Node22 checks: named8/8, both files56/56, full319/319, typecheck and package dry-run pass. Four-file incremental scope and immutable prerequisite snapshots verified. Nothing applied to main.

### Retained execution worktrees

| Plan | State | Worktree |
|---|---|---|
| 002 | Approved; not applied | `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-002-d6w16nm9/worktree` |
| 003 | Catalog proposal approved with009; not applied | `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-003-30db2pyi/worktree` |
| 004 | Approved; not applied | `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-004-sab5hisb/worktree` |
| 005 | Approved on003+009; not applied to main | `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-005-35y4ci17/worktree` |
| 006 | Approved; all-fixes composition330/330; not applied to main | `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-006-yxx758z7/worktree` |

Workers 002–004 finished with no pending questions. Metadata/native session locations are under `plans/execution/002`, `003`, and `004`; raw native sessions/logs are ignored by Git. Durable source patches and advisor reports are under `plans/patches/` and `plans/evidence/`. No combined-tree test, source integration, Linux CI, commit, merge or publication was performed in that batch. At that batch boundary,005–008 had not started; subsequent009/005 follow-through is recorded below. Do not bypass dependency order.

### Plan 009 gate follow-up

**009 APPROVE; 003 unblocked with009:** [final independent review and controls](evidence/009-timing-followup-review.md); [approved test-only patch](patches/009-timing-tests.patch). The user authorized a fresh Pi/Luna executor; one review correction was required. Independent final-source checks: fixed five runs of8/8 focused cases, affected66/66, base309/309, consumers97/97, and two consecutive exact003+009 gates314/314. Typecheck and packaging pass. Four timing files match byte-for-byte across base/integration, and003's production/catalog diff is byte-identical to its retained proposal. No production deadlines changed; no source was applied to main.

The controlled0.6s delayed-start reproduction makes the old200ms driver test fail with counter1 rather than2; the readiness-gated test retains exact cancellation/response/two-spawn assertions. Cleanup expiry now rejects and clears its native watchdog. The fresh attempt used no reset/clean or nested agent. Metadata and machine-readable evidence: `plans/execution/009-followup/`.

Final verified bundle worktree: `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-009-followup-z2zktn_f/catalog-integration`. Base009 is its sibling `timing` worktree. Both are retained. **005 is approved** after two bounded review corrections and independent verification on the exact003+009+005 stack. Metadata: `plans/execution/005/worker.json`; final evidence and incremental patch are linked above. **006 is approved:** [independent review](evidence/006-cancelled-resume-review.md), [incremental patch](patches/006-cancelled-resume.patch). The first combined prerequisite gate passed327/327; final all-fixes stack passed330/330 independently, typecheck and packaging. The waiter exists before synchronous cancellation, and the fresh-child late-timer/reuse witness passes. Metadata: `plans/execution/006/worker.json`. The retained006 worktree now holds all approved correctness proposals; original/main is unchanged. 007/008 are complete and independently approved strictly as design reports, with the verified baseline reused rather than rerunning completed checks. Their new features remain unimplemented; the usage design records B1–B4 as implementation blockers rather than inventing semantics.

**Prior attempt — 009 BLOCK:** [final independent review](evidence/009-timing-verification-review.md); [unapproved partial test-only patch](patches/009-timing-tests-partial.patch). Pi/Luna's second/final revision exited with the actual provider error `{"detail":"Bad Request"}` before completing verification. No replacement Pi process was launched during recovery.

Independent Node22 checks on the retained final partial timing tree: six selected cases pass; full suite is **307/308** (unchanged provider-driver abort/respawn counter case fails); typecheck exits 2 on an undefined `controller`; standalone packaging passes with 42 entries. A separate control reproduces the helper silently restoring spawn after its cleanup timeout while tracked work remains pending. All three final timing files differ from the integration copy, so older combined passes are not current acceptance evidence. Earlier failures and superseded reports remain preserved; no production deadline or original-checkout source changed.

The worker's earlier reset/clean of its own reconstructible integration copy is recorded as an execution deviation, not authorization to repeat it. Future refreshes must be non-destructive and byte-verified. Final-source acceptance still requires the fixed focused samples and two consecutive matching integrated gates, not retrying until lucky. That interrupted attempt did not approve003; the fresh follow-up above now supersedes its verdict with matching final-source evidence. Its execution metadata remains `plans/execution/009/worker.json`.

## Findings considered and rejected or deferred

- **Permission bypass default:** documented intentional behavior for accept-edits; changing permission policy is not part of this audit's fix list. Provider-native tools and bridged Pi tools remain distinct surfaces; these plans do not claim all native actions pass Pi approval.
- **Configured shell command as automatic command injection:** `defaultModelCommand` is explicitly user-owned shell configuration; executing that configured command is not by itself a vulnerability. No credential/config values were copied.
- **Stale-lock stat/remove race:** acknowledged best-effort recovery tradeoff in `lock.ts` and `sessions.ts`; not reclassified as a new defect without stronger evidence. Do not replace locks as an incidental refactor.
- **Blanket SDK/Express/OAuth/task advisory exposure:** rejected as unsupported. The package does not use every dependency API; individual reachability belongs in 001. Do not equate an audit entry with a remotely unauthenticated vulnerability in this loopback-token-protected bridge.
- **Generic missing guidance/lint/refactor requests:** no concrete leverage over the reproduced defects. Existing strict types and 305 tests are a useful baseline; prioritize boundary coverage rather than adding infrastructure for its own sake.
- **Skill discovery caching and unbounded cache cleanups:** synchronous scanning/caches merit measurement before a performance finding; no latency/memory regression was demonstrated. No broad caching plan was selected.
- **Node support declaration/CI matrix:** the package declares >=20.3.0, tests use newer Node APIs, and installed Pi peers require newer Node. Cross-version runtime behavior was not reproduced; record versions in 001 instead of asserting a tested Node 20 failure.
- **Cancellation lock-release ordering / process exit before escalation:** 002 fixes a reproduced group-signaling defect but does not promise to await all descendants before releasing the workspace lock or surviving host exit. A stronger supervisor/lock contract needs separate design.

## Audit coverage and limits

Standard, hotspot-weighted direct audit: execution/retry/cancellation, background lifecycle, filesystem locks, session storage, provider registration/streaming/parks, MCP auth/body limits/transport ownership, tool projection, image staging, verification detection, diagnostics, key tests, README/changelog, package metadata, CI/publication workflow, and runtime dependency posture. Recon found no tracked ADR/PRD/CONTEXT/DESIGN/PRODUCT/CONTRIBUTING or local AGENTS/CLAUDE documents. The recent refactor and provider additions guided hotspot selection.

Not a whole-repository line-by-line proof: remaining parser/render/usage branches were not exhaustively audited. No live inference, real permission/approval flow, Windows process-tree verification, minimum-Node matrix, fresh locked install, production deployment, or full credential/history scan was performed. The initial audit was performed directly with self-review; independent subagent review was not attempted at that stage. The follow-through investigation uses the user-requested Pi/Luna executor and separate advisor verification. High-risk implementations still need independent review when executed.
