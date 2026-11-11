# Automatic provider catalog refresh — executor report

Status: refresh implementation independently reviewed APPROVE; authorized wording follow-up verified; stopped before integration for the advisor final gate. No integration, commit, push, release, installation, managed-host change, or live inference was performed.

Checkout: `/private/tmp/pi-agy-models-wiNyQQ/worktree`, HEAD `ed9adccd9069984c240a637f7142ac34d56b27e8`. Qualification: installed Pi 1.5.2, Node v26.13.0, existing dependency symlink retained.

## Scope and preservation

- Changed `extensions/index.ts`: native provider discovery/publication and session lifecycle.
- Explicitly authorized wording-only scope expansion: `extensions/lib/provider.ts` now recommends “reopen /model to refresh” for unknown models; the existing unknown-model test asserts that advice.
- Added `tests/provider-refresh.test.ts`: eight regressions/integration tests using installed Pi runtime, registry, model selector, and refresh coordinator.
- Adapted `tests/provider.test.ts` native registration captures and the pre-existing uncommitted Argon regression; its exact-slug/no-effort assertion is retained. Removed its obsolete 200 ms startup sleep.
- Updated the provider behavior paragraph in `README.md`.
- Original uncommitted `extensions/lib/provider-models.ts` and `tests/provider-models.test.ts` parser patches were preserved byte-for-byte, checked against the saved initial diff. No new edits were made to those two files.
- `package.json`, `package-lock.json`, and `CHANGELOG.md` have no diff. Original release 0.7.12 metadata and original integration checkout were not touched.
- No plans or source files outside the original scope plus the explicitly authorized `extensions/lib/provider.ts` wording change were edited. `node_modules` remains the pre-existing untracked symlink to `/Users/juanbenjumea/projects/pi-extensions/pi-agy/node_modules`.

## Verified native architecture

Read the requested installed docs and both provider examples in full before changing the harness. Also inspected actual Pi source/types: `dist/core/model-runtime.js`, `provider-composer.js`, `model-registry.js`, pi-ai `dist/models.js` and `models.d.ts`, and the model selector/coordinator.

The provider now uses the supported complete `Provider` registration. Legacy callbacks return definitions and the composer publishes them later; mutating the handler's shared catalog inside that callback would precede generation acceptance. The complete provider instead publishes both the mutable handler catalog and its synchronous model definitions in one `context.publish({ update })` callback. No persistence is requested. `getModels()` reads the accepted current list dynamically.

Factory registration installs the unchanged three-model fallback synchronously and starts no process. `session_start` explicitly awaits a provider-scoped native `ctx.modelRegistry.refresh({ providers: ["antigravity"], allowNetwork: true, signal })`, bounded by a ten-second signal. This preserves ordinary startup discovery without a second publication channel. Startup refresh errors retain the catalog and notify the user to retry `/model`.

Installed model-selector source calls `refreshModels()` from its constructor (line 103), with a 15-second cancellation deadline (line 128), then `refreshModelCatalogs()` (line 135). That coordinator calls the actual `ModelRuntime.refresh()`. Each subsequent picker opening therefore retries discovery, including after an initial sign-in failure. No extra command, polling interval, or manual re-registration is used.

Native refresh first invokes a cache-only phase. The provider checks `allowNetwork` and does not spawn in that phase. Network discovery runs only `agy models`, passes a concrete combined native/shutdown signal to the existing bounded preflight runner, and checks cancellation again before publication. Pi's generation checks plus the shutdown check prevent canceled, superseded, or old-runtime results from mutating accepted state. No factory background discovery remains that could race startup or picker refresh.

Identical catalogs retain existing model objects and the same stream handler/runner. Catalog additions, removals, exact source slugs, and Gemini tier changes publish together. New Sonnet/Opus/Argon/future names are not added to fallback constants.

## Exact regression-first evidence

Before editing `extensions/index.ts`, added and ran the first two tests in `tests/provider-refresh.test.ts` using the installed ModelRuntime/registry and fake children:

```text
env PATH=/tmp/pi-agy-state-fixes-34DhuS/no-live-bin:$PATH node --import ./tests/resolve-hook.mjs --test tests/provider-refresh.test.ts
```

Result: **2 tests, 0 passed, 2 failed**. `refreshModels` was `undefined`, expected `function`. A model refresh retained `['old-model']`, expected the new Sonnet/Opus/Argon/future fixture list. Full captured evidence: `/tmp/pi-agy-models-wiNyQQ/refresh-red.log`.

After the native fix, both passed: `/tmp/pi-agy-models-wiNyQQ/refresh-green.log`. The later lifecycle tests were added as coverage during implementation; no separate pre-fix failure is claimed for those.

## Refresh implementation verification before wording follow-up

All final test commands prepended `/tmp/pi-agy-state-fixes-34DhuS/no-live-bin`. The full gate also set `PI_CODING_AGENT_DIR=/tmp/pi-agy-models-wiNyQQ/final-agent`; new runtime fixtures use individual temporary agent directories and remove them on teardown.

| Check actually run | Final result | Evidence |
|---|---|---|
| Focused provider/model/refresh suite before final timeout case | 77 passed, 0 failed | `refresh-focused.log` |
| Final native refresh file, including timeout case | 8 passed, 0 failed | `refresh-final-focused.log` |
| `npm test` | **465 passed, 0 failed, 0 canceled, 0 skipped**, 67 suites | `refresh-full-test.log` |
| `npm run typecheck` | Exit 0 | `refresh-typecheck.log` |
| `npm run pack:check` | Exit 0, 44 package entries, dry-run only | `refresh-pack.log` |
| `git diff --check` | Exit 0 | Checked after source/test edits |
| Release-file diff and original parser-patch comparison | Exit 0; release files unchanged, parser patches identical | Executor comparison against `preserved-parser.patch` |

