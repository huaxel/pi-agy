# Native provider usage — design complete; implementation unstarted

**Review: APPROVE.** [Independent read-only design review](007-008-independent-design-review.md). B1–B4 below block a later implementation where indicated, not completion of this design.

The goal is truthful token accounting, not a better character heuristic. No production/test/config/dependency changes are made by this report. Some semantic prerequisites below deliberately block implementation of a real native mapping, not completion of this design.

## Provenance

Evidence inspected on2026-11-11:

1. Accepted all-fixes006 tree: `extensions/lib/stream.ts::AgyUsage/AgyStreamLine/AgyRunResult/accumulateRunResult`, `provider-driver.ts::ActiveTurn/ProviderDriverOutcome/settleDone/settleError`, `provider.ts::ProviderTurnResult/toRunEnd/createAgyStreamSimple`.
2. Installed locked development peer `@earendil-works/pi-ai` **0.87.1**, `dist/types.d.ts::Usage/AssistantMessage`, `dist/utils/diagnostics.d.ts::AssistantMessageDiagnostic`, and `dist/api/google-generative-ai.js` usage mapping. The peer declares reasoning as a subset of output; its Google adapter subtracts cached input from prompt input and includes thinking in output. These prove the **destination convention**, not agy's native convention.
3. Official [Antigravity headless documentation](https://antigravity.google/docs/cli/headless.md), fetched directly with HTTP200, not merely a search summary. Its sections “Streaming JSON”, “Stream prompts from stdin / Read the results”, and “Common mistakes” are primary protocol evidence. Public search/third-party adapters were leads only; none are authority for numeric inclusivity.
4. Official [Model quotas /usage documentation](https://antigravity.google/docs/cli/commands/usage.md), fetched directly with HTTP200, describes quota refresh, not a token-bucket mapping. It does not settle thinking/cache inclusivity or pricing.

Current path: top-level JSON or nested result usage object → structurally cast `AgyRunResult.usage` → retained on driver turn → **dropped** from `ProviderDriverOutcome`/`ProviderTurnResult` → provider increments `output.usage.output` by live `delta.length`. Terminal-only answers can therefore report0, and characters are mislabeled tokens.

`step_update.usage` exists in the type, but `accumulateRunResult` currently observes step subagents, not step usage. Do not claim all native usage events already flow through the accumulator. Raw usage objects currently receive no finite/nonnegative/integer validation. Existing parser tests are not proof of native bucket semantics.

No personal raw conversations, credentials or new inference runs were used. Current public documentation is not a version-pinned guarantee for every CLI version supported by this extension; seeB3.

## Native semantics

**Verified from the official page:**

- `step_update.usage` is described as “Per-step token usage, when known”.
- Each stdin prompt emits its own terminal result, but the metadata table says `response` belongs to that turn while **`usage`, `num_turns`, `duration_seconds` are cumulative over the session**.
- This falsifies the tempting approach “attach the whole native result snapshot to each terminal Pi user turn”. It double-counts earlier native turns even if intermediate toolUse phases report zero.

**Not verified by the consulted primary contracts:**

- Whether native `input_tokens` includes cached reads; B1.
- Whether native `output_tokens` includes thinking; B1.
- Exact `total_tokens` inclusivity relative to caching/thinking; B1.
- Whether counters retained across a new process using `--conversation` continue, reset or otherwise change their baseline; B2.
- Per-model/version guarantees and partial/error snapshot completeness; B3.
- A native cache-write/retention field or verified price source; report it unavailable/unpriced, not inferred.

Official examples constrain interpretation but are not an explicit numeric definition: one step has input278, cache_read30214, output4 and total282. Several totals equal input+output without adding the separately shown cache/thinking values. Do not infer a universal formula or detect inclusivity by choosing whichever arithmetic happens to fit one sample. In particular, do not copy Google SDK field semantics directly into agy's similarly named fields.

## Proposed data flow

Forward optional **raw evidence with provenance**, not a prematurely normalized `Usage`, through driver outcome and runner result. An extension-owned snapshot should distinguish source (`terminal-session`, `top-level-json`, `step`), conversation identity, driver process generation, native-turn ordinal, CLI version/mode, and validation/semantic-profile status. Do not dump raw payloads into logs/diagnostics.

Normalize exactly once at the Pi boundary, independent of text callbacks, after selecting the completed phase result. Keep existing text/stop-reason behavior from005/006. Remove character-as-token increments only in the subsequent implementation.

Recommended accounting state per driver generation: known session-counter baseline or `unknown`, committed native-turn id, latest validated terminal snapshot and status. `runTurn` starts a native user turn; `continueTurn` resumes that SAME native turn after a park and must not reset its usage ownership. Conversation id alone is not sufficient across process recycling.

For a documented fresh stateless session and supported semantic profile, baseline may start at known0. For an externally resumed conversation or unverified cross-process continuity, the first cumulative terminal snapshot **primes** a baseline but must not be charged as though its whole history were this turn. Mark that turn unavailable. Subsequent valid same-generation snapshots can be differenced. Do not reset counters to0 simply because a new Pi message or new OS process exists.

A later implementation should use an explicit version/mode-qualified semantic profile, not number-fitting guesses. UntilB1/B3 are resolved, retain required numeric placeholders and an unavailable/semantic-unverified diagnostic rather than implementing a speculative native mapping.

## Field mapping

The following rules are conditional on a verified profile and a known same-scope cumulative baseline. Validate raw snapshots first, calculate nonnegative per-turn deltas, then map those deltas. No formula in this table asserts unverified current agy inclusivity.

| Native/derived field | Pi field | Preconditions / fallback |
|---|---|---|
| input_tokens delta | input | If native input excludes cache, use delta directly; if it includes cache, subtract validated cache_read delta. Profile must state which; otherwise unavailable, structural0. |
| output_tokens delta | output | If it includes thinking, use directly; if it excludes thinking, add validated thinking delta. Profile must establish this; otherwise unavailable. |
| thinking_tokens delta | reasoning? | Only when its relation to mapped output is verified and0≤reasoning≤output. It is a subset, never added again to Pi total. Missing remains undefined; explicit measured0 remains0. |
| cache_read_tokens delta | cacheRead | Only with verified input/cache overlap and scope. Never count it twice. Missing is structural0 plus unavailable provenance. |
| No verified native cache-write field | cacheWrite | Required structural0, explicitly unavailable, not measured0. Do not invent `cache_write_tokens` from third-party examples. |
| No verified retention split | cacheWrite1h? | Omit; never fabricate an Anthropic-specific split. |
| Validated mapped components | totalTokens | Sum input+output+cacheRead+cacheWrite only when their disjointness is established; otherwise structural0/unavailable. Unknown components must be disclosed. |
| Native total_tokens | Internal consistency evidence | Validate/delta it but do NOT blindly assign it to Pi total or use it to guess overlap. Check only against the formula explicitly documented by the chosen profile. |
| Any native token count / quota fraction | cost.input/output/cacheRead/cacheWrite/total | Required zeros with explicit `unpriced`; no inference of dollars, rates or free usage. |

A field/status record distinguishes measured, unavailable, invalid, baseline-unknown and semantic-unverified. Partial available evidence may be displayed diagnostically, but the default numeric export is conservative: do not expose a “verified total” while a bucket/overlap is unresolved. Whether to expose partially measured component totals later is an implementation decision requiring explicit UI labeling, not a silent fallback.

## Missing and invalid data policy

- Accept only object records and own recognized fields whose values satisfy `typeof n === 'number'`, `Number.isSafeInteger(n)` and `n >= 0`. Canonicalize -0 to0. Reject numeric strings, fractions, negative/nonfinite/unsafe values, arrays, null and booleans; do not coerce, round or clamp token counts.
- A missing field is not measured0. An explicit valid0 is measured0; do not classify an all-zero native snapshot as absent merely because it is zero.
- Validate aggregate arithmetic for safe-integer overflow. A negative cumulative delta signals reset/regression/epoch mismatch, not a billable negative count; invalidate/re-prime the baseline, mark current attribution unavailable, and never silently clamp to0.
- Inconsistent explicit totals produce a diagnostic only relative to a **verified** profile's total definition. A native total that excludes cache is not invalid merely because Pi's disjoint component sum includes it. When no definition is verified, label `total-semantics-unverified`, not `inconsistent`.
- Keep native structural validation provider-local; do not rewrite delegation usage parsing as an incidental change. Preserve field provenance through partial/error paths without emitting raw objects.
- When attribution is unavailable, Pi's required input/output/cacheRead/cacheWrite/totalTokens and cost fields are0 placeholders; omit optional reasoning. Surface `usage unavailable` and `unpriced`, not “0 measured tokens” or “free”. Missing usage must not change text or stopReason into an error.

**Supported visibility:** inspected Pi0.87.1 has typed `AssistantMessage.diagnostics?: AssistantMessageDiagnostic[]` with `{type:string,timestamp,error?,details?:JsonObject}`. A proposed typed diagnostic `type:'agy_usage_accounting'`, details `{status,reason,pricing:'unpriced',scope}` fits this contract; no new untyped event property is necessary. Do not assume older declared-compatible peers support it: B4 must be checked before emitting it across that range. In all cases keep an extension-owned usage-status snapshot for `getProviderStatus`/doctor and document numeric placeholders; do not misuse errorMessage to imply a failed answer.

## Phase accounting

1. Intermediate Pi `toolUse` phases export zero/unavailable metrics and status `pending-native-terminal`; no native session snapshot is committed or counted there.
2. Terminal success obtains the final cumulative session snapshot. Subtract a known same-generation baseline ONCE for that native user turn, normalize under a verified profile, and commit the new baseline atomically with accounting ownership. Repeated delivery of the same native-turn terminal snapshot must not charge twice.
3. Multiple parks belong to that same native user turn. Do not sum per-step ACTIVE/DONE snapshots or add them to the terminal snapshot. The official per-step counters do not share terminal cumulative scope.
4. A subsequent user turn in the same warmed process uses the last committed session baseline; do not attach the entire lifetime cumulative count again.
5. A new process, restored conversation, counter regression, model/profile change or unverified epoch requires fresh baseline qualification. A process recycle is not evidence of numeric zero.
6. Abort/timeout without a terminal snapshot: preserve partial text/flags and mark native usage unavailable. Current step-only evidence is not complete turn evidence; do not sum it to fabricate totals. A later separately proven partial-step accounting scheme would need deduplication and coverage guarantees.
7. Failed terminal envelopes: preserve failure precedence. Retain validated evidence diagnostically; do not fabricate a successful done message to expose metrics. A later typed error-evidence path may populate verified usage only if the same baseline/normalization rules hold; otherwise keep placeholders and status.

### Conditional worked example: two parks, no double-counting

This is **synthetic arithmetic, not proof of agy's real inclusion rules**. Assume a profileE where input excludes cache, output includes thinking, native total excludes the separately reported cache, no cache writes occur, and all counters are session-cumulative. Those assumptions still requireB1/B3 before real implementation.

Known prior-session baselineB: input100, output20, cacheRead300, thinking5, nativeTotal120. Current finalF: input160, output35, cacheRead350, thinking8, nativeTotal195. Deltas are input60, output15, cacheRead50, thinking3 and nativeTotal75. Pi output already includes thinking3; never add it twice. Under this explicit fixture profile, Pi's disjoint turn total is60+15+50=125, not raw nativeTotal75.

| Pi phase | input | output | cacheRead | reasoning | totalTokens |
|---|---:|---:|---:|---:|---:|
| First park |0|0|0|omitted|0|
| Second park |0|0|0|omitted|0|
| Terminal, once |60|15|50|3|125|
| Sum for this native turn |60|15|50|3 subset|125|

Previous normalized session total was420; final normalized cumulative total would be545. Emitting125 now gives420+125=545. Emitting the full545 snapshot now would produce965 and double-count the previous session. The no-cache-write assumption belongs only to this synthetic example; production does not have evidence that an absent cache-write field means measured0.

If no known baseline/profile exists, this same rawF is NOT enough to export those numeric125 tokens: emit placeholders, prime the raw baseline as appropriate, and mark unavailable. A hypothetical delta-reporting CLI profile would use documented deltas instead; it must never be selected automatically by numeric resemblance. The consulted current official stdin protocol is session-cumulative.

## Acceptance tests

Proposed future fixtures/assertions; no tests are edited by this report:

1. Full native cache/thinking fields: under explicitly declared synthetic profileE and baselineB, expect the worked delta60/15/50, reasoning3,total125 exactly once. Label the fixture conditional, not native empirical proof.
2. Absent usage: all required numeric fields/cost0, reasoning omitted, unavailable diagnostic; no text-length fallback.
3. Measured zero versus missing: explicit valid zero snapshot is measured-zero if baseline/profile known; absent object is unavailable. Status differs even if structural fields equal.
4. Invalid values: arrays/null/strings/negative/Infinity/NaN/fractions/unsafe integers rejected without coercion; sum overflow rejected. Wire JSON's inability to encode NaN is not a reason to skip normalizer unit validation.
5. Unicode/text corrections: identical native inputs with ASCII, emoji, different delta splits or authoritative terminal correction yield identical metrics. Preserve005 content.
6. Terminal-only versus streamed answer: same native snapshot/baseline/profile yields same usage in real pi-ai `text_end`/done/result flow.
7. Two parks and terminal: intermediate phases0/unavailable, one terminal delta; summing Pi totals equals125 only under the declared fixture profile. Duplicate terminal commit is ignored/diagnosed, not charged twice.
8. Abort/timeout: no terminal snapshot yields unavailable usage with unchanged006 settlement and partial flags. Partial step snapshots are not silently summed.
9. Terminal failure: same error/denial precedence, no false successful done; optional usage evidence remains diagnostic unless attribution verified.
10. Explicit total mismatch: reject only contradictions to a verified profile; profileE's raw75 versus Pi125 is not inherently a mismatch.
11. Warmed second user turn: delta current-minus-prior, not full cumulative snapshot; model/process/epoch reset invalidates baseline. First resumed-process snapshot with unknown baseline is not charged as the whole historical conversation.
12. Peer compatibility/visibility: current0.87.1 typed diagnostics compile and contain only sanitized JSON; declared minimum-peer contract must be verified separately. No extra untyped event property, raw payload or invented cost.

Use existing parser, controlled driver, provider recording and real event-stream layers; no new test framework or inference workload. The current persistent fake generates `conv-$n` on fresh process input rather than keeping the official stdin protocol's stable conversation id. Extend future usage fixtures with an explicitly stable session identity and controlled cumulative snapshots; do not mistake existing fake numbering for native semantics or use a changing id to hide double-counting. Expected real-native normalized numbers remain blocked until the relevant profile is documented.

## File-level implementation outline

- `extensions/lib/stream.ts`: optional typed provenance/terminal counter metadata if needed; do not globally reinterpret delegation usage or claim step accumulation already exists.
- `extensions/lib/provider-driver.ts`: carry optional native evidence, generation/native-turn identity and baseline ownership; retain005 cap and006 waiter lifecycle. Preserve valid evidence on failure through a narrowly typed internal path if approved.
- `extensions/lib/provider.ts`: forward evidence in `ProviderTurnResult`/runner adapter; normalize once at final Pi boundary; remove delta.length accounting; zero intermediate toolUse metrics; expose sanitized status/typed diagnostics only under verified peer contract.
- A small provider-specific pure normalization module may be justified in a later plan; no broad accounting subsystem is needed. `doctor.ts` can render internal usage availability/pricing status without changing message success.
- Future tests: stream provenance/validation fixtures, driver counter lifetime, provider phase/delta/real-result checks. Keep permissions, quotas, model selection and pricing discovery unchanged.

## Decisions and blockers

**Decided:** native protocol evidence over character estimates; terminal ownership with session differencing, not direct lifetime snapshots; no step+terminal sum; explicit unavailable versus measured-zero; finite-safe-integer validation; unpriced cost; no new production behavior in this design.

- **B1 — blocking real bucket normalization:** obtain a versioned authoritative definition of input/cache and output/thinking/total inclusivity. Consulted examples constrain but do not normatively establish it. Do not infer a formula from total arithmetic.
- **B2 — blocks first-turn attribution after external/process resume:** establish baseline/continuity for `--conversation` across process recreation. Default recommendation is prime-without-charge until a same-scope baseline exists.
- **B3 — blocks enabling a real CLI profile:** qualify the current documentation against supported CLI versions/modes and partial/error evidence completeness. The current docs establish session scope; they do not prove all deployed binaries share it.
- **B4 — blocks unconditional use of optional peer diagnostics/reasoning across the supported range:**0.87.1 is inspected; verify the package's older compatible peers before relying on optional fields. Keep internal doctor/documentation visibility instead of inventing a runtime feature-detection trick or silently raising peer requirements.

B1–B4 are implementation blockers, not reasons to fabricate estimates or to leave this design unfinished. Cache-write absence and missing price data reduce completeness; keep them visibly unknown/unpriced. Later implementation estimate:M including semantic qualification, normalization and lifecycle/peer tests; no implementation or delivery commitment is made here.

## Verification results

Reuse the unchanged accepted006 baseline: independent parser/doctor/MCP51/51, driver19/19, provider40/40, all-fixes330/330, typecheck/package dry-run exit0. Exact commands/hashes are in `plans/execution/006/independent-checks.json`; raw logs under retained006 `.pi/reviewer/`. Public documentation was fetched read-only; no inference, private sessions or newly generated native token sample was used. No source, tests, manifests, configuration or global settings changed. The conditional arithmetic above verifies only no-double-counting logic, not native semantic claims. Implementation remains unstarted.
