# Changelog

## 0.5.6

- Report user cancellations accurately when postflight is cut short: the diff-skip note no longer claims deadline expiry for user-initiated cancels (found in the final adversarial pass).

## 0.5.5

- Preserve completed responses past the deadline: a result that fully arrived before cancellation or timeout is returned with an explanatory note instead of being discarded — previously a kill landing between delivery and process exit threw the finished response away.
- Post-run steps cut short by the deadline (diff summary) are skipped with a note instead of failing the whole run after agy already finished.
- Persist the conversation under a fresh bounded signal on the success path too, so a save racing the deadline still records the resumable id.

## 0.5.4

- Fix pre-existing unstaged modifications being misattributed to agy: porcelain paths are now parsed by fixed column — `line.trim()` before `slice(3)` ate the path's first character for ` M` lines, so unstaged dirt never matched `diff --name-only` and always looked newly-dirty. Found by the agy plan-mode cross-review.
- Honor top-level `--output-format json` envelope fields in-stream so non-streaming responses of any size accumulate fully instead of relying on the bounded raw capture.
- Raise the raw stdout capture bound from 64 KB to 1 MB so plain-text fallbacks rarely truncate.
- Split rename/copy porcelain paths at the last ` -> ` (paths may themselves contain arrows), preserving git quoting verbatim so entries match `diff --name-only`.
- Extract `parsePorcelainStatus` as a testable unit; move fake-agy payloads from argv to a file so tests can exceed the ~128 KB argv cap.

## 0.5.3

- Persist timed-out or cancelled conversations so they stay resumable: the failure-path session save passed the already-aborted signal to the session store, whose lock guards reject it, making conversation continuity on timeout/cancel silently dead code. Found by dogfooding a real agy run.
- Extend the fake-agy test harness with a hang-after-output mode to reproduce hangs that start after a conversation id was emitted.

## 0.5.2

- Deliver large streamed result records intact: the per-record bound now fits a maximum-size response (1M chars with worst-case JSON escaping) instead of discarding records over 256 KB mid-stream.
- Mark responses served from the raw stdout fallback when the 64 KB capture bound truncated them.
- Record both sides of pre-existing staged renames/copies in the git baseline so they are never attributed to agy as newly-dirty files.
- Require Node.js >= 20.3.0 (`AbortSignal.any`).
- Name the failing check in preflight exit-code errors (health, connectivity, version, usage) instead of a hardcoded connectivity hint.
- Validate the `agy_usage` working directory before spawning so a bad `dir` is not misreported as a missing Antigravity CLI installation.
- Document that `new_session: false` resumes the last recorded conversation in the tool schema the model sees.
- Stop caching negative `just` binary probes mid-session; installing `just` is now picked up without a restart.
- Offer `timeout=10m` in `/agy` argument completions.
- Document the irreducible stale-lock recovery race in both lock implementations.

## 0.5.1

- Add an `agy_usage` tool and `/agy usage` command for model-specific quota and reset discovery.
- Refresh read-only agy usage data before executions and include the snapshot in results when available; unsupported older CLIs remain best effort.
- Refresh quota data every minute while retaining five-minute health/model preflight caching.
- Fix release-candidate model ids such as `rc1` being treated as stable.
- Honor the documented `quotaBalancing` config flag when loading `agy-config.json`.
- Fail fast with reset details when usage explicitly reports the selected model is exhausted, including secondary windows such as weekly limits.
- Accept JSONL quota output from noisy agy CLI versions that support native headless usage.
- Ignore malformed streamed metadata instead of allowing subprocess JSON to corrupt results.
- Make stream bounds UTF-8 byte-accurate and decode split multibyte stdout safely.
- Include available model alternatives when failing fast on an exhausted quota.
- Normalize explicit percentage quota fields correctly, including fractional percentages.
- Match quota records across model aliases and human-readable thinking labels without conflating low/medium/high tiers.
- Add structured `quota_status` metadata (`available`, `exhausted`, or `unknown`) to targeted quota checks, echoed in the readable tool text.
- Preserve bounded quota-probe failure reasons for troubleshooting instead of reporting only generic unavailability.
- Add `quota_status` to successful execution details for machine-readable model availability.
- Match grouped Gemini and Claude/GPT quota pools to concrete model selections without crossing families, preserving nested window names.
- Recognize grouped/family fields, snake-case exhaustion flags, and relative reset durations.
- Retry failed quota probes after five seconds while caching successful snapshots for one minute.
- Refuse to invoke `/usage` on agy versions older than 1.1.11, where it could be interpreted as a model prompt.
- Group all quota windows for a targeted model at the top of its report.
- Parse plain-text quota records when a version-gated native usage command returns text, extracting model percentages, requests, tokens, quota windows, and reset hints where possible.

## 0.5.0

- Fold quota-aware default-model steering into the extension (`quotaBalancing` config + `AGY_DEFAULT_MODEL_*` env tuning); the external `agy-default-model.sh` wrapper is gone.
- First standalone release as `@juanbenjumea/pi-agy` (extracted from dotfiles `pi/packages/pi-agy`).
- Terminate the full agy process tree (not just the direct child) on cancel/timeout via detached process groups.
- Attribute post-run git summaries to newly-dirty files only; pre-existing dirt is listed separately and shown in accept-edits confirmation.
- Serialize same-directory runs across Pi processes with filesystem locks and symlink-canonicalized paths; heartbeat long-held locks so they are never mistaken for stale, and release only locks still owned.
- Bound streamed JSONL records and accumulated responses; discard oversized records with a warning (pure `appendStreamChunk` helper with behavioral tests).
- Ignore preview/experimental model ids in live catalog resolution unless `PI_AGY_ALLOW_PREVIEW=1`.
- Ship a publishable `LICENSE`, add `typecheck`/`pack:check` scripts, and verify the packed tarball contents.
- Add `tests/regression.test.ts`: fake-agy cancel/timeout/malformed-JSONL integration, a grandchild file-write proof that tree-kill stops nested writers, preview filtering, stream bounds, baseline diff attribution, symlink lock sharing, and artifact checks.
- Split the monolithic `tests/cli.test.ts` into focused suites (`cli-args`, `verify`, `stream`, `postflight`, `execution`, `command`, `config`, `sessions`, `balance`, `lock`) sharing a `tests/helpers.ts` fake-agy harness.
- Document `PI_AGY_ALLOW_PREVIEW=1` as the explicit opt-in for preview/experimental model ids.
- Normalize equivalent working-directory paths before locking so concurrent calls cannot bypass serialization.

