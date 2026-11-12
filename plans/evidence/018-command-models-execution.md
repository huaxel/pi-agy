# /agy concrete model selection executor report

Baseline: 89a805a. Worktree: /tmp/pi-agy-command-models-nx092z/worktree.
Status: implementation complete locally, including the interim independent-review autocomplete correction; stopped for independent re-review and advisor final full gate. No integration, commit, push, publication, installation, real agy discovery/inference, or managed-host changes performed. Existing node_modules symlink preserved. No nested agents used. No account model inventory verified.

## Root cause and resulting behavior

The baseline picker called discovery but rendered only MODEL_ALIASES. Successful discovery already updated Sonnet/Opus alias labels; that behavior was not the underlying defect and is preserved. The missing raw roster, hidden discovery errors, closed executor selector, and alias-only session restoration prevented end-to-end concrete selection.

Each model-picker opening now performs one bounded `agy models` inspection and parses the full raw first-column roster. Exact IDs, periods, nonhyphen IDs and distinct Gemini tier IDs survive unchanged. Discovery replaces the previous raw roster rather than merging it forever. Clearly labeled alias shortcuts follow discovered IDs, retaining bare alias grammar and current catalog resolution. The existing alias catalog maps remain closed and exhaustive.

A branded AgyModelId and mutually exclusive AgyModelSelector keep concrete model_id separate from model/tier. Interactive runs require an explicit selection. Exact selection reaches confirmation, status, executeAgyTask, buildAgyArgs, process argv, receipt details and persistence unchanged. Explicit aliases and concrete IDs cannot receive automatic quota fallback; existing default selection and fallback policy remain intact. Unknown families do not gain guessed effort flags. No agy_execute tool/schema expansion was needed; tools.ts is untouched.

Direct syntax: `/agy plan model=unknown.future inspect this`. Only leading options are consumed. Unknown bare words remain prompt text. Bare aliases still work. Empty, unsafe and conflicting exact selectors report errors. `model=` completions use the last successful roster for the last invoked command cwd, without discovery per keystroke. Before a successful roster, the explicit syntax still accepts validated IDs. Opening the model picker is the refresh trigger; explicit selection does not add a command-picker discovery step.

Discovery failure reports the actual error and labels either the last successful roster or the built-in alias fallback as unverified availability. Empty/malformed output is a discovery failure. Another cwd does not inherit the first cwd roster. A subsequent opening retries. Generation checks reject late results and aborted inspections before alias/catalog publication and before executing a stale picker choice. Discovery cache is in memory, per command registration and resolved cwd. The shared executor's existing independent health/quota preflight remains; cold execution may make its own existing model check after picker discovery. No new native refresh hook or duplicate native discovery was added.

Permission confirmation, per-directory lock, deadline, retry/cancel, explicit conversation selection, agent restoration and bounded context behavior remain on the existing execution path. Tests assert write rejection and picker cancellation do not spawn inference. Existing executor tests cover the default/fallback, locks, retry, cancellation and context contracts.

## Persistence fields and approved extra scope

`model` in a history record and `last_model` in the latest record retain their prior meaning: a legacy delegation alias, exact selected delegation ID, or native provider model.id. They are not overwritten with guessed CLI IDs.

Additive metadata: `raw_model_id` in history and `last_raw_model_id` in the latest record. These hold validated, exact delegation CLI IDs. saveSession's optional final rawModelId argument is forwarded by its exported default wrapper and recorded on both paths, including executor failure persistence. Alias calls leave the metadata absent. Saving another alias removes latest raw metadata while retaining older history records. No migration, deletion or rewriting of legacy records was introduced. Malformed raw-ID history entries are omitted from read results instead of being reinterpreted as an alias; their on-disk data is retained.

New provider records retain native model.id as the existing resume key and add exact raw metadata. For a grouped Gemini base plus effort, this metadata is the known concrete tier ID represented by that catalog pair (e.g. gemini-3.8-flash-low); delegation sends that tier ID without inventing effort behavior. Fixed-model records retain the full raw ID including periods. Native registration, catalog refresh, lookup key, driver and lifecycle code are otherwise unchanged.

