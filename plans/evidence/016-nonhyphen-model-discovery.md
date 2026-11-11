# Argon model discovery fix — 016

> Historical parser-only checkpoint. User clarified that automatic full catalog
> refresh was required too; [017](017-automatic-model-refresh.md) implements and
> verifies the native startup/picker refresh path. Its evidence supersedes the
> one-time discovery behavior and release-pending status described below.

## Diagnosis and current result

User reported missing provider models, specifically **argon**.
At HEAD ed9adcc, direct parser probes returned no entries for both
`argon` and `argon\tArgon`: the existing model-ID regex required a hyphen.
This is a demonstrated parser defect, independent of account authentication.

The reviewed three-file correction is now applied to this checkout, uncommitted:
- `extensions/lib/provider-models.ts`: accepts generic lowercase nonhyphen IDs
  using the same first-whitespace-column interpretation as existing hyphenated IDs.
- `tests/provider-models.test.ts`: bare/tab/single-space/multiple-space rows,
  digits/underscore/dot IDs, exact model values and absent effort metadata;
  banner/header/auth/flag rejection remains tested.
- `tests/provider.test.ts`: fake discovery through the public registration API
  registers Argon; the original handler uses the refreshed catalog and sends
  exact `fullModel: "argon"` without a guessed effort flag.

No Argon hardcoded allowlist, fallback expansion, delegation-alias change,
authentication change or automatic refresh policy was introduced.

## Review and actual checks

Native Codex helper worked in retained
`/tmp/pi-agy-models-wiNyQQ/worktree`. Advisor reviewed the full diff and requested
one correction: nonhyphen rows must accept single spaces, not only tab/two spaces.
Both initial parser/public registration regressions failed before the fix;
the additional single-space regression failed before that correction.

Advisor independently ran these on the final isolated source and again after
original-checkout integration:
- Focused model/provider tests: **70/70 pass**.
- Full `npm test`: **457/457 pass**, no failures/cancellations/skips.
- `npm run typecheck`, `npm run pack:check`, source `git diff --check`: pass.
- All three integrated files byte-match the reviewed isolated source.
- Staging is empty; package metadata unchanged; no commit/push/publication.

Final test commands prepended the existing fail-closed agy guard and isolated
agent storage for advisor checks. Worker attempts that failed on local-listener
or npm-cache EPERM were rerun with approved local access; they are not counted
as passing gates. No inference was run. Runtime was Node26.13.0/macOS.
Logs: `/tmp/pi-agy-models-wiNyQQ/{advisor,integration}-{focused,tests}.log`
and corresponding pack JSON. Worker receipt:
`/tmp/pi-agy-models-wiNyQQ/executor-report.md`.

[Exact retained patch](../patches/016-nonhyphen-provider-models.patch).

## Live environment and remaining limits

Advisor observed installed Pi package **0.7.11** at
`/Users/juanbenjumea/dotfiles/pi/agent/npm/node_modules/@juanbenjumea/pi-agy`.
It is not a source link and was **not modified**. This fix is not yet released or
loaded into that installed copy.

The actual installed agy CLI reports **1.5.6**; `agy models` exited1 with
“Please sign in to view available models. Launch the CLI without arguments to sign in.”
Therefore no live account model inventory or actual Argon inference is verified.
The current extension silently keeps its three-model fallback on discovery
failure and only attempts startup discovery once. After authentication succeeds,
reloading the extension retries discovery; the unchanged installed0.7.11 parser
will still omit Argon until this fix is installed.

Unstructured output cannot perfectly distinguish arbitrary lowercase prose from
bare IDs. The fix conservatively rejects known diagnostic/header tokens and
uppercase nonhyphen labels; it does not promise support for every possible
future slug syntax. Existing Gemini effort grouping and fallback policy remain
unchanged. This is a narrow causal fix, not a claim that all live account models
are now verified.