- Normalize equivalent working-directory paths before locking so concurrent calls cannot bypass serialization.
- Sanitize `agy-config.json`; malformed permission settings fail closed instead of enabling bypasses.
- Persist the effective fallback model so session history and quota balancing remain accurate.
- Distinguish delegation timeouts from user cancellation, preserve JSON-shaped response text, and bound postflight git commands.
- Use stable response-generation progress instead of forwarding raw token fragments to the TUI.
- Preserve recoverable conversation IDs across failed runs, propagate postflight cancellation, refuse to overwrite corrupt session stores while letting reads degrade gracefully so tasks are never blocked by bookkeeping.
- Recognize configured `flash`/`pro` shorthands and distinguish subprocess timeouts from transient failures.
- Make session-store writes cancellation-aware and clean up partially acquired locks.
- Reject conflicting conversation selectors and invalid empty/timeout execution inputs early (missing prompts fail with a clear error, not a TypeError).
- Parse unterminated final stream records before handling process failures so retry safety sees real agy activity and terminal progress is preserved.
- Enforce `timeout_ms` across setup, preflight, and the agy process instead of adding an unconditional grace period.
- Preserve legacy `tier` selection in execution details and when configured default-model commands are present.
- Serialize session-store writes across independent Pi processes and ignore malformed history entries safely.
- Refresh model aliases from the live `agy models` catalog during preflight; newest generation wins, static map stays as fallback.
- Count per-directory lock wait toward the call timeout so queued runs cannot silently exceed their budget.
- Retry once when agy fails with a transient error (rate limit, network) before emitting any progress.
- Add an `effort` tool parameter passed through to `--effort`.
- Pass `--disable-slash-commands` so task text never triggers agy slash/skill expansion.
- Add optional `agy-config.json` with `skipPermissions`, `defaultModel`, and `defaultModelCommand` (quota/usage-aware default resolution); record `permissions_skipped` in tool details.
- `/agy continue`, `/agy timeout=10m`, and `/agy sessions` conversation picker; status updates throttled.
- Session store keeps up to 10 recent conversations per directory.
- Bound verify-command detection at the repository root; recognize `.justfile`, check the `just` binary, and add `uv run pytest` detection.
- Accumulate stream-json results regardless of whether a progress callback is attached.

## Post-review fixes prior to 0.5.0 (sonnet cross-review of b87019f + c65bb4a)

- Parse only stdout when refreshing the model catalog — stderr diagnostics can no longer pollute alias resolution.
- Numeric-aware model comparison so `claude-sonnet-4-10` sorts above `claude-sonnet-4-6`.
- Retry eligibility now requires real agy activity (tool steps / model responses); session-start chatter no longer suppresses the transient retry.
- The timeout budget starts before config/default-model resolution so a slow resolver cannot eat into it unaccounted.
- `agy-default-model.sh` no longer double-counts the latest conversation when the store has both legacy `last_*` fields and `history` entries.
- Cover extension registration and `/agy` argument completions in tests.

- Keep sandbox runs behind agy permission checks instead of bypassing them.
- Make streamed result statuses visible in progress updates.
- Preserve clean successful responses when agy emits stderr diagnostics.
- Allow queued calls to cancel without blocking later runs in the same directory.
- Accept explicit `/agy accept-edits ...` mode prefixes.
- Preserve multiline prompt formatting in `/agy` command arguments.
- Include staged files in postflight change summaries and preserve response endings when truncating output.
- Serialize session-store updates, write atomically, and keep conversation IDs in a private file.
- Resolve the Agy session store from `PI_CODING_AGENT_DIR` instead of always using `~/.pi/agent`.
- Detect `Justfile`, package `ci` scripts, and npm/pnpm/yarn/bun runners for verification.
- Ignore non-object JSON lines in streamed agy output safely.
- Keep direct `agy_execute` calls implementation-oriented with `accept-edits` as the default; use `plan` explicitly for review.

## 0.4.0

- Fork from `@bacnh85/pi-agy` 0.3.1 into dotfiles local package.
- Stream agy progress via `--output-format stream-json` and Pi `onUpdate`.
- Add `conversation_id`, `continue`, `new_session` for multi-turn handoffs.
- Persist last conversation per workspace in `~/.pi/agent/agy-sessions.json`.
- Detect `just ci` for verify-loop injection (falls back to `npm test`).
- Append git diff summary after `accept-edits`.
- Cache preflight health/connectivity checks for 5 minutes.
- Serialize concurrent calls per working directory.
- Add human-callable `/agy [plan|sandbox] [model] <prompt>` TUI command with model autocomplete.
- `/agy` wizard UX: interactive mode select, model select with descriptions, multi-line task editor, accept-edits confirmation.
- `/agy` executes agy directly after confirmation: progress uses the status bar and the final response is notified without a second LLM turn.
