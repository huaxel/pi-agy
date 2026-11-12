# Full model discovery in /agy — 018

## Root cause

The user clarified that the still-incomplete picker was **/agy**, not Pi's
native /model picker fixed by0.7.12. The screenshot path was not accessible
locally (ENOENT); diagnosis did not rely on seeing it.

Advisor reproduced the defect with successful fake discovery:
Argon/Sonnet5.5/Opus5.5 were returned, but /agy offered only its fixed ten alias
rows. Sonnet/Opus alias labels already tracked the fake newer IDs; Argon was
never offered. Only `agy models` ran in this probe; the picker was cancelled.

## Current state

**Fixed, independently approved and integrated locally.** This implementation
receipt was written before release at baseline89a805a. The user subsequently
explicitly authorized commit/push/publication as v0.7.13 and updating Pi's installed
extension. Release and installed-update outcomes are reported separately; the
uncommitted/uninstalled statements below describe this earlier checkpoint.

- /agy's model picker refreshes the full concrete CLI roster on every opening,
  including nonhyphen/dotted IDs and separate Gemini tier IDs.
- Selected IDs are preserved through confirmation, argv, quota checks,
  receipts, persistence, /agy continue and /agy sessions. Explicit selection
  cannot be silently replaced by automatic quota fallback.
- Alias shortcuts remain available and clearly labeled. Closed alias mappings
  remain exhaustive; a separate validated, mutually exclusive model_id selector
  represents exact IDs internally. agy_execute's tool schema remains alias-scoped.
- Unambiguous direct syntax: `/agy plan model=argon <task>`. Unknown bare words
  remain prompt text. Native completion preserves preceding options and the
  prompt after the cursor, without discovery on every keystroke.
- Failed/empty discovery reports its actual error and labels last-good or
  built-in fallback availability as unverified. Next picker opening retries.
  Raw rosters are scoped by cwd; late/aborted discovery cannot overwrite newer
  state or execute stale picker choices.
- Additive raw_model_id/last_raw_model_id metadata preserves exact IDs without
  changing old native provider resume keys or rewriting stored data. Actual
  executed raw targets survive repeated tool parks and changed reasoning/
  catalog options. Ambiguous legacy normalized IDs require explicit selection,
  not reverse-slugification guesses or silent Flash fallback.

## Review and verification

A native Herdr executor implemented in retained
`/tmp/pi-agy-command-models-nx092z/worktree`; a separate read-only reviewer
approved the final13-file snapshot after addressing exact-ID trailing newline
validation, full-prefix native completion, and original parked-target metadata.
Advisor also read the source/test diffs and verified all13 reviewed hashes.

Advisor final gates ran independently both isolated and after original integration:

| Check | Isolated | Original checkout |
|---|---|---|
| Focused command/session/catalog tests | 106/106 | 106/106 |
| Full npm test | 490/490 | 490/490 |
| npm run typecheck | pass | pass |
| npm run pack:check | pass,45 entries | pass,45 entries |
| Source diff whitespace | pass | pass |

Commands used the fail-closed agy PATH guard and isolated PI_CODING_AGENT_DIR.
All new discovery/execution is fake. The native completion regression uses the
actual installed CombinedAutocompleteProvider; existing native runtime/picker
refresh tests remain green. Platform qualification is local macOS/Node26.13.0,
with existing installed Pi1.5.2 dependencies.

Test-first evidence includes11 baseline failures, exact-ID/alias collision on
resume, incorrect parked raw target, invalid persisted metadata and native
autocomplete dropping preceding mode/options. See the
[executor receipt](018-command-models-execution.md) and
[independent review](018-command-models-independent-review.md).
Pre-integration statements in those reports describe their earlier checkpoints.

One intermediate focused run failed an unchanged fallback-notification test after
approximately898 seconds; its notification and root cause were not captured.
A diagnostic outside-restricted-environment rerun passed106 tests; the final
advisor runs passed without diagnostic instrumentation. The earlier failure is
not erased or explained by those passes. No deadlines or assertions were weakened.
Other restricted loopback/npm-cache EPERM attempts were rerun with approved local
access. These failures and exact evidence paths are retained in the receipt.

Raw final advisor artifacts are under `/tmp/pi-agy-command-models-nx092z/`:
`advisor-focused.log`, `advisor-tests.log`, `advisor-pack-verified.json`,
`integration-focused.log`, `integration-tests.log`, `integration-pack.json`.
[Exact retained patch](../patches/018-agy-command-model-discovery.patch).

## Scope

Source paths: extensions/commands.ts, command-run.ts; extensions/lib/args.ts,
cli.ts, command-args.ts, execute.ts, inspect.ts, provider-models.ts,
model-selection.ts (new), sessions.ts; narrow provider.ts persistence metadata.
Tests: tests/command-models.test.ts (new), tests/sessions.test.ts.

No native refresh/driver/bridge lifecycle refactor, install, credentials change,
commit, push or publication. Original package metadata is unchanged and staging
is empty. All13 integrated files byte-match the reviewed worker snapshot.

## Remaining limits

The installed extension still needs a release/update/reload to obtain this fix.
This does not establish real account model availability: prior live discovery
reported agy sign-in failure; all model fixtures here are controlled examples.
Unstructured CLI output retains its existing ambiguity for lowercase prose.
Malformed raw metadata and ambiguous old normalized IDs are not silently guessed.
No unrelated migration or broader agy_execute model-schema expansion was added.