There is no project `just ci` gate; package scripts supply the gate above.

Restricted focused tests initially failed because bridge listeners could not start. A direct socket probe returned `Error: listen EPERM: operation not permitted 127.0.0.1`. Focused and full tests were rerun successfully with approved local-server access. The initial package dry-run returned EPERM accessing npm's cache; the approved retry passed without installing or publishing anything. No host cache repair was attempted.

The eight native tests cover supported hook registration; real-runtime discovery; ordinary session startup; actual installed picker openings/rendered status; exact runner resolution of representative `claude-sonnet-5-5`, `claude-opus-5-5-thinking`, `argon`, and `future.model`; stable handler/model identity and conversation continuation; additions/removals/tier changes; cache-only no-spawn; initial and subsequent failures and recovery; delayed publication with no premature handler mutation; concurrent supersession/late results; ten-second preflight timeout; caller abort; startup shutdown; and refusal to restart an old provider instance. Tests use deferred readiness/watchdogs, fake children, and recording runners, with no timing sleeps in the new file. The picker test restricts only the real runtime's provider selection to Antigravity so unrelated built-in catalogs cannot access their servers; auth, refresh, publication, registry snapshots, coordinator, picker rendering, and disposal remain installed Pi implementations.

## Limitations, cleanup, and review boundary

Live account catalog output remains unverified. The supplied baseline says agy 1.5.6 returned a sign-in failure; no live CLI/catalog or inference call was made here. All 5.5/Argon/future model strings are representative test fixtures, not verified account slugs or claims of availability.

The preserved parser consumes unstructured first-column text. Lowercase diagnostic prose can be inherently ambiguous with a legitimate bare model slug; the previously reviewed parser constraints remain unchanged. Empty/recognized malformed output and nonzero CLI failure retain last-good state and return native refresh errors.

Cross-run catalog persistence is intentionally absent: a new extension instance starts with fallback and rediscovers at session startup. No unsupported-host compatibility shim was added; the verified contract is Pi 1.5.2. No deployment or other platform qualification is claimed.

New runtime agent directories are removed in finally blocks. Pickers are disposed, mocks restored, shutdown handlers run, and fake children closed. The full gate exited normally; no new long-lived refresh resource or polling loop exists. Retained files under `/tmp/pi-agy-models-wiNyQQ` are review evidence and the isolated final gate directory (only an empty `agy-dirlocks` directory remained). No retained user work, dependency symlink, or unrelated artifacts were removed.

Independent read-only review is **APPROVE** in `/tmp/pi-agy-models-wiNyQQ/refresh-independent-review.md`, which this executor read. It approved the refresh snapshot with no required fixes and identified the nonblocking restart-advice wording. The user then explicitly authorized only the wording change and its test assertion. This executor launched no nested agents. Integration and release remain pending the advisor final gate; the earlier full suite and pack results precede this wording-only follow-up.


## Authorized wording follow-up and final snapshot

Changed only the pre-existing unknown-model message in `extensions/lib/provider.ts:465` from `restart Pi to refresh` to `reopen /model to refresh`, and strengthened the existing unknown-model assertion in `tests/provider.test.ts`. No other implementation or test behavior changed after independent approval.

Post-follow-up checks actually run:

```text
env PATH=/tmp/pi-agy-state-fixes-34DhuS/no-live-bin:$PATH PI_CODING_AGENT_DIR=/tmp/pi-agy-models-wiNyQQ/final-agent node --import ./tests/resolve-hook.mjs --test --test-name-pattern 'provider model resolution|native provider catalog refresh|catalog lifecycle through native Pi' tests/provider.test.ts tests/provider-refresh.test.ts
env PATH=/tmp/pi-agy-state-fixes-34DhuS/no-live-bin:$PATH PI_CODING_AGENT_DIR=/tmp/pi-agy-models-wiNyQQ/final-agent npm run typecheck
git diff --check
```

Results: **11 focused tests passed**, 3 suites, 0 failures/cancellations/skips; typecheck exit 0; diff check exit 0. Logs: `refresh-followup-focused.log`, `refresh-followup-typecheck.log`. Full suite and package dry-run were not repeated after the wording-only change, as requested; the advisor final gate will follow.

Final SHA-256 values (all reviewable source/test paths, including the preserved parser changes):

```text
c482d77698df10e755b905a637e5d084b7615ae07e66bc551341bc93ced392ed  README.md
e3be184a336f30fd3fdd48f1cf388ae9aea9d394a6db66a6b213ee57001a9b2a  extensions/index.ts
2d1fbdc5ad42df309ff72b9c58e614684fbb521973ee63e6bf3716e28902cece  extensions/lib/provider-models.ts
f706981baa7269d3bee64364d9627c0eab2b9ddb29b6d24e84a35e3f61156c09  extensions/lib/provider.ts
8ef6dd46e7ef2c5fc489b6d1d9ac46b38d7610daf24a1479ac8fbd3f183dc589  tests/provider-models.test.ts
c79ddc18f4f6aaaabb2d01bd4cb8703637e64ff2d7e254c3922733d40d0a7d65  tests/provider.test.ts
2b6f8cc897b497cde40adf1eb0ceef65ff66b814d33727e7259abc6211400068  tests/provider-refresh.test.ts
```

No integration, commit, push, publishing, deployment, or live account verification has occurred.
