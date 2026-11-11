# Plan 005 — APPROVE

## Verdict and scope

**APPROVE.** Pi/Luna (`openai-codex/gpt-5.6-luna`) executed 005 in a fresh detached worktree based on the exact approved 003+009 bundle. The advisor read the full incremental diff, requested two bounded corrections, verified prerequisite preservation, and independently repeated named, focused and full project checks on final unchanged hashes.

[Approved incremental005 patch](../patches/005-terminal-response.patch). Apply **after** [003](../patches/003-tool-catalog.patch) and [009](../patches/009-timing-tests.patch), not as a replacement for either. Only these four files change incrementally:

- `extensions/lib/provider.ts`
- `extensions/lib/provider-driver.ts`
- `tests/provider.test.ts`
- `tests/provider-driver.test.ts`

Original-checkout source remains unchanged. No commit, merge, push, publication or deployment occurred. Plans 006–008 remain unstarted.

## Implementation reviewed

- Completed phases now use `result.text` as authoritative content, not accumulated callback text. If the completed result has no answer, the existing activity/empty fallback applies; stale provisional drafts are not revived.
- Both delta and no-delta paths share truncation, denied-action, cancellation and timeout annotations. `text_end.content` and `done.message` agree. Cancellation retains `aborted`, timeout retains `length`, and cancellation takes precedence when both flags are present.
- Driver terminal selection enforces the existing 512,000-character bound and sets `truncated` when clipping is needed. Existing terminal-failure/denial precedence and the separate delegation parser contract remain unchanged.
- Tests cover prefix completion, non-prefix correction, activity/empty fallback, live/no-live annotation parity, identical live/final text, terminal cap, park/resume and the real pi-ai async iterable plus `result()`.
- Park/resume checks snapshot the first phase's commentary/toolCall before resumption and prove it remains unchanged; the resumed text ends with only its canonical answer. Both phases use bounded completion observation, not arbitrary 50ms sleeps.
- The real-stream test guards **both** iteration and `result()` in one bounded operation, clears its native watchdog, aborts on failure, and checks text start/end pairing and indices.

No plan 006 waiter/cancellation lifecycle fix, usage accounting, permission, catalog, MCP session or dependency behavior was mixed into this change.

## Verification actually run

Node **22.23.4**, npm **10.9.9**, macOS; locked dependencies installed by the executor using `npm ci --ignore-scripts`. Test/dependency commands used minimal `env -i`, explicit Node22 PATH, and task-local HOME/PI_CODING_AGENT_DIR. No real agy inference occurred.

| Check | Executor final | Independent reviewer final |
|---|---|---|
| Named reconciliation/round-trip cases | 7/7 | 8/8 including the driver cap case |
| Both affected test files | 56/56 | 56/56 |
| Full suite on 003+009+005 | 319/319 | 319/319 |
| Typecheck | exit 0 | exit 0 |
| Package dry-run | exit 0 | exit 0 |
| Whitespace/staging/scope | pass | pass |

All positive runs had zero failed, skipped or cancelled tests. Packaging was a dry-run, not publication. The executor and reviewer ran the final gate separately; no passing older source version was substituted.

Reviewer raw evidence in the retained worktree: `.pi/reviewer/{named,focused,tests,typecheck,pack}.log` and corresponding `.exit` files. Machine-readable commands/results and source hashes: `plans/execution/005/independent-checks.json`. Native worker metadata: `plans/execution/005/worker.json`.

### Test-first evidence

The initial three named reconciliation cases failed against the prerequisite implementation before production edits: streamed prefix/draft suppressed canonical text, terminal-only annotations were absent, and the real stream exposed draft content. `.pi/red-005.log` records 3 tests, 0 pass, 3 expected assertion failures. The early pre-install `ERR_MODULE_NOT_FOUND` was setup failure, not functional RED; its native event history is retained separately. Expanded final coverage was verified after corrections; no claim is made that every later added assertion had its own separate RED run.

### Review corrections resolved

Round1 removed callback-text fallback from canonical completion, added explicit cancellation/no-live and annotation parity checks, exercised the real stream with bounded observation, and protected the parked phase snapshot. Round2 put `result()` inside the same guard as iteration, replaced inherited50ms sleeps in the modified round-trip with actual phase completion, and corrected a stale comment. Final source and logs reflect those corrections.

## Composition and identity

The four immutable `.pi/baseline/` snapshots were independently compared byte-for-byte to the accepted003+009 tree. Non-owned prerequisite files (`extensions/index.ts`, `tests/execution.test.ts`, `tests/preflight.test.ts`, `tests/timing-helpers.ts`) remain byte-identical. The exported005 patch was independently regenerated from those snapshots, matched the worker export, and passed `git apply --check` in the accepted prerequisite tree. No source was applied there by that check.

Incremental patch SHA-256: `7f9ad39134970ae7f5b47a71be3d9fffa7bac5f25f52a9371b71b6cc0364852b`.

Final source SHA-256:

```text
6ea80779507d3b313bee125ba02ca9af75b812a6b2c637c49b1dd7ef111fbf7a  extensions/lib/provider.ts
ca5029bcce82b21327eabe51e9fc075c77d5e182f336524ef56ca5b05e89fb79  extensions/lib/provider-driver.ts
35eca7cdc9dfcde2bbd9c6f630445f466fdc24c3cee4abcef0a5cd9b31d26c0b  tests/provider.test.ts
8501f1a2d19c3b633c99b7bf99aa4b498a98497f89398567eaecc36e409baaec  tests/provider-driver.test.ts
```

Hashes stayed unchanged through independent verification. The branch HEAD remains `1bf9d29`; all accepted changes are uncommitted.

## Retained work and next step

Worktree: `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-005-35y4ci17/worktree`. It contains the accepted003+009+005 stack and is retained with its snapshots, raw logs, worker report and exported incremental patch. Executor ended COMPLETE with native stop and no pending process/question. No extra worker/worktree, reset/clean, staging or commit was performed by the executor.

**006 is next**, after its normal drift/ownership check against this accepted stack; preserve the terminal cap and009 readiness changes. A new executor must not use the untouched original branch as though these prerequisites had already merged.

Remaining risks: SDK/Zod advisory exposure from 001 is unresolved; no Linux/Windows/minimum-Node/live-inference check was performed for005. No combined gate yet includes 002/004 alongside 003+009+005. Usage accounting and other direction work remain separate.
