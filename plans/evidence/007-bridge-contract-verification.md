# 007 follow-up: `test:bridge-contract` gate verification

Recorded 2026-11-20 against the working tree that contains the uncommitted gate
(`package.json`, `tests/bridge-contract.ts`, `plans/007-...md`, `README.md`,
`CHANGELOG.md`, `plans/README.md`). Base commit `6c5ac83` on branch
`feat/doctor-provider-provenance`. macOS, Node 24.22.2, 10 cores.

This is the author's own verification pass, not an independent review. Nothing
was committed, pushed, or released.

## What the gate asserts

Runs `node --import ./tests/resolve-hook.mjs tests/bridge-contract.ts`. It loads
the production extension entry point, registers the provider, refreshes the
catalog through a stubbed `agy models`, and then drives one provider phase into a
tool park. A stubbed `spawn` returns an in-memory fake `agy` child whose only
input event triggers a simulated agy tool loop over the real loopback bridge.

| Claim | Assertion in `tests/bridge-contract.ts` |
|---|---|
| Provider registration happens | `assert.ok(provider)` after `piAgyExtension(pi)` |
| Catalog registration yields a model | `provider.getModels()[0]` present after a stubbed refresh |
| The runner passes its private bridge directory | `--add-dir` value must start with `<agentDir>/pi-agy-bridge` |
| Five builtins plus exactly one dynamic Pi tool | `listedA.tools.length === 6`, `diagnostic_marker` count `1` |
| The dynamic tool schema is forwarded intact | deep equal on the typebox-derived `inputSchema` |
| Self-delegation tooling is excluded | no `askantigravity` in `tools/list` |
| A tool call round-trips | fixed `diagnostic_marker` call returns `bridge-contract-ok` |
| A second fresh client initializes on the same bridge | client B connects, lists the same 6 tools and the same schema |
| The provider parks a real tool call | `stopReason === "toolUse"`, call name/arguments match the fixture |
| Resume settles with the delivered result | `stopReason === "stop"`, content contains the marker |
| No real process or OS API is used | `forbiddenLaunches` empty, every simulated launch is `agy` |

## Counts and timings

| Check | Result |
|---|---|
| `npm run test:bridge-contract` | exit 0, prints `bridge contract verified (synthetic local integration; no agy process or inference launched)` |
| Five sequential runs | 2.63, 2.56, 2.54, 2.60, 2.60 s (all exit 0) |
| Three runs under full CPU saturation (10 busy loops) | 3.10, 3.18, 3.06 s (all exit 0) |
| Internal budget | `TOTAL_BUDGET_MS = 10_000`, 2 s reserved for cleanup, so ~8 s of probe budget against ~1 s of measured work |
| `npm run gate` | exit 0 |
| `npm test` | 534/534, 72 suites, 0 fail/skip/cancel |
| `npm run pack:check` | exit 0, 48 package entries; `tests/` is not shipped |

The margin is roughly 8x at rest and 6x saturated. The gate has no fixed sleep
and no dependence on a live `agy` install, so the timing failure mode that plan
009 addressed does not apply to it.

## Non-vacuity evidence

A temporary copy (`tests/bridge-contract.mutation.ts`, deleted afterwards) with
`listedA.tools.length` expected as `7` instead of `6` failed with exit 1, so the
tool-projection assertion is live rather than skipped.

That mutation also exposed a diagnostic weakness: the simulated loop's failure was
written to the fake child's `stderr` and closed it with code 1, so the provider
phase failed first on `stopReason` and the actual message ("expected five bridge
builtins plus the selected Pi tool") never appeared in the report. The gate now
records the loop failure, rethrows it ahead of the downstream provider assertion,
and logs it, so the mutant report leads with the real cause.

## Proof boundaries

- Proves: production registration, active-tool projection, the loopback MCP
  transport built in `extensions/lib/mcp-transport.ts`, a synthetic park/result,
  resume settlement, and a second fresh client on the same bridge.
- Does not prove: that a real `agy` child connects, discovers a model, selects the
  bridged tool, or answers a turn. Those remain the territory of the billable
  `test:bridge` and `test:provider` runs.
- Not run here: Linux CI, Windows, a `npm ci` clean-install graph, or any
  independent review.

## Open decisions

1. **CI wiring.** The gate is deliberately not part of `npm test` (`tests/*.test.ts`
   glob) and takes ~2.6 s, so adding one step to `.github/workflows/ci.yml` and the
   publish `verify` job would cost little and stop it from rotting silently. It
   cannot be enabled before the file is committed, so this is a post-commit choice.
2. **CHANGELOG shape.** The entry sits under a new `## Unreleased` heading, while
   earlier project practice logged only released versions. Folding it into the
   next release section is equally acceptable.
3. **Independent review** of `tests/bridge-contract.ts` is still outstanding, as is
   any release decision.
