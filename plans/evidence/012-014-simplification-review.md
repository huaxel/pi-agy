# Incremental simplification: plans 012–014

## Current state: integrated and verified, uncommitted

The user subsequently said **go on** after the integration boundary was stated,
authorizing original-checkout integration. A bounded Herdr executor applied only
the reviewed patch. The advisor independently verified all **11/11 files byte-for-byte**
against the approved worktree and confirmed empty staging and unchanged package
metadata. No install, commit, push, publication, or backup deletion occurred.

Fresh original-checkout gate on Node **26.13.0**, npm **11.20.0**:
- Focused request/command/execution tests: **139/139 passed**.
- Full `npm test`: **414/414 passed**, no failures/cancellations/skips.
- `npm run typecheck`: passed.
- `npm run pack:check`: passed (dry-run only).
- `git diff --check -- extensions tests`: passed.

Logs: `/tmp/pi-agy-simplify-HnFFBM/integration-focused.log`,
`integration-tests.log`, `integration-pack.json`; executor receipt
`integration-report.md` in the same directory. Retained isolated worktree and
patch remain available; original-checkout changes are uncommitted. Task-owned
workers finished with no outstanding work or questions.

The isolated-review sections below are historical; their not-integrated claims
apply to that earlier checkpoint, not the current checkout.

## Historical verdict: APPROVE — isolated implementation, not integrated

Reviewed against commit **8a5d592** on 2026-11-11. User selected incremental
simplification, then authorized a Herdr executor. Native Codex worker
`agy-simplify` implemented one plan at a time; the advisor independently read
each full source/test diff and reran checks before advancing.

Retained detached worktree: `/tmp/pi-agy-simplify-HnFFBM/worktree`.
No commit, push, publication, installation, or original-checkout source change.
Existing verified dependencies are symlinked into that worktree; not modified.

## Accepted changes

- **012:** one alias tuple derives the union and both TypeBox tool schemas.
  Regression tests verify the exact alias inventory, metadata, defaults,
  optionality, and rejection of invalid values. Existing provider discovery
  semantics are unchanged.
- **013:** completed background status directs callers to collect instead of
  repeating the response. Repeated polling remains non-consuming; collect
  returns text/details and releases the record. Regression first failed on
  status content exposing the result marker, then passed.
- **014:** a pure conversation selection helper separates new, explicit resume,
  CLI latest, and recorded latest. Conflicts reject before preview/context/
  approval; valid-run approval and locked lookup boundaries are unchanged.
  Explicit-id plus new_session=false retains the old latest-agent policy.
  Empty IDs remain falsy; whitespace IDs remain truthy.

Important clarification to the original plan prose: opted-in recent context on
resume is **capped to summary**, not entirely suppressed. None remains none.
The implementation correctly preserves that existing behavior.

## Independent verification actually run

All advisor gates below ran in the retained worktree under Node **26.13.0**,
npm **11.20.0**, through the task-owned Herdr test pane.

| Stage | Tests | Typecheck | Package dry-run | Diff check |
|---|---|---|---|---|
| 012 | 344/344 | pass | 43 entries, pass | pass |
| 013 | 344/344 | pass | 43 entries, pass | pass |
| 014 focused | 139/139 | — | — | — |
| 014 combined | 414/414 | pass | 44 entries, pass | pass |

Commands: `npm test`, `npm run typecheck`, `npm run pack:check`,
`git diff --check`. Focused:
`node --import ./tests/resolve-hook.mjs --test tests/request.test.ts tests/command.test.ts tests/execution.test.ts`.

The first advisor test submission was parsed by Nushell and failed before
executing due to Bash redirection syntax. It was resubmitted explicitly through
bash; the successful gates above are actual later results, not that failed
submission. Worker 012 tests/pack initially hit EPERM; approved retries passed.
Worker 014 characterization initially lacked a fixture directory; the fixture
was corrected and 93/93 characterization tests passed before production routing.
These failures were not fixed by weakening checks or modifying dependencies.

Raw reports and logs: `/tmp/pi-agy-simplify-HnFFBM/`, including
`012-report.md`, `013-report.md`, `014-report.md`, and
`014-advisor-focused.log`, `014-advisor-tests.log`, `014-advisor-pack.json`.

## Durable patch and scope

[Combined patch](../patches/012-014-incremental-simplification.patch) includes
all eight modified tracked files and three new files. It passed
`git apply --check plans/patches/012-014-incremental-simplification.patch`
against the original checkout. That command did not apply it.

Implementation files:
- extensions/lib/cli.ts
- extensions/tools.ts
- extensions/command-run.ts
- extensions/lib/execute.ts
- extensions/lib/request.ts (new)
- tests/cli-args.test.ts
- tests/model-schema.test.ts (new)
- tests/background.test.ts
- tests/command.test.ts
- tests/execution.test.ts
- tests/request.test.ts (new)

Original source/package checks:
`git diff --exit-code -- extensions tests package.json package-lock.json`
passed. Only plans/evidence/patch files are changed in the original checkout.
The worktree's pre-existing untracked node_modules symlink is not in the patch.

## Limits and residual risk

This is independent advisor review of another agent's implementation, not a
third-reviewer proof. No live inference, Windows/minimum-Node matrix, new
dependency audit, or managed-host validation. Tests cover fake-backed protocol
and execution boundaries. The approval-time history test covers a particular
history update, not every interleaving; authoritative reads remain visibly
inside the existing directory lock. Existing preview-agent forwarding is not
redesigned. Broader provider ownership and typed Pi events remain deferred.

Integration into the original checkout is a separate decision. Preserve the
worktree and patch until explicitly authorized otherwise.
