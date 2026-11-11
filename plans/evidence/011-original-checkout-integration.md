# 011 applied and installed in the original checkout

## Result

**APPLIED, CLEAN-INSTALLED AND VERIFIED — uncommitted.** The user explicitly authorized applying the reviewed 011 patch and updating this project's development install, while retaining the previous `node_modules` as a backup. This supersedes the earlier requirement to leave that install unchanged; it does not authorize any managed Pi host change, commit, push or publication.

The original checkout now has the exact qualified 1.5.2 development fixture. A fresh lockfile installation with lifecycle scripts disabled passed **341/341 tests**, typecheck and 43-entry package dry-run. Both actual root audits report **0 high/critical and 4 moderate package entries**; all 12 target advisory IDs are absent. Installed packages have **zero lock-version drift** and no missing nonoptional lock paths.

All 74 source-tree files match the approved isolated stack. Only the three reviewed 011 paths changed relative to the prior integrated source: `package.json`, `package-lock.json`, `README.md`. No source/API/test/peer/support adaptation was added.

**Embedded Undici remains not independently attested.** Neither the fresh install nor audit results prove every embedded CLI code path or arbitrary consumer host is safe.

## Preservation before replacement

Original checkout: `/Users/juanbenjumea/projects/pi-extensions/pi-agy`, branch `main`. Before mutation, every source hash matched the approved integration baseline, the reviewed patch hash matched, `git apply --check` passed and staging was empty. HEAD remains `1bf9d29eaf0b56363ae7f62893670efe3eebeee3`.

The previous dependency tree was **atomically renamed, not deleted**, on the same verified filesystem device:

```text
.pi/dependency-backups/011-3i3yjwa8/node_modules
```

Its 33,428 path/mode/size/mtime/symlink-target metadata entries have the same fingerprint before the move, after the move and after final verification:

`69b05c838d84c021afebbbc1562c39909c31bc413d9df7dbe1d7b4aa2dc5a143`

The prior versions of the three changed metadata/docs files were copied with their metadata to:

```text
.pi/dependency-backups/011-3i3yjwa8/source/package.json
.pi/dependency-backups/011-3i3yjwa8/source/package-lock.json
.pi/dependency-backups/011-3i3yjwa8/source/README.md
```

Those source-copy hashes still match the pre-change baseline. The backup retains the old divergent install, including its legacy vulnerable development dependencies; it is not the active Node resolution tree and should not be executed as a patched host. Nothing in this archive was cleaned or deleted. Restore/cleanup would be a separate explicit operation; source metadata and install must be considered together if rolling back.

The applied patch is `plans/patches/011-pi-development-host.patch`, SHA-256`dd1879865101d0d38974edb62067f52fdda44960a2ff726f3c51e5aa50258d0c`. It is byte-for-byte the previously reviewed three-file change; no new implementation was written during application.

## Installation and active resolutions

Executed in the original checkout under the recorded private environment:

```sh
npm ci --ignore-scripts --prefer-offline --fetch-retries=0 --fetch-timeout=30000
```

Exit 0;209 packages added. The qualified task's private npm cache was reused, with normal lockfile integrity checking, not copied vendor files or hand-edited dependency metadata. No lifecycle scripts were enabled and no global installation was performed.

| Active package | Installed |
|---|---|
| Pi AI / coding-agent / TUI | Exact1.5.2 each |
| Undici |8.12.3 |
| minimatch |11.0.3 |
| brace-expansion |5.0.12 |
| MCP SDK |1.32.2 |
| Zod |4.6.7 |
| body-parser |2.4.0 |

Every installed lockfile package version matches the lock; no required path is missing. The previous 36 installed-versus-lock differences are retained in the archived old install, not carried into the active graph.

Public peer ranges, engines, scripts and product version remain unchanged. The SDK fixture requires Node>=22.19.0; the actual qualification/integration runtime was Node 22.23.4/npm 10.9.9. This is not a new assertion that every older Node/peer combination is supported.

## Verification in this original checkout

Test fixtures used a private HOME/agent/TMPDIR **outside the repository and archived dependency ancestry**, so temporary module lookup and ancestor-repository detection could not accidentally inherit the old backup. The fresh agent directory is a sibling of TMPDIR, avoiding the previously diagnosed shared-fixture leak. Paths/environment are in the integration metadata, without personal configuration or credentials.

| Actual command/check | Result |
|---|---|
| Install with scripts disabled | Exit 0 |
| `npm ls` relevant SDK/host packages`--all` | Exit 0; exact active resolutions recorded |
| `npm test` | **341/341**,54 suites;0 failed/cancelled/skipped |
| `npm run typecheck` | Exit 0 |
| `npm run pack:check` | Exit 0;43 entries; no tarball/publication |
| `npm audit --json` | Exit 1;0 high/critical,4 moderate |
| `npm audit --omit=dev --json` | Exit 1;0 high/critical,4 moderate |
| Target advisory identity check | All12 absent from both audits |
| Source byte comparison | 74/74 match reviewed qualified stack |
| Previous install/source-copy preservation | Pass; old install fingerprint and copied source hashes unchanged |
| Current lock alignment |0 version drift,0 missing nonoptional paths |
| Git state | HEAD unchanged, staging empty, whitespace check passes |
| Integration validator | **27 checks pass**, without repeating install or tests |

Recheck retained receipts and integrity with:

```sh
python3 plans/execution/011/validate-integration.py
```

Structured metadata: `plans/execution/011/integration.json`; results: `integration-validation.json`. Actual command logs and exit receipts are retained under `.pi/dependency-backups/011-3i3yjwa8/logs/`. The prior independent [qualification review](011-pi-development-host-qualification.md) remains applicable because integrated bytes exactly match the reviewed change; no redundant source review was substituted for the newly executed original-checkout gate.

## Remaining limits and handoff

The four moderate package entries remain `@hono/node-server`, fast-uri, Hono and ip-address in the unchanged production SDK closure; earlier API-specific dispositions remain relevant. Zero high/critical audit counts are not a general vulnerability or runtime-safety proof. The reachable bundle's iterative brace parser was checked in qualification; embedded Undici provenance remains explicit rather than inferred from package metadata.

No managed/running Pi installation, authentication/session state or global package was changed. No Pi process, live agy/provider turn or exploit experiment was launched. Linux, Windows, minimum-Node and arbitrary consumers remain unqualified. Existing already-running development processes were not restarted or attested.

All authorized 011 source/install integration is complete. The old install and source copies are retained; changes are **uncommitted and unstaged**. Committing, pushing, publishing, altering public support promises, deleting backups or unrelated advisory remediation requires separate scope/authorization.
