# Automatic Antigravity model refresh — 017

## Current result

User clarified that missing Argon was only one example: newer Sonnet/Opus
generations were missing too, and the intended outcome is **automatic refresh**.
The parser-only release was paused before any commit or tag. This implementation
is integrated and independently approved for the authorized **v0.7.12** release.

The provider now participates in Pi1.5.2 native model discovery:
- Synchronous fallback at registration; no factory-spawned probe or polling loop.
- Provider-scoped, bounded native refresh at session startup.
- Each normal `/model` picker opening automatically refreshes again through Pi's
  existing picker/coordinator, without restart or a separate extension command.
- Full discovered lists replace prior lists: additions, removals and effort-tier
  changes are reflected together. Unknown families keep their exact CLI slug.
- Failed/empty discovery preserves last-good state and reports native refresh
  errors; subsequent picker openings retry and recover after sign-in.
- Cache-only refresh does not run CLI/network discovery.
- Native generation-checked publication updates registry definitions and handler
  resolution atomically. Cancelled, superseded or shut-down refreshes cannot
  publish stale results. Existing stream-handler/runner continuity is retained.

This is event-triggered automatic discovery, not a periodic background poll.
No model names or presumed account availability were added to static fallback.

## Evidence

Tests use actual installed **ModelRuntime**, **ModelRegistry**,
**ModelSelectorComponent**, native refresh coordinator, auth resolution,
publication and registry snapshots. Only CLI discovery processes and inference
runners are fake; the picker test restricts unrelated providers to avoid external
network access. Representative Sonnet5.5/Opus5.5/Argon/future fixture strings are
not a claim that a live account exposes those exact slugs.

Before changing registration, two native-refresh regressions failed:
the provider had no refreshModels hook and a runtime refresh retained its old
catalog. Final tests cover real picker openings, rendered results, additions/
removals, exact runner slugs, identity/conversation continuity, initial and later
failures, retry recovery, empty/malformed output, no-network phase, cancellation,
concurrent supersession, timeout, delayed rejected publication and shutdown.

Independent read-only review: **APPROVE**, no required findings:
[review](017-native-refresh-independent-review.md).
[Executor receipt](017-native-refresh-execution.md).
Its pre-integration statements are historical; the original checkout now
contains all reviewed changes, and the advisor matched all seven final
source/test/docs files byte-for-byte to the retained worker.

Advisor actually ran the final gates both isolated and in the original checkout
after preparing release0.7.12:

| Gate | Isolated | Original/release |
|---|---|---|
| Provider/refresh/model tests | 78/78 | 78/78 |
| Full npm test | 465/465 | 465/465 |
| Typecheck | pass | pass |
| Package dry-run | pass | pass |
| Source diff whitespace | pass | pass |

Runtime Node26.13.0/npm11.20.0/macOS with qualified installed Pi1.5.2 dependencies.
No installs or managed Pi-package modifications. Final test commands used a
fail-closed agy executable guard and isolated agent storage. Worker attempts that
encountered actual listen/npm-cache EPERM were rerun with approved local access;
failed attempts are documented, not counted as passing gates.

Logs: `/tmp/pi-agy-models-wiNyQQ/refresh-{advisor,release}-{focused,tests}.log`
and corresponding pack JSON. Worktree retained at
`/tmp/pi-agy-models-wiNyQQ/worktree`.

## Changed implementation paths

- `extensions/index.ts`: native Provider registration and startup/refresh/shutdown.
- `extensions/lib/provider-models.ts`: preserved016 generic nonhyphen parser fix.
- `extensions/lib/provider.ts`: unknown-model advice now says reopen /model.
- `tests/provider-models.test.ts`, `tests/provider.test.ts`,
  `tests/provider-refresh.test.ts`.
- `README.md`: documents startup/picker automatic-refresh behavior.

[016 parser patch](../patches/016-nonhyphen-provider-models.patch) followed by
[017 incremental native-refresh patch](../patches/017-native-provider-refresh.patch)
reconstructs the implementation at baselineed9adcc. Release metadata and
changelog are separate. No unrelated provider-driver/bridge execution changed.

## Boundaries

The installed managed Pi extension was0.7.11 when checked and is deliberately
unchanged per the user's release selection. The installed CLI1.5.6 returned
a sign-in error on the advisor's live discovery attempt. No authenticated live
inventory or model inference was demonstrated. Updating/loading the release
and authenticating agy remain necessary to exercise live discovery.

The parser's unstructured-output ambiguity and normalized-ID collision policy
remain documented limits. No catalog persistence, unsupported-host compatibility
layer, periodic scheduler, or model-name allowlist was added.

This acceptance record is written immediately before the authorized commit/
push/publication. Release outcome is reported separately; do not interpret this
precommit checkpoint as proof of npm availability.
