# Independent read-only review

**Verdict: APPROVE. No remaining required findings in final snapshot 2.**

Baseline: `89a805a1f3af57b0a8b262f0123496a6e22a9f66`. Worktree: `/tmp/pi-agy-command-models-nx092z/worktree`. This verdict supersedes the interim findings and applies to the 13 file hashes below. It is a source review verdict, not an integration, commit, publication, or final full-gate claim.

## Resolved findings and reviewed behavior

- **Exact-ID validation:** explicit whitespace and ASCII/C1 control rejection precedes branding, closing the trailing-line-terminator hole in the regex boundary. Empty strings, leading flags, unsafe tokens and conflicting alias/tier/exact selectors are rejected. Closed alias maps remain exhaustive; raw IDs use a separate exclusive selector.
- **Provider persistence across parks:** the actual executed raw target is captured before `runner.run`, carried in `SuspendedTurn.rawModelId`, restored on delivery, and retained through repeated parks. Changed reasoning/catalog resolution on a later invocation cannot replace it. The regression changes both and checks the original tier. Native persistence and native resume still use the existing `model.id` key. Native refresh/lifecycle and driver are not refactored.
- **New exact-ID autocomplete:** item values retain the entire preceding argument prefix and replace only the partial ID. Native `CombinedAutocompleteProvider.applyCompletion` retains text after the cursor. The regression uses the actual installed provider APIs and checks prefix/options, repeated spaces/tabs, bare/dotted/empty partial IDs, following prompt, cursor position, parsed parameters, and unchanged fake CLI call count. Unrelated old alias completion branches remain outside scope. The previous short-value assertion is corrected.

The picker discovers a raw first-column roster on each opening, keeps Gemini tier IDs distinct, replaces removed entries, preserves clearly labeled alias shortcuts, and exposes errors with either last-good or explained fallback availability. Generation and cancellation checks protect roster publication and stale picker choices; raw rosters are keyed by resolved cwd. Completion reads cached discovery without per-keystroke network calls.

Selected raw IDs remain exact through confirmation, execution, quota selection, argv, receipt, successful/error persistence and command/session resume, including a concrete ID named `sonnet`. Raw explicit selection bypasses configured defaults and automatic quota substitution. Existing alias/default paths remain intact, and unknown families gain no guessed effort handling. Tools remain deliberately alias-scoped; no tool schema expansion was introduced.

The exported session wrapper forwards raw metadata. New `raw_model_id`/`last_raw_model_id` fields preserve the prior model/native-key field meanings; aliases clear latest raw metadata appropriately. Invalid raw history metadata is not reinterpreted as an alias. Legacy unmarked normalized hyphenated IDs remain ambiguous and require selection rather than invented account IDs; this is an acknowledged legacy limitation, not a new introduced finding. No migrations or disk rewrites were added.

## Evidence and actual checks

Reviewer performed read-only baseline-diff/source/test inspection, reread the snapshot-2 completion change and regression, inspected the validator/persistence corrections and executor report, read installed native completion code, and calculated all 13 SHA-256 hashes twice against the updated executor manifest. All match. Repository notification instrumentation is absent; the original fallback test is not changed in the diff. Only this review report was edited by this reviewer.

**No reviewer tests, typecheck, package checks, installs, inference, nested agents, commits or pushes were run.** An earlier reviewer `git diff --check` passed during the evolving review; it is not presented as a final-snapshot gate.

Executor artifacts inspected:

- `/tmp/agy-command-completion-red.log`: native regression failed with actual `model=argon` versus expected `plan model=argon`.
- `/tmp/agy-command-completion-green.log`: native regression 1/1 passed after correction.
- `/tmp/agy-command-completion-focused-approved.log`: focused suite 106 passed, 0 failed, approximately 12.44 seconds. Fallback notification was `["fallback result","info"]`; that test passed in approximately 200 ms. The external `/tmp/agy-command-completion-notify-hook.mjs` was read: it adds stderr observation to the fallback callback and preserves its original push/assertions. This is an executor run with additive diagnostic instrumentation, not a reviewer run.
- `/tmp/agy-command-completion-typecheck-final.log`: typecheck invocation with no errors; executor reports exit 0.
- `/tmp/agy-command-completion-diff-check-final.log`: empty; executor reports exit 0.
- `/tmp/agy-command-completion-focused-sandbox-failed.log`: retained earlier focused failure, 105/106 passing; fallback test took approximately 898.5 seconds and failed the expected-notification assertion. Its original notification contents and root cause remain unknown. The passing rerun does not establish the cause or erase the failed run. No deadline changes or weakened assertions were introduced.

The previously inspected full-suite artifact reports 489/489 and the package dry-run artifact reports a successful result, but both precede the final validator and autocomplete corrections. They do not validate the final snapshot. Advisor owns the subsequent final full/package gate. This evidence limit does not create an additional source finding.

Real authenticated model discovery and inference were deliberately not attempted. CLI roster output is unstructured, so otherwise valid lowercase diagnostic words remain inherently ambiguous. No account inventory, credentials or private payloads were used for this review.

## Final snapshot 2 SHA-256

- `extensions/commands.ts`: `3e47b60e64fa70f71b2fb2378ea3ca6d3b98f8e5b2ae169b8b4bc627bf6b9bd3`
- `extensions/command-run.ts`: `98cf5e078bffa95b259e0b8030b452cd66444bd44afff57169c0cbbd51f9dba7`
- `extensions/lib/command-args.ts`: `d7461b4312d932137d9b37ef18238f9f958276430d957f8d3d19b204d958afbf`
- `extensions/lib/cli.ts`: `0266476fe20b5c09c577c19170540f1d57bc6b61ef8788390ad9db9ce569df83`
- `extensions/lib/args.ts`: `199de79dd073492273da0836272f629f1fd1038fefb71afe5027271c047211ce`
- `extensions/lib/execute.ts`: `5b99c16474f95858c2e4d41a9d68d992dbf2d5c52507d98077aa8f3d91c45b93`
- `extensions/lib/inspect.ts`: `3364c900cb467ac2bdcf38bc56fcbe702b9d1fd298853ecc72fce8a4b50791bf`
- `extensions/lib/provider-models.ts`: `2676a8ffb972d6d987a153807828e045e6be21c126ff49799f9b87b634409969`
- `extensions/lib/model-selection.ts`: `db43d0b9fdaff95d072b20b783fc00a6411a5d5010eff7f32f363bacdd879b75`
- `extensions/lib/sessions.ts`: `14fca0556d7afa2d19d9f39bcffd3d72027eddffab817fd4480cc5f9dd85d999`
- `extensions/lib/provider.ts`: `60077b0a8ea17afc9ce550e48c80704266a77a467c141420445d11a3f8bfadfa`
- `tests/command-models.test.ts`: `6d30084e41b98b767497a55cdf484cdfa7d4e3de7271b0e8435921b5ff95d1c9`
- `tests/sessions.test.ts`: `2d8300fbeadaa903d0e6736e8b0827d3b04af4bb03de4bddbd16f9d585246162`