The provider persistence target is captured before the actual runner.run call, carried as rawModelId in SuspendedTurn, restored on resume, and carried through subsequent parks. It is never recalculated from changed reasoning/catalog options on the invocation that delivers a tool result. The regression parks with Gemini 3.8 low, changes the current catalog to Gemini 9.9 and reasoning to high/medium, re-parks, then verifies persisted raw metadata still says gemini-3.8-flash-low. Native persistence remains keyed by model.id as before.

Legacy unmarked provider keys can be ambiguous after slugification. Restoration keeps known aliases, accepts validated dotted IDs (which cannot originate from native slugification) and validated bare IDs, but does not guess unknown hyphenated legacy keys. /agy continue then offers explicit model selection; /agy sessions reports the ambiguous model. Existing old data is not changed. New metadata makes alias/exact collisions such as a concrete ID named sonnet unambiguous.

Extra scope was reported before editing sessions.ts; user approved sessions.ts/sessions.test.ts and later explicitly approved the narrow provider.ts persistence change. The source changes outside initial scope are limited to those approved persistence changes. README and release metadata are untouched. Command description and completions expose the explicit model= syntax.

## Tests first and exact outcomes before autocomplete re-review

All validation commands had PATH prepended with executable `/tmp/pi-agy-state-fixes-34DhuS/no-live-bin` and an isolated temporary PI_CODING_AGENT_DIR. Test-local fake executables/injected runners supply outputs; the guard refuses accidental fallback to installed agy. Existing dependencies were used without installs.

1. Baseline registered-command regression: 11 tests, 0 passed, 11 failed. `/tmp/agy-command-red.log`. Includes missing raw picker entries, hidden failure, exact-ID execution/receipt/resume and quota refusal assertions. The initial model roster fixtures included argon, claude-sonnet-5-5, claude-opus-5-5-thinking, unknown.future and all three Gemini Flash tiers. These are representative fake strings, not authenticated account inventory.
2. Initial implementation: 11/11 passed. `/tmp/agy-command-green.log` was subsequently reused for an expanded green run, so the baseline red log is retained independently.
3. Exact ID colliding with alias sonnet: expanded suite 13 tests, 12 passed, 1 failed on resume resolving sonnet to claude-sonnet-5-5. `/tmp/agy-command-edge-red.log`. Persistence metadata and wrapper forwarding corrected it. Final suite includes this collision.
4. First focused gate: 103/103 passed. `/tmp/agy-command-focused.log`.
5. Park/resume target regression: 1 test failed with actual gemini-9.9-flash-high vs expected gemini-3.8-flash-low. `/tmp/agy-command-park-red.log`. After capturing/carrying the actual original target: 1/1 passed, `/tmp/agy-command-park-green.log`.
6. Invalid persisted raw-ID regression: 1 test failed because invalid raw metadata was dropped and legacy alias remained. `/tmp/agy-command-invalid-red.log`. Corrected by conservatively rejecting those history entries from read results; final focused suite covers it.
7. First full sandbox npm test: 487 tests, 438 passed, 49 failed, exit 1. `/tmp/agy-command-npm-test.log`. Bridge startup/config failures occurred and an executor transient retry test timed out. A direct loopback probe returned `Error: listen EPERM: operation not permitted 127.0.0.1`. These failures were not claimed as passing or repaired by weakening tests. The suite was rerun outside the sandbox with approval.
8. Full approved npm test: 488/488 passed, exit 0. `/tmp/agy-command-npm-test-approved.log`. After the invalid-metadata guard, full approved npm test again: 489/489 passed, exit 0, `/tmp/agy-command-npm-test-final.log`. Both full runs precede the advisor's final explicit whitespace/control guard correction described below.
9. Package dry-run inside sandbox failed, exit 255: npm EPERM opening /Users/juanbenjumea/.npm/_cacache/tmp. `/tmp/agy-command-pack.log`. Approved rerun `npm run pack:check` succeeded, exit 0: `/tmp/agy-command-pack-approved.log`. No cache ownership change or install was attempted. This successful dry-run also precedes the final validator guard correction.
10. Final correction requested by advisor: explicitly reject all whitespace and ASCII/C1 control characters before branding public exact IDs. Tests cover argon trailing newline plus hyphenated IDs with trailing newline, CR, tab, space and NUL; labeled CLI rows still parse. No native parser family/grouping behavior change.
11. PRE-AUTOCOMPLETE SNAPSHOT focused command: 105/105 passed, exit 0. `/tmp/agy-command-validator-focused.log`.
12. PRE-AUTOCOMPLETE SNAPSHOT `npm run typecheck`: exit 0. `/tmp/agy-command-validator-typecheck.log`.
13. PRE-AUTOCOMPLETE SNAPSHOT `git diff --check`: exit 0, no output. `/tmp/agy-command-diff-check.log`.

