# APPROVE

Independent read-only review of `/private/tmp/pi-agy-models-wiNyQQ/worktree`, baseline `ed9adccd9069984c240a637f7142ac34d56b27e8`. No required fixes found. Approval concerns the reviewed local patch; it does not authorize committing, publishing, or deployment.

## Scope and findings

Reviewed the complete tracked diff (README.md, extensions/index.ts, extensions/lib/provider-models.ts, extensions/lib/provider.ts, tests/provider-models.test.ts, tests/provider.test.ts), untracked tests/provider-refresh.test.ts, and relevant discovery, turn-resolution, lifecycle, and fixture callers. No source files were modified. No tests, installs, inference, live CLI commands, commits, pushes, or nested agents were run by this reviewer.

- `extensions/index.ts:45-139`: registers one complete native Provider synchronously. The factory starts no discovery process or refresh timer. Session startup requests a provider-scoped network refresh with a 10-second deadline; normal picker opening supplies the subsequent automatic refresh. No periodic interval is intended or needed.
- `extensions/index.ts:95-119`: native ambient auth resolves the literal placeholder `not-used`; agy remains responsible for actual authentication. Cache-only callbacks return before spawning. Discovery failures and unusable empty catalogs throw before mutation, retaining fallback or last-good state. Models and mutable handler entries change together inside `context.publish({ update })`; the handler and runner remain stable.
- `extensions/index.ts:98-118`: combines runtime cancellation with session shutdown, checks before work, after discovery, and immediately inside publication. Pi's installed `pi-ai/dist/models.js:127-175` checks generation and cancellation immediately before the synchronous update. Recomposition/supersession aborts older refreshes; there is no unguarded late catalog mutation.
- `extensions/lib/provider-models.ts:148-190`, `extensions/lib/provider.ts:456-473`: newly discovered unknown families retain their exact upstream runner slug and receive no forced effort. The patch adds no new-model fallback or model allowlist. Existing Gemini effort-family behavior remains deliberate. The text parser's documented ambiguity for lowercase diagnostic words and existing normalized-ID collisions remain limitations, rather than newly introduced refresh failures.
- `tests/provider-refresh.test.ts:15-48,129-145`: integration uses actual installed ModelRuntime, ModelRegistry, ModelSelectorComponent, and picker refresh coordinator. Only discovery process work and inference runner calls are intercepted; picker testing is not merely a captured refresh callback. The picker wrapper limits provider scope while preserving the runtime refresh implementation and options.
- `tests/provider-refresh.test.ts:149-197`: covers startup discovery, each picker opening, rendered model visibility, exact Sonnet/Opus/Argon/future slugs, absent effort for unknown families, unchanged handler/runner, conversation resume, changed effort metadata, and cache-only no-spawn behavior. Streaming through the native registry and rendering the native available-model snapshot exercise native ambient auth without a stored key.
- `tests/provider-refresh.test.ts:199-339`: covers visible startup/native picker failures, later recovery, last-good retention, rejected publication before handler mutation, supersession with a late stale result, preflight timeout, cancellation, and shutdown. The source guards agree with these tests.

Read the applicable user-provided AGENTS instructions; no repository AGENTS.md was found. Read the relevant installed Pi 1.5.2 `docs/extensions.md` provider-refresh section and `docs/custom-provider.md` refresh contract. Actual installed types and implementation were authoritative. Workspace dependency copies of `pi-ai/dist/models.js` and `pi-coding-agent/dist/core/model-runtime.js` hash identically to the requested absolute Pi 1.5.2 release files under `/Users/juanbenjumea/dotfiles/pi/agent/install/releases/1.5.2/node_modules/@earendil-works/`.

## Verification actually observed

Reviewer ran read-only diff/status/file inspection, dependency implementation/hash comparison, and `git diff --check` (clean). Tests were deliberately not rerun, to avoid competing with the executor.

Executor-produced logs inspected:

- `/tmp/pi-agy-models-wiNyQQ/refresh-final-focused.log`: 8 tests, 8 passed, no failures/cancellations/skips; includes the real runtime and selector lifecycle cases above.
- `/tmp/pi-agy-models-wiNyQQ/refresh-focused.log`: 77 tests passed, no failures/cancellations/skips.
- `/tmp/pi-agy-models-wiNyQQ/refresh-full-test.log`: completed with 465 tests / 67 suites, all passed, no failures/cancellations/skips.
- `/tmp/pi-agy-models-wiNyQQ/refresh-typecheck.log`: contains the typecheck invocation and no diagnostics; this reviewer did not independently capture its process exit status.
- `/tmp/pi-agy-models-wiNyQQ/refresh-pack.log`: final content is the successful npm dry-run package JSON. An earlier read during execution showed an EPERM cache error; the executor subsequently replaced that log with the successful result. No cache repair or package command was performed by this reviewer.

These are inspected executor artifacts, not independent test executions. There is no authenticated live-catalog proof: the supplied advisor observation was `agy 1.5.6 models` exiting 1 without authentication. No live authentication or inference was attempted here. Real service model availability remains unverified; the tests establish automatic discovery/publication using controlled CLI output.

Final follow-up reviewed read-only on 2026-11-12: `extensions/lib/provider.ts:465` now correctly says `reopen /model to refresh`; the existing unknown-model assertion at `tests/provider.test.ts:147-151` requires this wording. This resolves the nonblocking wording note. The only additional changes since approval are that error-message replacement and its assertion. APPROVE remains unchanged, with no required fixes. No tests were run for this follow-up; the advisor's final gate was reported running and its result is not asserted here. Earlier inspected test logs describe the pre-wording-follow-up snapshot.

## Final reviewed snapshot

Final diff and SHA-256 comparison completed after the wording follow-up. The five other previously hashed files are unchanged; the final seven-file snapshot below includes the newly changed provider.ts and updated provider.test.ts. `node_modules` is an untracked dependency symlink, not a source change reviewed for inclusion.

```text
c482d77698df10e755b905a637e5d084b7615ae07e66bc551341bc93ced392ed  README.md
e3be184a336f30fd3fdd48f1cf388ae9aea9d394a6db66a6b213ee57001a9b2a  extensions/index.ts
2d1fbdc5ad42df309ff72b9c58e614684fbb521973ee63e6bf3716e28902cece  extensions/lib/provider-models.ts
f706981baa7269d3bee64364d9627c0eab2b9ddb29b6d24e84a35e3f61156c09  extensions/lib/provider.ts
8ef6dd46e7ef2c5fc489b6d1d9ac46b38d7610daf24a1479ac8fbd3f183dc589  tests/provider-models.test.ts
c79ddc18f4f6aaaabb2d01bd4cb8703637e64ff2d7e254c3922733d40d0a7d65  tests/provider.test.ts
2b6f8cc897b497cde40adf1eb0ceef65ff66b814d33727e7259abc6211400068  tests/provider-refresh.test.ts
```

Only this review report was written. Required fixes: none. Remaining validation limit: authenticated live CLI discovery was not demonstrated.

Reviewer handoff: no pending reviewer processes, agents, questions, or further work. The advisor's final gate is outside this reviewer's process ownership.
