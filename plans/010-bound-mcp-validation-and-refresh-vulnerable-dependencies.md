# Plan 010: Bound bridge validation and refresh vulnerable dependencies

> **Execution and subsequently authorized local application are complete.** After the planning-only phase, the user explicitly selected full plan 010 implementation, including the 10,000-element/64-container-level policy. The reviewed change passes 341 tests, typecheck and packaging. [Isolated execution and independent approval](evidence/010-input-budget-dependencies-review.md). The user then separately authorized applying the reviewed stack to the original checkout without dependency replacement; [that integration also passes341 tests/types/pack](evidence/010-original-checkout-integration.md). All source changes remain uncommitted; nothing pushed or published.
>
> **Executor instructions:** Use a fresh isolated worktree, preserve all accepted patches, follow each verification and STOP condition, and report actual evidence. Reviewer owns the index. No staging, commits, reset/clean, merges, publishing, live agy/model inference, personal credentials or destructive memory probes.
>
> **Drift check:** `git diff --stat 1bf9d29..HEAD -- package.json package-lock.json extensions/lib/provider-mcp.ts extensions/lib/bridge-input-budget.ts tests/provider-mcp.test.ts tests/bridge-input-budget.test.ts README.md`; inspect uncommitted prerequisites too. Compare the source excerpts below before editing.

## Status

- **Priority:** P1 — vulnerable dependency graph; specific amplification reachability unresolved
- **Effort:** M, including dependency qualification, input-boundary tests and review; not a delivery commitment
- **Risk:** MED — dependency resolution and deliberate rejection of overly complex tool inputs
- **Depends on:** approved 001 investigation and accepted all-fixes 002+003+004+009+005+006 stack
- **Category:** security / dependencies
- **Planned at:** `1bf9d29eaf0b56363ae7f62893670efe3eebeee3`, 2026-11-11, plus the accepted uncommitted stack
- **Execution:** COMPLETE — independently APPROVED in `/tmp/pi-agy-010-_jvae0qg/worktree`; 341/341 tests, typecheck, packaging and installed-consumer smoke pass

## Why this matters

The locked bridge still uses SDK 1.31.0 and Zod 4.6.5. Authenticated loopback input reaches SDK/Zod validation after a 1 MiB body limit; that limits bytes, not the number/depth of containers or validation work. Current advisories require patched dependencies and a deliberately enabled input bound. This project uses the SDK's low-level `Server`, so copying the advisory's high-level `McpServer` option would not protect its current path.

The desired outcome is a qualified patched repository graph plus a separately acknowledged defensive bound before this bridge delegates parsed input to SDK validation. Generic validation reachability is not proof that the advisory's specific constrained-collection amplification is reachable here. Do not promise general DoS immunity or a patched dependency graph for every external consumer.

## Current evidence and source

### Fresh audit and registry evidence

On 2026-11-11, `npm audit --omit=dev --json` was rerun read-only in the accepted 006 worktree under Node 22.23.4/npm 10.9.9, minimal `env -i`, private HOME. Exit 1: **8 vulnerable package entries: 3 high, 5 moderate, 0 critical**. Counts are package-entry severities, not unique/reachable advisory counts. Manifest and lock hashes did not change.

Raw audit/registry evidence: accepted 006 `.pi/security-010/`; research metadata `plans/execution/010/research.json`. Previously accepted 330-test/typecheck/package evidence remains applicable to the **unchanged old graph**, not to a future upgrade; do not rerun it merely to write this plan or substitute it for upgraded-graph verification.