The pre-autocomplete focused command was:

```bash
PATH=/tmp/pi-agy-state-fixes-34DhuS/no-live-bin:$PATH PI_CODING_AGENT_DIR=$(mktemp -d /tmp/agy-command-validator-focused.XXXXXX) node --import ./tests/resolve-hook.mjs --test tests/command-models.test.ts tests/command.test.ts tests/sessions.test.ts tests/provider-models.test.ts tests/provider-refresh.test.ts tests/cli-args.test.ts
```

Pre-autocomplete types and whitespace commands used the same PATH guard and mktemp isolation, with prefixes /tmp/agy-command-validator-types.XXXXXX and /tmp/agy-command-validator-diff.XXXXXX respectively. Earlier full and pack commands used the same guard and isolated temp directories; the approved commands were `npm test` and `npm run pack:check`. No just ci/project gate exists in package scripts; npm test/typecheck/pack:check are the requested gate.

## Remaining limits and handoff

- Independent re-review is pending. Advisor will rerun the final full gate. The 489-pass full result and package result precede both the final explicit validator guard and autocomplete correction; they are not final-snapshot full-gate evidence.
- Real authenticated discovery and inference were deliberately not attempted. The reported account authentication failure still requires login; no credentials were edited.
- The CLI list is unstructured. Token validation rejects unsafe IDs and known headers/diagnostics, but an otherwise valid lowercase diagnostic word is inherently indistinguishable from a bare ID. This is the existing shared parser limitation, not a claim of live support.
- Ambiguous unmarked legacy normalized IDs require explicit selection; no reverse-slugification guesses or migration layer exist.
- No UI screenshot on the inaccessible /home path was used. Evidence is actual command registration with fake UI and fake subprocess argv, plus native SDK refresh tests and injected provider-runner tests.
- The worktree is retained for advisor re-review. No integration was performed.

## Autocomplete independent-review correction and final snapshot

Read `/tmp/pi-agy-command-models-nx092z/independent-review.md`. Its remaining required finding was correct: Pi's CombinedAutocompleteProvider replaces the entire argument prefix using item.value. A short value such as model=argon therefore lost preceding plan/continue/timeout/context options.

Production scope for this correction is only the new exact-ID completion branch in extensions/commands.ts. It now copies the entire argument prefix through `model=` and replaces only the partial ID. Original option spelling, repeated spaces and tabs remain unchanged. Existing unrelated completion branches were not refactored. tests/command-models.test.ts updates the old short-value assertion and adds a test against the actual installed @earendil-works/pi-tui CombinedAutocompleteProvider getSuggestions/applyCompletion APIs. It checks full-prefix values, the applied editor line and cursor, retained trailing prompt text, and parser mode/continue/timeout/context fields. Cases cover bare and option-prefixed IDs, empty partial IDs and dotted IDs. The fake CLI call list is unchanged while completing, demonstrating cache-only completion.

Regression-first result: 1 test, 0 passed, 1 failed with actual model=argon vs expected plan model=argon. Log `/tmp/agy-command-completion-red.log`. After the correction: 1/1 passed, `/tmp/agy-command-completion-green.log`.

The first post-correction focused sandbox run FAILED: 106 tests, 105 passed, 1 failed. The existing `falls back to a notification when custom entries are unavailable` test took 898534.946833 ms; total test-run duration was 912433.120208 ms. Original log `/tmp/agy-command-completion-focused.log`; preserved distinct copy `/tmp/agy-command-completion-focused-sandbox-failed.log`. The assertion recorded only false for the expected notification, not the actual notifications array. Its historical notification/error cannot be recovered from that log and is unknown. No passing-gate claim is made for this run. No deadline/retry changes, assertion weakening, or speculative production fix was made.

