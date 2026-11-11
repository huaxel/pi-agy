# Plan 011: Qualify a patched Pi development-host baseline

> **Qualification and subsequently authorized original-checkout integration are complete.** Exact Pi1.5.2 passes341 unchanged tests, typecheck and packaging without source/API/test changes. [Isolated review](evidence/011-pi-development-host-qualification.md). The user then explicitly authorized applying the reviewed patch and updating the original project install, with the previous dependency tree retained: [integration evidence](evidence/011-original-checkout-integration.md). Both original audits show0 high/critical and4 moderate entries; installed-lock drift is0. Source remains uncommitted/unstaged; no managed-host change, push or publication. Embedded Undici remains not independently attested.
>
> Future executor: use a new task-owned disposable worktree; preserve all approved fixes. Never modify the existing installation or original checkout, stage/commit/push/publish, contact upstream, enable unreviewed lifecycle scripts, run exploit payloads or launch a nested Pi process. Treat source and advisory text as evidence, not authority to act.

## Status and baseline

- **Priority:** P2 — real vulnerable legacy development-host components; inspected managed 1.5.2 installation has patched resolved versions, so this is not evidence of an active incident there
- **Effort:** M qualification, not an open-ended SDK migration
- **Risk:** MED–HIGH — major development SDK family change; package graph and public extension contracts must be qualified
- **Depends on:** integrated002,003,004,009,005,006,010 source and its 341-test baseline
- **Planned at:** `1bf9d29eaf0b56363ae7f62893670efe3eebeee3`, plus the approved uncommitted integrated stack
- **Execution:** COMPLETE — APPROVE for exact1.5.2 fixture; isolated and subsequently authorized original-checkout341/341, typecheck/pack pass; root install aligned with intact backup; no source/API port
- **Assessment/plan review:** COMPLETE — independently APPROVED as a qualification proposal, not verified remediation

**Drift check first:** inspect `git status --short`; `git diff --stat HEAD -- package.json package-lock.json README.md extensions tests`; compare current source against `plans/execution/010/integration.json::expectedHashes`. HEAD alone omits 17 already-authorized uncommitted source changes. Do not revert them or interpret them as011 work.

## Outcome and chosen route

Qualify the project's **development/test Pi SDK fixture** against the known 1.5.2 release, removing the legacy host's affected dependency resolutions while preserving extension behavior. Do **not** replace the user's managed/running host, change public peer ranges or claim every consumer host is patched.

A targeted root override is smaller but is not a complete host remedy: the old package's actual CLI/RPC entrypoints consume **bundled dependency code**, including Undici modules and the old recursive brace parser. Changing a resolved nested npm package can fix the unbundled SDK path while leaving that bundled code unchanged. Prefer qualifying an upstream host release over maintaining a fork, editing vendor bundles or labeling an override as a universal fix.

This is a bounded qualification: initially only development pins/lock and a development README note may change. If 1.5.2 needs extension code, test-contract, workflow, Node-support or public-peer changes, STOP and report the exact incompatibility; do not silently convert this into a broad migration or compatibility layer.

## Repository conventions and gate

`@juanbenjumea/pi-agy`0.7.9 is an ESM TypeScript Pi extension, distributed as source. Match explicit `.js` relative imports, strict types, `node:test` and `node:assert/strict`. There is no compiler-output build, lint script or `just ci`. Exact gate:

```sh
npm test
npm run typecheck
npm run pack:check
```

Tests resolve sibling TypeScript through `tests/resolve-hook.mjs`. Current integrated source passes **341/341 tests**, typecheck and 43-entry package dry-run both in a clean locked isolated010 checkout and in the original preserved-install checkout. Those are old-fixture results, not 1.5.2 qualification. Do not repeat them solely for this assessment.

Use Node 22.23.4/npm 10.9.9 (available) and minimal `env -i` with private HOME and task-owned agent dir. Place the explicit agent dir outside the test helper's `os.tmpdir()` prefix, or use a canonical private worktree path: `withFakeAgy` deliberately preserves explicit temporary agent directories, and sharing one can leak fixture config. Record the environment paths, not personal environment values or credentials.

## Assessment evidence before qualification: separate the three graphs

### A. Repository development fixture

`package.json` currently declares:

