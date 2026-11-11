# Design review

## Verdicts

- **007 — APPROVE**
- **008 — APPROVE**

## 007 — bridge diagnostics

No blocking or actionable findings. The report is explicitly design-only and does not claim that the proposed probe is implemented or proven (`plans/evidence/007-bridge-diagnostics-design.md:49`, `:88`, `:99`).

It satisfies the requested scope:

- The evidence matrix covers passive-state gaps, intentional empty catalogs, exact catalog comparison, fresh-client initialization, park-handler failure, cancellation, timeout, and cleanup (`:5–22`).
- It distinguishes builtin and dynamic tools and rejects the small fingerprint as catalog attestation (`:22`).
- The selected interface is one test-only opt-in gate, while `/agy doctor` remains passive and zero-inference (`:25–32`, `:101–105`).
- The proposed path uses the production registration/projection/bridge/phase adapters, an isolated owned bridge, a fixed synthetic marker, two fresh clients, explicit ownership, cancellation, cleanup, and a monotonic ten-second budget (`:34–49`, `:52–70`).
- The proof boundary correctly excludes real agy discovery, model selection, model tool calling, arbitrary user tools, and production network health (`:72–75`).
- Acceptance tests include empty catalogs, missing/stale definitions, handler failure, reconnect, live-suspension non-interference, cancellation/deadline, cleanup, and an argv-recording no-inference guard (`:78–88`).
- Later file scope and open implementation seams are identified without presenting them as completed work (`:90–109`).

The inherited baseline is correctly labeled as component evidence rather than evidence that the combined diagnostic exists (`:111–115`). No factual correction is required.

## 008 — native provider usage

No blocking or actionable findings. The report correctly identifies the existing loss of usage after the driver and the character-length fallback, while treating the design as unimplemented (`plans/evidence/008-provider-usage-design.md:3`, `:20–25`).

It satisfies the requested scope:

- Provenance follows wire envelopes through accumulator, driver, runner, and Pi boundary, and explicitly notes that `step_update.usage` is not currently accumulated as native usage (`:5–25`).
- The official headless protocol is used for the supported claims: session-cumulative usage across stdin turns and per-step usage; examples are not used to infer inclusivity (`:8–19`). Cache/input overlap, thinking/output inclusion, total semantics, resume continuity, version coverage, cache-write, and pricing remain explicitly unresolved where appropriate (`:17–19`, `:138–143`).
- The proposed flow forwards provenance, validates once at the Pi boundary, and separates baseline/epoch ownership from text streaming (`:27–31`).
- The mapping covers every native and Pi field, including reasoning as a subset, cache-write unknown, structural zero versus measured zero, unpriced cost, and native total as evidence rather than an assumed Pi total (`:33–46`).
- Invalid, fractional, negative, nonfinite, unsafe, string, overflow, and inconsistent values have explicit policies; unavailable is not represented as measured zero (`:48–57`).
- Phase accounting prevents step/terminal and repeated-terminal double counting, handles warm turns, parks, aborts, timeouts, failures, and unknown baselines (`:59–70`).
- The two-park arithmetic is clearly conditional synthetic arithmetic: native delta 75 is not confused with conditional Pi total 125, and the report states that no real mapping may be enabled without the blockers being resolved (`:72–89`).
- Acceptance cases cover the requested full, absent, zero, invalid, Unicode, streamed/terminal, multi-park, abort/timeout, failure, mismatch, warm-turn, and peer-compatibility cases (`:105–124`).
- File-level handoff and implementation blockers are explicit, with no speculative pricing or native semantic claim (`:126–143`).

The inherited all-fixes006 results are reused and labeled as baseline verification, not native-semantic proof (`:145–147`). No factual source correction or missing requirement was found.

## Review boundary

This was one bounded read-only review. No source, tests, manifests, configuration, plans, or reports were modified; only this review file was written. The accepted all-fixes006 verification record was reused rather than rerunning completed gates.
Draft line references are retained from the review. Final approval banners and a clarification distinguishing passive metadata probes from provider startups do not change the reviewed recommendations.


---

# Final narrow design recheck

## Verdicts

- **007 — APPROVE**
- **008 — APPROVE (prior approval remains applicable; unchanged semantically)**

## 007 recheck

No remaining actionable findings.

The clarification is feasible against the accepted baseline's existing seam: `extensions/lib/spawn.ts:29–30` exposes `getSpawn()` through the CommonJS `node:child_process` boundary, while `extensions/lib/provider-driver.ts:377–420` obtains the child through that boundary and consumes the ordinary stdin/stdout/stderr/event/close contract. The proposed in-memory ChildProcess-shaped transport therefore exercises the real driver path without requiring an OS `agy` process. Its required kill/close behavior is compatible with the existing cleanup path in `extensions/lib/spawn.ts:45–77`.

The current report now makes the important distinctions explicit:

- Intercepted `agy` launch/protocol traffic is labeled simulation and recorded separately from actual OS launches (`plans/evidence/007-bridge-diagnostics-design.md:34–38`, `:86`).
- Actual OS launch is restricted to the known Node supervisor/worker, with fail-closed process fences and no native fallback (`:38`, `:86`).
- The isolated worker runs the real registration, default driver, bridge, park, and delivery path; its memoized registries and lazy bridge are fixture-owned and closed before exit (`:42–49`, `:52–63`).
- A static fake runner is explicitly rejected as insufficient (`:41`, `:49`).
- Passive doctor metadata probes remain distinct from provider-resource creation, and the default doctor contract is not overstated (`:27–32`, `:78`).
- The report continues to state that the sequence is proposed, not implemented or executed, and preserves the synthetic/no-real-agy proof boundary (`:41`, `:72–75`).

No unsupported health claim or ambiguity between intercepted simulated requests and real processes remains. The exact-catalog, ownership, cancellation, ten-second budget, cleanup, fresh-client, and no-inference requirements remain covered by the prior review.

## 008 confirmation

The prior **APPROVE** remains valid. The requested semantic constraints remain satisfied: official documentation is used only for session-cumulative/per-step scope, cache/thinking/total inclusivity remains explicitly unknown where unverified, the native total 75 versus conditional Pi total 125 example remains clearly conditional, and no synthetic fixture is presented as proof of real native semantics. The stable-fake-session identity and approval-banner additions do not alter that assessment.

## Review boundary

This was a bounded read-only recheck. No source, plan, report, tests, installs, inference, agents, worktrees, credentials, or completed gates were touched or rerun. Only this review output was written.