| High advisory | Current fixed guidance | Bridge/API disposition |
|---|---|---|
| [SDK validation amplification GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453) | SDK >=1.32.0; advisory explicitly says upgrading alone does not enable its high-level bound | SDK validation is on path; residual exposure remains unresolved. Own pre-SDK budget is the recommended local control. |
| [Zod collection validation GHSA-mrhx-c7xc-m3w5](https://api.github.com/advisories/GHSA-mrhx-c7xc-m3w5) | Zod >=4.6.6 | Vulnerable package and SDK parsing path present; no exploitability/heap-exhaustion experiment was run. |
| [SDK experimental tasks GHSA-22jm-h49p-29qw](https://github.com/advisories/GHSA-22jm-h49p-29qw) | SDK >=1.32.0 | No `taskStore` is supplied by the bridge; vulnerable API not configured. Upgrade still removes package exposure. |
| [body-parser GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) | body-parser >=2.4.0 | Transitive SDK/Express package; reviewed bridge uses its own Node HTTP reader, not body-parser. Refresh within SDK closure; do not claim this API is reachable merely because installed. |

Registry checks succeeded for SDK **1.32.2** (current latest 1.x) and Zod **4.6.7**. SDK 1.32.2 requires Node >=18 and still declares Zod **`^3.25 || ^4.0`**: an SDK upgrade does **not** guarantee a patched Zod for all consumer resolution graphs. [npm's override rule](https://docs.npmjs.com/cli/v10/configuring-npm/package-json/#overrides) says only the consuming project's root overrides are considered, not overrides in installed dependencies. Do not add an otherwise unused direct Zod dependency and claim that it forces the SDK's nested resolution everywhere. A published shrinkwrap is a possible different strategy, but changes dependency ownership/lock policy and requires separate review; do not introduce one implicitly.

Moderate entries remain individually triaged, not new remediation scope: `@hono/node-server`, Hono, fast-uri, ip-address and qs. The Node Hono adapter IS used by the SDK transport; its flagged static-file API is not used here. SDK bearer/OAuth client advisories concern APIs not used by this production bridge; tests do use SDK clients against their own loopback fixtures. Recheck the refreshed graph and document dispositions; do not chase unrelated zero-audit counts or upgrade the whole application.

### Relevant actual APIs

`package.json` has one runtime dependency: `"@modelcontextprotocol/sdk": "^1.31.0"`; Zod/body-parser are transitive. `package-lock.json` pins SDK 1.31.0, Zod 4.6.5, body-parser 2.3.0. Lock SHA-256 is `3b1191b639bc509d09b13f9d6356a9d4df76a1f17001e0e85aad221832479d27`.

`extensions/lib/provider-mcp.ts` imports:

```ts
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
// ...
const mcp = new McpServer(
  { name: "pi-agy-bridge", version: "1" },
  { capabilities: { tools: {} } },
);
```

The alias is the **low-level Server**, not `server/mcp.js::McpServer`. Inspection of installed SDK 1.32.2 confirms `maxToolInputElements` belongs to the high-level `McpServerOptions`/tool-validation path, not low-level `ServerOptions`. Do not migrate servers or pass an unsupported option just to satisfy an advisory snippet.

Accepted 006 `provider-mcp.ts::handleBridgeRequest` checks route/method, constant-time `x-pi-agy-token`, then localhost Host **before** this POST sequence:

```ts
const { body, tooLarge } = await readBody(req);
if (tooLarge) { /* existing413/connection-close path */ return; }
if (body === undefined) { res.writeHead(400).end(); return; }
const resolved = await resolveTransport(req, body);
// session allocation/connect can happen in resolveTransport
await resolved.transport.handleRequest(req, res, body);
```

`readBody` counts UTF-8 bytes and parses JSON only inside the existing 1 MiB cap. Put the new structural guard after successful parsing but **before `resolveTransport`**, not merely before a parked-tool callback.

The locked SDK's `types.js:1328–1344` defines `CallToolRequestParamsSchema.arguments` as `z.record(z.string(), z.unknown()).optional()`. The bridge registers low-level ListTools/CallTool handlers; it does not use the higher-level per-tool array/record-schema validation described by the SDK advisory. This supports a narrower claim: the graph is vulnerable and SDK validation is reachable, but the particular amplification preconditions have not been established for this bridge. The proposed guard is defense-in-depth, not a reproduced-exploit fix.

SDK 1.32.2 `webStandardStreamableHttp.js` uses `options.parsedBody` directly when supplied; `maxRequestBodySize` only bounds its own reader in the other branch. Thus setting that transport option is not a substitute for this custom reader/guard. Low-level `Protocol.setRequestHandler` still validates through `parseWithCompat`. Preserve authentication/Host order and byte limit.

## Recommended design and policy

1. Raise the direct SDK floor to **`^1.32.2`**, staying on 1.x; qualify the repository's production Zod resolutions at **4.6.7+** and body-parser at **2.4.0+** through a targeted lock refresh.
2. Retain the custom 1 MiB reader and existing low-level server/session lifecycle. No high-level migration, v2 split-package migration, global Zod configuration or dependency vendoring.
3. Add a small pure, iterative JSON-structure guard used before any session resolution or SDK parsing.
4. Proposed policy: **10,000 total object properties plus array elements per parsed request body**, and **64 container levels**. These are proposed bridge product limits, not verified maxima of every user-defined Pi tool. Root container depth is 1; scalar leaves do not add container depth. Root scalar/null has 0 elements/0 container depth. Count the whole body, including wrapper metadata, not just `params.arguments`; string content is constrained by the existing byte cap, not counted character-by-character.
5. Reject over-budget POSTs with HTTP **413**, a short fixed non-sensitive error, and no session/park/tool allocation. Preserve ordinary malformed JSON 400 and existing SDK handling of under-budget invalid requests. Do not implement new batch semantics.

The values are deliberately concrete so the executor cannot invent policy. Before execution, obtain acknowledgement that huge/deep previously accepted structured inputs may be refused. Examine repository fixtures/supported tool shapes; if these values break known legitimate inputs, STOP for policy adjustment rather than silently raising them until tests pass. Large string-based file content within the byte cap should remain accepted.

The guard must stop as soon as a bound is exceeded, avoid recursion, and avoid flattening/serializing the full tree or expanding a huge child list before checking remaining budget. Fixed small counters and an explicitly bounded worklist are sufficient; no validation framework or generic middleware layer is needed.

## Scope

**Future executor may modify only:**

- `package.json` — SDK version floor only; no peer/engine/script changes
- `package-lock.json` — targeted SDK closure refresh, not unrelated Pi/dev/toolchain updates
- `extensions/lib/provider-mcp.ts` — call the local budget guard at the exact pre-resolution seam
- `extensions/lib/bridge-input-budget.ts` (new) — pure internal guard/constants, imported by the bridge
- `tests/bridge-input-budget.test.ts` (new)
- `tests/provider-mcp.test.ts` — bounded authenticated wire tests and prerequisite regressions
- `README.md` — concise documentation of the new input limits and consumer-resolution caveat
- ignored `.pi/` evidence in the assigned worktree; reviewer maintains `plans/README.md`

**Out of scope:** every other source/test/config/workflow file; SDK 2.x migration; enabling experimental tasks/OAuth/static-file servers; changing Pi permission policy or tool semantics; removing 005/006 fixes; model/quota/accounting/diagnostic feature implementation; global Zod behavior; application-wide dependency upgrades; publishing/committing/main integration.

## Git and execution baseline

Use a fresh detached task-owned worktree at `1bf9d29`, then apply accepted patches 002, 003, 004, 009, 005, 006 in that order. All are under `plans/patches/`; the last is `006-cancelled-resume.patch`. Approved source is retained at `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-006-yxx758z7/worktree`; treat it read-only. Snapshot/hash all tracked source, manifest, test, workflow and documentation files after applying prerequisites and before editing; preserve non-owned prerequisite bytes. Compare final files against that snapshot to enforce incremental scope. Raw `git diff` against HEAD also contains prerequisite edits, so it is not an incremental scope verdict. Export any remediation patch incrementally against that immutable accepted baseline. No staging, commit, merge, hard reset, clean or deletion of retained worktrees.

Commands run only inside the assigned disposable executor tree, with `env -i`, Node 22 PATH, private HOME/PI_CODING_AGENT_DIR under `.pi`. Node 22.23.4/npm 10.9.9 are available; no global runtime install. Use `--ignore-scripts` for dependency operations; STOP if a package requires enabling unreviewed lifecycle code. Never use `npm audit fix --force`.

## Commands you will need

These are future execution commands, **not upgrades performed during planning**.

| Purpose | Command / expectation |
|---|---|
| Target SDK floor | `npm install --package-lock-only --ignore-scripts '@modelcontextprotocol/sdk@^1.32.2'`; only intended manifest floor changes |
| Target transitive patch refresh | `npm update --package-lock-only --ignore-scripts zod body-parser`; verify actual graph, do not assume it worked |
| Reproducible install | `npm ci --ignore-scripts`; exit 0 in the executor tree |
| Inspect all relevant resolutions | `npm ls @modelcontextprotocol/sdk zod body-parser --all`; record paths/versions; production vulnerable copies must not be hidden by a patched root copy |
| Audit | `npm audit --omit=dev --json`; evaluate advisory identities/ranges, not only exit code/count |
| Focused | `node --import ./tests/resolve-hook.mjs --test tests/bridge-input-budget.test.ts tests/provider-mcp.test.ts tests/provider.test.ts tests/provider-driver.test.ts`; all pass |
| Gate | `npm test && npm run typecheck && npm run pack:check`; all pass, no skipped/cancelled tests |
| Scope | `git diff --check; git status --short; git diff --cached --quiet`; additionally compare final files with the immutable accepted-source snapshot, allowing only the listed incremental paths; staging empty |

If targeted npm commands retain vulnerable required resolutions, STOP and report the exact resolver result. Do not hand-edit integrity hashes or introduce root overrides/direct unused dependencies to manufacture a green audit. A broader dependency strategy requires review.

## Steps

### Step 1 — Establish the accepted baseline and capture qualification data

Verify hashes/patch composition without redoing unrelated audit work. Record the immutable accepted 330-test baseline and source hashes; if code/lock drifted, run the baseline gate and explain why. Read the fresh advisory evidence, installed SDK entry points and update candidates. Record production dependency paths using the actual lock and `npm ls`; audit baseline is8 vulnerable package entries, not a security pass.

**Verify:** snapshot and dependency-path report identify SDK 1.31.0/Zod 4.6.5 before updates; no source or prior-patch drift.

### Step 2 — Refresh narrowly, then inspect the resolved APIs

Update the SDK floor and targeted transitive graph using npm, install without scripts, inspect the lock diff and relevant SDK types/source. Confirm body-parser 2.4.0+ remains within its parent Express constraint; otherwise STOP rather than forcing resolution. Require SDK >=1.32.2 within1.x, repository production Zod >=4.6.7, body-parser >=2.4.0. Check that session/park cleanup and low-level server APIs remain compatible. Other transitive changes are allowed only as consequences inside the SDK closure and must be listed. Do not silently update Pi peers, TypeScript or Node support.

**Verify:** `npm ls ... --all`, exact lock metadata and fresh audit confirm target advisory versions are removed from the repository's production graph; typecheck passes. No claim is made that the upgrade alone activates an input-element bound.

### Step 3 — Add safe, test-first boundary controls

Add the pure guard tests before integrating it, then HTTP tests that exercise the real authenticated bridge. Run the new wire regression separately against the old path: it must not import a not-yet-created helper or count an import/setup failure as RED. Use bounded benign generated values, not malformed amplification/OOM payloads. A valid synthetic no-op tool can accept an oversized collection under the old code and return a fixed marker; the new expectation is 413 before SDK/handler work. Keep each generated wire case below 1 MiB and at most the proposed boundary+small overhead.

Required cases:

- Exactly 10,000 structural elements accepted; 10,001 rejected in pure tests, accounting explicitly for wrapper properties in wire tests.
- Container depth 64 accepted; 65 rejected; array/object/mixed chains and empty containers.
- A large UTF-8 string below the byte limit remains accepted; byte-over-limit behavior stays as before.
- Small mixed-tree differential tests: a transparent recursive test-only oracle, constrained to depth≤8/nodes≤100, versus the iterative production counter. Use a bounded deterministic shape grid, not an unbounded random generator or new dependency.
- Auth/Host failure remains 403 before structural validation; malformed JSON remains 400.
- Over-budget authenticated requests never reach a dynamic tool handler; public transport-prototype instrumentation can witness no `handleRequest` delegation. Do not patch private SDK loaders.
- Over-budget initialization consumes no session capacity: with cap 1, a later valid fresh initialize still succeeds. This distinguishes guarding before resolution from guarding after allocation.
- Following a refused request, normal tools/list, safe synthetic call/result, two fresh clients, DELETE, pending-park cancellation and shutdown still work. Reuse004 coverage; do not weaken it.

**Verify:** old integration path fails the new boundary expectation for the intended reason, not setup/clock/auth failure; pure tests cover the exact limit policy. Never execute a dangerous memory-exhaustion demonstration.

### Step 4 — Enforce the local guard and document its contract

Import/call the guard after `body !== undefined` and before `resolveTransport`. Reject immediately with the fixed 413 response; never echo arguments, config headers, secrets or raw request bodies. Keep auth/Host and byte checks first, and GET/DELETE behavior unchanged. Preserve all lifecycle fixes.

Document thresholds,413 behavior, that authentication is not a complexity budget, and why the high-level SDK option is not used here. Add no global configuration toggles or per-tool bypasses in this change.

**Verify:** focused cases and typecheck pass. Review source order and operation/worklist bounds; the guard bounds delegated structure, not every possible SDK allocation or general HTTP DoS.

### Step 5 — Qualify library consumers and run the final gate

A package lock is not a promise about a library consumer's tree. The SDK 1.32.2 Zod range still accepts vulnerable versions. Explicitly document this residual; do not claim root overrides apply downstream. In a task-private smoke consumer using a local tarball, inspect actual SDK/Zod resolution, including a pre-existing older compatible Zod where practical. Never publish the tarball or run its lifecycle scripts. Record which SDK/Zod copy the installed package resolves, not just the consumer's top-level version. A graph showing old Zod must not be called patched because this repository's lock is clean; the bridge-local guard is a separate mitigation with its own tests.

If the product requirement is a guaranteed patched transitive Zod in every published consumer, STOP for a separately reviewed dependency strategy/upstream fix; this plan cannot honestly guarantee that with the current SDK range. Do not contact upstream without separate authorization.

Run focused checks and the full gate on the **updated** locked install. Record exact final counts, audit identities/dispositions, package contents (the new internal helper should be included), baseline/final hashes and incremental scope. Reuse old 330 results only as baseline, never as proof of the new graph.

**Verify:** gate exits0; all target version/budget checks pass; any remaining audit entries have supported API dispositions; consumer-resolution caveat and limit policy are explicit; no unexplained non-SDK/dev churn or source edits outside scope.

## Done criteria

- [x] Execution/policy approval exists before source/dependency work starts.
- [x] Direct SDK minimum and repository production Zod/body-parser resolutions meet target versions; no hidden vulnerable copies are omitted from the report.
- [x] A finite iterative structure/depth budget runs before resolution/SDK validation on authenticated POSTs; byte/auth/Host checks remain intact.
- [x] Safe boundary, mixed-tree, no-handler/no-session-allocation and lifecycle regressions pass.
- [x] Clean locked install, full tests, typecheck and package dry-run pass on the changed graph; source identities and actual counts recorded.
- [x] Runtime dependency floors, repository lock and uncontrolled external consumer graphs are distinguished; no false universal remediation claim.
- [x] Only scoped paths changed, prior accepted patches preserved, no staging/commit/push/publish/main integration.
- [x] Reviewer approves the final incremental patch; no source or upgrade is performed merely by delivering this plan.

## STOP conditions

Stop if limits reject known legitimate supported inputs and need policy adjustment; required npm resolutions do not patch the target graph; a major SDK/Node/peer migration or unrelated dev refresh is necessary; installed APIs differ materially; safe tests would require exploit-sized data, secrets, real inference or upstream contact; or verification fails twice after reasonable bounded fixes. Preserve evidence and report exact errors. Do not broaden scope, silently raise limits, weaken assertions, or treat a reduced audit count as proof of protection.

## Maintenance notes

Revisit the local guard whenever body parsing, transport construction or SDK entry points change; passing a pre-parsed body can bypass transport-owned limits. Preserve byte and structure limits as separate controls. Dynamic Pi tools can evolve their input shapes, so future limit changes are explicit compatibility decisions. SDK task/bearer/client/static-file advisories must be traced by API, not package name. Current330-test all-fixes evidence remains retained; this plan adds no source change and supersedes no approved feature fix.

## Planning verification and review status

**Historical planning phase:** the paragraph below describes preparation before the later explicit implementation authorization. Current implementation evidence is in [the execution review](evidence/010-input-budget-dependencies-review.md); reproducible artifact/scope QA is `python3 plans/execution/010/validate-implementation.py`.

Fresh audit/registry lookups and read-only inspection of the accepted bridge plus SDK 1.32.2 sources were performed. Reproducible planning QA: `python3 plans/execution/010/validate-plan.py` checks saved evidence, manifest/lock integrity, the actual auth/reader/resolution seam, SDK option applicability, unchanged original source, and Markdown structure/links; it does not test a future guard. No candidate dependency installation, implementation, new boundary tests or full-suite rerun was performed during planning. The earlier 330-test result is retained baseline evidence only. Independent plan review was not performed; no nested Pi reviewer was launched. Future implementation requires independent read-only review before acceptance.
