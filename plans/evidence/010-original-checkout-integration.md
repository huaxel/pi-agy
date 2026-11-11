# Reviewed patches applied to the original checkout

> **Historical preserved-install phase through010.** The user later explicitly authorized applying011 and aligning the original dependency tree, retaining this earlier install as a backup. See the [current011 integration receipt](011-original-checkout-integration.md). The36-version drift and unchanged-install claims below describe the earlier phase, not the current active graph.

## Result

**APPLIED AND VERIFIED, uncommitted.** The user explicitly selected application of the reviewed patches to the original checkout, with no dependency replacement, commits, pushes or publishing.

Applied order: **002,003,004,009,005,006,010**. All **74 source-tree files** exactly match the approved final stack. The original checkout's **341/341 tests**, typecheck and package dry-run pass. No new production implementation was introduced during integration.

Checkout: `/Users/juanbenjumea/projects/pi-extensions/pi-agy`, branch `main`. HEAD remains `1bf9d29eaf0b56363ae7f62893670efe3eebeee3`; staging is empty. Applying patches changed the working tree, not commit history. No Git merge, commit, push, package publication, global package installation or live agy/provider inference occurred.

## Preserved work and safe application

Before application, tracked source was clean; the pre-existing untracked `plans/` artifacts were preserved. Every patch hash matched its recorded approval.

A combined `git apply --check` over the dependent patch files failed at `tests/provider.test.ts:313`. It was not treated as permission to discard context or overwrite files. A task-owned plain copy of the actual original tracked files was created, the seven patches were applied **in order**, and the resulting 74 files were compared with the already-reviewed source hashes before writing to the original checkout. New-file collisions were checked. Each real application then had its own immediate `git apply --check` against the preceding applied state.

The ordered preview is retained at `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-integration-_72_6hu2`.

No reset, clean, staging or deletion of existing work was performed. No source was rewritten to make a test pass; the result is the exact reviewed patch composition.

## Changed source paths

Fourteen modified tracked files:

- `README.md`
- `extensions/index.ts`
- `extensions/lib/provider-driver.ts`
- `extensions/lib/provider-mcp.ts`
- `extensions/lib/provider.ts`
- `extensions/lib/spawn.ts`
- `package.json`
- `package-lock.json`
- `tests/execution.test.ts`
- `tests/preflight.test.ts`
- `tests/provider-driver.test.ts`
- `tests/provider-mcp.test.ts`
- `tests/provider.test.ts`
- `tests/regression.test.ts`

Three added reviewed files:

- `extensions/lib/bridge-input-budget.ts`
- `tests/bridge-input-budget.test.ts`
- `tests/timing-helpers.ts`

The five correctness fixes, timing-fixture changes and010 dependency/input-budget remediation were applied. Designs007/008 remain designs; their feature implementations were not added.

## Existing dependencies were not replaced

No `npm install`, `npm ci`, dependency update, global installation or lifecycle script enabling was run during this integration.

A metadata-only fingerprint of **33,428 installed dependency entries** (paths, modes, sizes, modification times and symlink targets, without reading dependency file contents or following symlink directories) was identical before application, after application and after the full gate:

`69b05c838d84c021afebbbc1562c39909c31bc413d9df7dbe1d7b4aa2dc5a143`

The existing tree already had SDK 1.32.2, Zod 4.6.7, body-parser 2.4.0, qs 6.17.1, Pi peers 0.87.1 and TypeScript 5.9.3. `npm ls @modelcontextprotocol/sdk zod body-parser --all` exited 0.

There are **36 existing installed-versus-lock package-version differences**, with no missing nonoptional lock paths. For example, installed Express 5.3.0 versus locked 5.2.1 and installed Hono 4.13.17 versus locked 4.13.10. Their complete path/version inventory is in `plans/execution/010/integration.json`. These differences were recorded, not silently normalized.

Therefore this original-checkout gate validates the **preserved installed graph**, not a fresh locked install. The [isolated010 review](010-input-budget-dependencies-review.md) separately records a successful `npm ci --ignore-scripts` and 341-test gate on the new lockfile, using identical source bytes. Do not conflate the two qualifications.

## Verification actually run here

Node 22.23.4/npm 10.9.9, minimal `env -i`, private HOME and a fresh task-owned agent directory under the ignored `.pi/` tree. PATH excluded the real agy CLI; product inference was not exercised.

| Check | Result |
|---|---|
| Ordered preview and reviewed-byte comparison | Pass; 74/74 source files identical |
| Existing dependency resolutions | Exit0; approved target versions already installed |
| `npm test` | **341/341**,54 suites;0 failed/cancelled/skipped |
| `npm run typecheck` | Exit0 |
| `npm run pack:check` | Exit0;43 entries; no tarball/publication |
| Dependency metadata fingerprint | Unchanged across application and verification |
| HEAD and staging | Original HEAD unchanged; staging empty |
| Scope/whitespace | Exactly reviewed 17 source paths; `git diff --check` passes |
| Reproducible integration receipt validator | **13 checks pass**, without installing or rerunning tests |

Recheck retained receipts and byte identities with:

```sh
python3 plans/execution/010/validate-integration.py
```

Structured metadata: `plans/execution/010/integration.json` and `integration-validation.json`. Actual command logs and exit files are under the ignored directory recorded as `evidenceDir` in that metadata.

Independent source review was not repeated merely because files moved: all integrated bytes match the previously approved stack, while the full gate was newly executed in this original checkout. The earlier independent approval and its limitations are retained in the isolated010 report.

[Open the original checkout's applied README/input contract](http://dawn.localhost:9898/d/RLL6RDc3sY8O4rC2).

## Remaining limits

- Source changes are **uncommitted**. No staging, commit, release, publishing or global installation is implied by this integration.
- Installed dependencies remain intentionally different from the lock at 36 package paths. Replacing them would require separate authorization; clean-lock evidence already exists in isolation.
- The previously qualified lockfile audit still has 4 moderate production-only package entries, and its broader development-pinned Pi host/peer graph has 2 high entries. No new advisory remediation was added during application; those lockfile results are not an audit of every currently installed or external consumer package.
- The SDK's broad Zod range can still resolve an older consumer Zod; the bridge guard is defense-in-depth, not a universal downstream dependency guarantee.
- Linux, Windows, minimum-Node, arbitrary Pi peer versions and live agy/provider behavior remain untested. No dangerous memory-exhaustion probe was run.

The authorized integration outcome is complete. Remaining source work, dependency replacement, commits or publication would be new scope.