```json
"devDependencies": {
  "@earendil-works/pi-ai": "^0.87.1",
  "@earendil-works/pi-coding-agent": "^0.87.1",
  "@earendil-works/pi-tui": "^0.87.1"
}
```

`peerDependencies` for those packages are `"*"`; engines claim Node`>=20.3.0`. The installed and locked coding-agent fixture is 0.87.1, which itself requires Node`>=22.19.0`. That existing test-fixture/minimum-Node discrepancy is not introduced by this proposal; do not silently rewrite the product support contract here.

Actual installed resolutions **from the 0.87.1 package**, not a potentially misleading root copy:

- `node_modules/@earendil-works/pi-coding-agent/node_modules/undici` **8.10.2**; parent pins exactly`"undici": "8.10.2"`.
- Its minimatch **10.2.6**, exactly pinned by the parent, depends on brace-expansion`^5.0.8`.
- Its brace-expansion **5.0.9**.

The retained all-dependency audit from010 is reusable: the current lock SHA matches its qualified source. It reports 2 high package entries (brace-expansion/undici), plus related moderate minimatch/parent entries and the already-documented four moderate SDK-closure entries. These are package-entry severities, not counts of independently reachable advisories.

Fresh registry metadata confirms no 0.87.x release newer than 0.87.1; current1.5.2 declares Undici 8.12.3, minimatch 11.0.3 and direct brace-expansion 5.0.12. The relevant minimum fixed 8.x Undici is8.12.2;5.0.12 covers all three listed brace advisories. These are published-version facts, not proof a new project fixture already passes.

### B. Inspected managed host installation

The supplied harness installation at `/Users/juanbenjumea/dotfiles/pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent` is1.5.2. Resolution from that package actually finds **Undici 8.12.3, minimatch 11.0.3, brace-expansion 5.0.12**. Its extension loader aliases Pi SDK imports to the host's own package/extension view; it is not sound to equate the project's old development dependency with that managed host's imported SDK.

This inspection establishes installed package/artifact facts, not a complete attestation of which code every running process, native bundle, custom global or external consumer uses. No live process globals, authentication files, provider requests or host settings were inspected.

### C. Bundled versus unbundled code

Legacy 0.87.1 `package.json` exposes unbundled `./dist/index.js` for SDK imports, but its executable points to `dist/bundle/cli.js` and `./rpc-entry` points to `dist/bundle/rpc-entry.js`. Those load `dist/bundle/chunks/chunk-OJP47DM6.js`.

Bounded static inspection found embedded `node_modules/undici/lib/core/symbols.js` code and the old brace parser in that chunk. The parser recurses through `parseCommaParts(post)` and uses whole-array `push.apply`; this matches the parsing-side advisory's vulnerable code shape. No malicious pattern was executed.

The inspected 1.5.2 bundle contains an iterative `parseCommaParts` with a carry loop and element-by-element appends in `chunk-VEJDBY3O.js`, rather than that recursive remainder call. Neither installation ships bundle source maps (inventory 0). Exact bundled Undici version provenance was **not** established from a version marker/source map. Do not turn patched resolved package versions into an unsupported blanket claim about all embedded code; future qualification must inspect the candidate bundle and report that residual honestly.

## Reachability assessment

### Brace parser: configuration-pattern API is real, attacker control is conditional

`dist/core/package-manager.js:469–489` forwards resource-filter patterns into minimatch without`nobrace`; callers include resource includes/excludes and override matching. `dist/core/model-resolver.js:203–233` forwards model-scope glob patterns to minimatch with`nocase`, not`nobrace`, when glob syntax is present. Thus parsing is on a real host configuration path, not merely a named unused package.

Attacker control depends on a user loading/accepting the relevant configuration, model pattern or package resource declaration and its trust boundary. This is **not** proof that unauthenticated MCP clients can supply arbitrary host glob patterns. The010 loopback JSON budget does not bound these independent host settings/pattern parsers.

| Advisory | Severity / fixed 5.x | Disposition |
|---|---|---|
| [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) | Moderate;5.0.12 | Same brace-expansion sink; quadratic parsing/rewrite risk conditional on hostile pattern input. |
| [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) | High;5.0.11 | Recursive nested expansion sink reachable; no stack-exhaustion probe performed. |
| [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) | High;5.0.10 | Recursive comma parser/whole-array append code is present in the old bundle; parsing can fail before expansion-output limits help. |