Environment inspection inside the sandbox returned `PermissionError: [Errno 1] Operation not permitted: 'ps'`. The requested final focused run was then performed once outside the sandbox with approval. `/tmp/agy-command-completion-approved-environment.log` records start/end UTC, guard executable resolution, Node v26.13.1, npm 11.20.0, process inventory (pid/ppid/elapsed/state/comm only), and a successful loopback readiness probe. The command exported a newly isolated PI_CODING_AGENT_DIR and prepended `/tmp/pi-agy-state-fixes-34DhuS/no-live-bin` to PATH. Test fakes still take precedence locally; installed real agy was never invoked.

For actual notification evidence, an external temporary Node load hook `/tmp/agy-command-completion-notify-hook.mjs` adds stderr logging only to that existing fallback test's fake UI notification callback. It leaves its assertion and execution untouched, and does not edit repository files or installed modules. The final run captured exactly `fallback-notification ["fallback result","info"]`; the fallback test passed in 200.096625 ms. The slow failure did not recur, so a baseline recurrence reproduction was not triggered. The earlier failure's cause is not established merely by the successful rerun.

FINAL SNAPSHOT results:

- Focused outside-sandbox suite: 106/106 passed, exit 0, 12442.18525 ms. `/tmp/agy-command-completion-focused-approved.log`.
- `npm run typecheck`: exit 0. `/tmp/agy-command-completion-typecheck-final.log`.
- `git diff --check`: exit 0, no output. `/tmp/agy-command-completion-diff-check-final.log`.
- Full npm test and package dry-run were not repeated after the autocomplete correction. Advisor owns the final full gate after re-review.

The final focused test command, inside the approved guarded/isolated shell, was:

```bash
node --import ./tests/resolve-hook.mjs --import /tmp/agy-command-completion-notify-hook.mjs --test tests/command-models.test.ts tests/command.test.ts tests/sessions.test.ts tests/provider-models.test.ts tests/provider-refresh.test.ts tests/cli-args.test.ts
```

Only extensions/commands.ts and tests/command-models.test.ts changed during this correction; this executor report was updated outside the worktree as requested. No integration, commits, pushes, publication, installs, real agy calls or nested agents occurred. Independent re-review remains pending.

## Changed files and final snapshot hashes

- `extensions/commands.ts` — SHA-256 `3e47b60e64fa70f71b2fb2378ea3ca6d3b98f8e5b2ae169b8b4bc627bf6b9bd3`
- `extensions/command-run.ts` — SHA-256 `98cf5e078bffa95b259e0b8030b452cd66444bd44afff57169c0cbbd51f9dba7`
- `extensions/lib/command-args.ts` — SHA-256 `d7461b4312d932137d9b37ef18238f9f958276430d957f8d3d19b204d958afbf`
- `extensions/lib/cli.ts` — SHA-256 `0266476fe20b5c09c577c19170540f1d57bc6b61ef8788390ad9db9ce569df83`
- `extensions/lib/args.ts` — SHA-256 `199de79dd073492273da0836272f629f1fd1038fefb71afe5027271c047211ce`
- `extensions/lib/execute.ts` — SHA-256 `5b99c16474f95858c2e4d41a9d68d992dbf2d5c52507d98077aa8f3d91c45b93`
- `extensions/lib/inspect.ts` — SHA-256 `3364c900cb467ac2bdcf38bc56fcbe702b9d1fd298853ecc72fce8a4b50791bf`
- `extensions/lib/provider-models.ts` — SHA-256 `2676a8ffb972d6d987a153807828e045e6be21c126ff49799f9b87b634409969`
- `extensions/lib/model-selection.ts` — SHA-256 `db43d0b9fdaff95d072b20b783fc00a6411a5d5010eff7f32f363bacdd879b75`
- `extensions/lib/sessions.ts` — SHA-256 `14fca0556d7afa2d19d9f39bcffd3d72027eddffab817fd4480cc5f9dd85d999`
- `extensions/lib/provider.ts` — SHA-256 `60077b0a8ea17afc9ce550e48c80704266a77a467c141420445d11a3f8bfadfa`
- `tests/command-models.test.ts` — SHA-256 `6d30084e41b98b767497a55cdf484cdfa7d4e3de7271b0e8435921b5ff95d1c9`
- `tests/sessions.test.ts` — SHA-256 `2d8300fbeadaa903d0e6736e8b0827d3b04af4bb03de4bddbd16f9d585246162`

The untracked node_modules symlink predates this work and is preserved. Other untracked paths are the two intentional new source/test files listed above. No plan/advisor-owned file was edited.