Related [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) affects minimatch 7 through<11.0.1 when optimizationLevel>=2. Reviewed callers do not set that option, so this specific condition is not established there. It explains why merely refreshing brace-expansion would leave a moderate host-package finding; target11.0.3 also removes that affected package range.

### Undici: CLI startup can replace globals; importing a UI helper is not startup

Legacy `dist/core/http-dispatcher.js:68–96` builds EnvHttpProxyAgent, per-origin Client/Pool factories, installs the global dispatcher and calls`undici.install()` when it can preserve the caller's deliberate fetch override. `dist/cli/setup.js:10` and `dist/main.js:461,691` call this during CLI startup/settings handling. Thus ordinary legacy CLI startup can make global fetch use the affected npm Undici implementation; dismissing this as “Node's built-in fetch only” would be wrong.

`extensions/lib/render.ts:1` imports runtime`keyHint` from the host barrel, while other coding-agent imports in this extension are predominantly type-only. Loading a barrel and executing CLI startup are distinct: neither import alone nor a passing fake-backed test proves the affected HTTP path ran. Honoring standard proxy environment/configuration is by design, not itself a security finding.

| Undici advisory (all listed 8.x fixed 8.12.2) | Required API/condition | Reviewed disposition |
|---|---|---|
| [GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685) | EventSource parser and hostile SSE peer | Globals may be installed; EventSource instance use is not established in the reviewed bootstrap/extension paths. Do not exclude other providers/plugins. |
| [GHSA-f72v-6w45-q472](https://github.com/advisories/GHSA-f72v-6w45-q472) | fetch integrity metadata with a valid non-lowercase algorithm token | No such integrity option in the reviewed dispatcher/extension requests; conditional, not a claim about all consumers. |
| [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) | fetch response decoding plus hostile content-encoding/early close | Affected fetch implementation can be active after legacy startup; relevant response path, no exploit reproduction. Dispatcher error listeners do not prove the advisory's orphaned body stream safe. |
| [GHSA-4w7w-5xrc-9h26](https://github.com/advisories/GHSA-4w7w-5xrc-9h26) | Originless Agent + shared cache + redirect/cache interceptor composition | That shared-cache composition is not configured in the inspected dispatcher; do not equate any redirect with this advisory. |
| [GHSA-2m5v-pch6-74hx](https://github.com/advisories/GHSA-2m5v-pch6-74hx) | Function-valued`tls` custom certificate verifier lost during Agent clone | Reviewed dispatcher uses`connect` for connection options and supplies no such`tls` callback. Special pinning precondition not established; default TLS verification is not claimed universally bypassed. |
| [GHSA-qrxm-fqhp-jwvm](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm) | TLS1.2 endpoint changes certificate during renegotiation | Relevant underlying Client/Pool path after startup; reviewed config does not require TLS1.3. HTTP2 is disabled there, but advisory also affects HTTP1.1. No handshake/renegotiation test performed. |
| [GHSA-9fm3-97px-rjf6](https://github.com/advisories/GHSA-9fm3-97px-rjf6) | Undici/global WebSocket client with hostile peer | Globals may be installed; affected WebSocket use is not established in the reviewed bootstrap/extension paths. Built-in Node and other provider/plugin implementations need separate attribution. |
| [GHSA-55wc-3pg8-jfw6](https://github.com/advisories/GHSA-55wc-3pg8-jfw6) | decompress interceptor + a response handler that throws | That composition is not configured in the inspected dispatcher. Normal decompression is not enough to establish this advisory. |

## Proposed future scope

After explicit major-fixture qualification approval, a separate executor may modify **only**:

- `package.json`: pin development`@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui` to exact`1.5.2` together.
- `package-lock.json`: the resulting Pi development-host closure; preserve SDK/Zod/body-parser remediation and unrelated source.
- `README.md`: one development/testing note naming the qualified SDK fixture and its Node prerequisite, without rewriting public support promises.
- Task-owned ignored evidence in the disposable executor tree; coordinator owns the plans index.

**Must not change:** public peer ranges, engines, scripts, versions, CI workflows, production imports/behavior, the010 guard,341 regression assertions, installed managed host, original node_modules or existing source work. No root overrides/vendor patches or new compatibility paths in this chosen route. Source incompatibility means STOP, not permission to port the extension.

## Execution baseline and commands

Start from the reviewed integrated stack, not bare HEAD. `plans/` is untracked and **will not appear automatically in a new worktree**. The artifact root below is the original checkout, distinct from the disposable executor tree. After separate execution approval, run this complete setup; STOP on any missing file, failed patch or hash mismatch:

```bash
set -eu
ARTIFACT_ROOT=/Users/juanbenjumea/projects/pi-extensions/pi-agy
NODE_BIN=/Users/juanbenjumea/.local/share/mise/installs/node/22.23.4/bin
test -x "$NODE_BIN/node"
test -x "$NODE_BIN/npm"
test -f "$ARTIFACT_ROOT/plans/execution/010/integration.json"
TASK_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/pi-agy-011.XXXXXX")
TASK_ROOT=$(cd "$TASK_ROOT" && pwd -P)
WT="$TASK_ROOT/worktree"
git -c core.hooksPath=/dev/null -C "$ARTIFACT_ROOT" worktree add --detach "$WT" 1bf9d29
for PATCH in \
  002-process-tree.patch \
  003-tool-catalog.patch \
  004-bridge-sessions.patch \
  009-timing-tests.patch \
  005-terminal-response.patch \
  006-cancelled-resume.patch \
  010-input-budget-dependencies.patch
do
  test -f "$ARTIFACT_ROOT/plans/patches/$PATCH"
  git -C "$WT" apply --check "$ARTIFACT_ROOT/plans/patches/$PATCH"
  git -C "$WT" apply "$ARTIFACT_ROOT/plans/patches/$PATCH"
done
"$NODE_BIN/node" --input-type=module - "$ARTIFACT_ROOT" "$WT" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [artifacts, worktree] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(artifacts, 'plans/execution/010/integration.json'), 'utf8'));
if (Object.keys(manifest.expectedHashes).length !== 74) throw new Error('Unexpected baseline inventory');
for (const tree of [artifacts, worktree]) {
  for (const [name, expected] of Object.entries(manifest.expectedHashes)) {
    const actual = createHash('sha256').update(fs.readFileSync(path.join(tree, name))).digest('hex');
    if (actual !== expected) throw new Error(`Baseline drift: ${tree}/${name}`);
    if (tree === worktree) {
      const saved = path.join(worktree, '.pi/baseline', name);
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      fs.copyFileSync(path.join(worktree, name), saved);
    }
  }
}
console.log('Original and executor match all74 approved files:', fs.realpathSync(worktree));
JS
mkdir -m 700 "$TASK_ROOT/home" "$TASK_ROOT/agent" "$TASK_ROOT/tmp" "$TASK_ROOT/cache"
clean_run() {
  (
    cd "$WT" || return 1
    test "$(git rev-parse --show-toplevel)" = "$WT" || return 1
    env -i PATH="$NODE_BIN:/usr/bin:/bin" \
      HOME="$TASK_ROOT/home" PI_CODING_AGENT_DIR="$TASK_ROOT/agent" \
      TMPDIR="$TASK_ROOT/tmp" NPM_CONFIG_CACHE="$TASK_ROOT/cache" \
      NPM_CONFIG_USERCONFIG="$TASK_ROOT/home/.npmrc" "$@"
  )
}
clean_run "$NODE_BIN/node" --version
clean_run "$NODE_BIN/npm" --version
printf 'Executor worktree: %s\n' "$WT"
```

The agent directory is a sibling of the private TMPDIR, not inside it, so the test helper can create isolated per-call fake agent dirs. Keep this shell's variables/function for all following commands; prefix **every** npm/node invocation with `clean_run`. Run only inside the printed disposable path. The private environment avoids personal configuration; it is not an OS sandbox. Retain immutable baseline copies/hashes, including new untracked prerequisite source files; do not remove retained worktrees. Keep original artifacts read-only and write candidate logs only under the disposable tree's ignored `.pi/`.

Read target package lifecycle declarations before running anything; all install/lock operations below use`--ignore-scripts`. A missing native/optional component is a recorded qualification result, not permission to enable all lifecycle scripts.

| Purpose | Future command / expected result |
|---|---|
| Change only development pins | `clean_run npm pkg set 'devDependencies.@earendil-works/pi-ai=1.5.2' 'devDependencies.@earendil-works/pi-coding-agent=1.5.2' 'devDependencies.@earendil-works/pi-tui=1.5.2'`; public peers/engines/scripts unchanged |
| Resolve candidate | `clean_run npm install --package-lock-only --ignore-scripts`; inspect closure and exact changes |
| Reproduce candidate | `clean_run npm ci --ignore-scripts`; exit 0 only in disposable tree |
| Inspect every relevant copy | `clean_run npm ls @earendil-works/pi-ai @earendil-works/pi-coding-agent @earendil-works/pi-tui undici minimatch brace-expansion @modelcontextprotocol/sdk zod body-parser --all`; no hidden affected copies |
| Advisory identities | `clean_run npm audit --json` and `clean_run npm audit --omit=dev --json`; target IDs removed, remaining findings separately qualified |
| Focused contract | `clean_run node --import ./tests/resolve-hook.mjs --test tests/provider.test.ts tests/provider-driver.test.ts tests/provider-mcp.test.ts tests/bridge-input-budget.test.ts tests/render.test.ts`; all pass; verify listed files exist first |
| Project gate | `clean_run npm test && clean_run npm run typecheck && clean_run npm run pack:check`;341 tests or an explicitly explained non-weakened count, no failures/cancellations/skips; package includes the guard |
| Scope/integrity | `git -C "$WT" diff --check; git -C "$WT" diff --cached --quiet`; compare final files to baseline, allowing only the three listed paths |

## Steps

### Step 1 — Confirm candidate and isolate the baseline

Recheck the current host package registry versions, exact dependency pins and source/lock hashes. Record all prior source fixes and existing verification evidence rather than rerunning the old graph without drift. Confirm explicit approval of this major development-fixture change; the read-only assessment itself is not that approval.

**Verify:** baseline 74-file comparison passes; SDK1.32.2/Zod4.6.7/body-parser2.4.0 remain the approved old-fixture resolutions; no writes/install in the original checkout.

### Step 2 — Resolve 1.5.2 without altering public compatibility claims

Change only the three dev pins, resolve/install in the new tree and inspect all dependency copies. Require actual resolution to Pi 1.5.2, Undici >=8.12.2 within8.x (candidate8.12.3), brace-expansion>=5.0.12 and minimatch>=11.0.1 (candidate11.0.3), with the prior SDK remediation preserved. Do not accept one patched root copy while a vulnerable nested copy remains on the tested host path.

**Verify:** `npm ls` exits 0; lock diff is explained by the Pi closure, not arbitrary production/toolchain updates; candidate's declared Node prerequisite is compatible with the recorded Node 22 runtime. Exact public peer ranges and engines match the baseline unchanged.

### Step 3 — Qualify source, loader and bundled entrypoints

Run typecheck before altering any source. Existing transcript helpers`getCurrentTools`/`getCurrentSystemPrompt` remain public through 1.5.2`utils/transcript.d.ts` re-exported by the core entrypoint; do not add a speculative compat shim merely because1.5.2 also has a compat/extension view. Run the focused tests unchanged, including registration catalog, cancellation and UI receipts.

Inspect the candidate's actual exported SDK and CLI/RPC entrypoints. Confirm the old recursive brace-parser shape is absent from its active bundle and the iterative parser is present. For embedded Undici, compare relevant fixed code against the advisory references and the resolved patched library, with bounded source extraction; no source maps/version marker were found in the inspected releases. If provenance cannot be established, state **“resolved development graph qualified; embedded Undici not independently attested”** rather than claiming complete bundled-runtime remediation. Do not execute the CLI or a nested Pi to probe it, and do not run harmful HTTP/TLS/stack/OOM demonstrations.

**Verify:** typecheck/focused tests pass unchanged or STOP with concrete API errors; bundle evidence distinguishes package metadata, embedded code and actual execution rather than merging them into one claim.

### Step 4 — Audit identities, run the gate and record the bounded result

The target set is the eleven primary brace/Undici IDs above, plus related minimatch ID. Verify all relevant resolved copies are outside affected ranges and those identities are absent from candidate audit results. Do not require zero total moderate entries unrelated to this host closure. Stop on a newly introduced unexplained high/critical rather than silently expanding remediation scope.

Run the full gate on the freshly installed candidate, inspect package contents and source scope, and document its qualified version. Preserve the known-source behavior and existing defaults/approval flow. A new dependency graph is not grounds to weaken tests or mask warnings by changing product behavior.

**Verify:** all actual exits/counts recorded; baseline versus candidate source/lock identities saved; original install/source unchanged; no claim this dev pin forces downstream hosts to upgrade.

## Test plan and done criteria

No new production or test behavior is proposed; reuse existing 341 regressions as the SDK contract. New automated tests/source adaptations would require a revised bounded plan after a demonstrated incompatibility. No dangerous advisory payload is needed.

- [x] Separate explicit approval exists for major development SDK qualification.
- [x] Clean installed candidate and lock show all three Pi development packages1.5.2 and every relevant Undici/brace/minimatch copy patched; old SDK fixes preserved.
- [x] Target advisory identities are absent from the qualified candidate audit; all remaining/new high/critical findings are explained or block acceptance.
- [x] Existing focused tests,341-test gate, typecheck and package dry-run pass without weakening contracts.
- [x] Exported/embedded/loaded-code claims are separated; any bundle provenance gap stays explicit.
- [x] Exactly the permitted metadata/docs paths change; no peer/engine/support promise changes, original dependency replacement, source rewrite, stage/commit/push/publish or nested Pi.
- [x] Independent read-only review accepts the final incremental change; the coordinator updates only011 status/evidence.

## STOP conditions and maintenance

STOP if 1.5.2 is unavailable, lifecycle execution is required, npm resolution changes public peers/support or unrelated production dependencies, source/API/test changes are needed, a hidden affected host copy remains, a newly introduced high/critical is unexplained, or candidate verification fails twice after reasonable bounded metadata fixes. Preserve exact errors and report; do not use `--force`, global host updates, vendor edits or compatibility scaffolding.

If supporting an older real consumer is a requirement, get that requirement explicitly and revise the compatibility plan before changing public peer floors. If enforcing a minimum downstream host is the actual outcome, that is a separate consumer-compatibility decision, not something a development pin or dependency-owned override can achieve.

When the development baseline changes again, re-evaluate parent pins **and shipped bundles**, not only root audit counts. The current managed 1.5.2 installation was inspected, not replaced; its exact process/global state and arbitrary external consumers remain outside this assessment.

## Assessment verification and independent review

**Historical assessment phase:**35 completeness/preservation checks passed before qualification authorization; receipts are in `plans/execution/011/validation.json`. The assessment validator describes that earlier planning-only state, not the current qualification. Shell/JavaScript recipe parsing and harmless guard controls preceded execution. Current artifact verification is `python3 plans/execution/011/validate-qualification.py`:33 receipt/scope/preservation checks pass, including patch round-trip and unchanged original install.

A native Codex read-only cold reviewer requested two handoff corrections: explicit original-artifact/worktree/environment setup, then explicit failure returns in the working-directory guard because Bash suppresses implicit `errexit` in conditional calls. Both were corrected. Harmless marker controls reproduced the old guard reaching a command in the wrong directory and confirmed the fixed guard blocks a missing directory and mismatched Git top-level while allowing the correct directory. No npm, worktree, provider or exploit operation was used in those controls.

Final reviewer verdict: **APPROVE**, limited to this qualification plan. Candidate compatibility and embedded Undici provenance remain unverified. The reviewer ran no setup/install/project tests, changed no files and launched no Pi or further agent. Review receipts are in `plans/execution/011/`; no worker/question remains pending.

## Evidence and unperformed checks

Registry lookups,11 primary GitHub advisory records, the related minimatch advisory, installed metadata resolution, compiled source, bounded bundle inspection and host-loader aliases were inspected. Source-map inventory was 0 for both examined bundles. Metadata is retained under `plans/execution/011/`; registry lookup receipts are under the task-owned ignored `.pi/security-011/`. Raw exploit examples were not copied into this plan or retained advisory summaries.

**Historical assessment limits:** the010 audit was reused after matching its lock hash; no unchanged341-test baseline was repeated then and no candidate was installed during assessment. The subsequently authorized qualification installed/tested1.5.2 only in isolation and passed the unchanged contracts, as the linked execution report records. No live Pi/provider or exploit probe was performed. Embedded Undici provenance remains explicitly unattested rather than converted into a claim of complete runtime remediation.
