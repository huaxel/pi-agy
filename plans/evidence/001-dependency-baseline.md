# Dependency baseline evidence

## Provenance

- Plan baseline: `1bf9d29eaf0b56363ae7f62893670efe3eebeee3` (`HEAD`); the initial drift/status checks found no tracked source or manifest changes.
- This executor was assigned `/private/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-luna-001.9lr2PJ/worktree`. An initial installation was started there, then superseded; its generated `node_modules` was removed. A second detached verification checkout was created and retained at `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-baseline.vTbjT8/checkout`.
- An early reviewer run against the superseded/being-removed installation is invalid evidence and was explicitly discarded. The accepted Node 22 evidence is reviewer-run evidence in the final checkout: `.pi/reviewer/tests-node22.log`/`.exit`, `typecheck-node22.log`/`.exit`, and `pack-node22.log`/`.exit`. Transient missing-package failures from the superseded installation are not baseline defects.
- Original executor gates remain true on Node `v24.22.1` / npm `11.19.1`. The reviewer independently ran the stable locked checkout under `/Users/juanbenjumea/.local/share/mise/installs/node/22.23.4/bin/node` (`v22.23.4`) and npm `10.9.9`, with `env -i`, temporary `HOME`, and temporary `PI_CODING_AGENT_DIR`. Those results are labeled reviewer-run below, not executor-run.
- `sha256sum package-lock.json`: `3b1191b639bc509d09b13f9d6356a9d4df76a1f17001e0e85aad221832479d27`.
- Root package scripts were read before installation. `npm ci --ignore-scripts` was used; no lifecycle scripts were enabled.

## Installed-versus-locked versions

Lock-version command printed:

```text
@modelcontextprotocol/sdk 1.31.0
zod 4.6.5
body-parser 2.3.0
```

In the final detached checkout, `npm ci --ignore-scripts` exited `0`; `npm ls @modelcontextprotocol/sdk zod body-parser --all` exited `0` and matched the lock. `body-parser` is transitive under the SDK's Express dependency. No peer-resolution discrepancy was reported.

## Verification results

### Executor-run Node 24

| Command | Exit | Result |
|---|---:|---|
| `npm test` | 0 | 305 tests, 49 suites; 305 pass, 0 fail/cancel/skip. |
| `npm run typecheck` | 0 | No type errors. |
| `npm run pack:check` | 0 | Dry-run succeeded; 42 entries; no tarball written. |
| `git diff --exit-code` | 0 | Clean final detached checkout after installation. |

### Reviewer-run Node 22

These are independently executed results, not a rerun by this executor, and are recorded from `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-baseline.vTbjT8/checkout/.pi/reviewer/`:

| Command | Exit | Evidence/result |
|---|---:|---|
| `npm test` | 0 | `tests-node22.log`: 305 tests, 49 suites; 305 pass, 0 fail, 0 cancelled, 0 skipped; duration `60984.193375` ms (about 61s). |
| `npm run typecheck` | 0 | `typecheck-node22.log`: no type errors. |
| `npm run pack:check` | 0 | `pack-node22.log`: dry-run succeeded; 42 entries; no tarball. |
| `git diff --exit-code` | 0 | Reviewer reports the locked checkout clean. |

`npm audit --omit=dev --json` in the accepted dependency source exited `1`, reporting 8 vulnerable package entries (3 high, 5 moderate, 0 critical). Audit findings are not verification-gate failures. The assigned worktree's scoped implementation/manifests check also remained clean; only this report is changed in this worktree.

## Advisory reachability

Audit metadata alone does not prove runtime reachability. Findings below include the advisory URL, affected installed range and fixed guidance, then a source/API disposition.

### High findings

| Advisory | Installed/range; fixed guidance | Source-backed disposition |
|---|---|---|
| [GHSA-22jm-h49p-29qw](https://github.com/advisories/GHSA-22jm-h49p-29qw) | SDK `1.31.0`; affected `>=1.24.0 <1.32.0`; audit guidance: SDK `1.32.0+`. | **Not used by this bridge; package exposure remains transitive.** `extensions/lib/provider-mcp.ts:29-34` imports low-level `Server`, request schemas, and `StreamableHTTPServerTransport`, not task APIs. Locked SDK `dist/esm/shared/protocol.js:36-40` installs task handlers only when `taskStore` is supplied; this bridge supplies no `taskStore` when constructing `McpServer` (`provider-mcp.ts:234-237`). |
| [GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453) | SDK `1.31.0`; affected `>=1.3.0 <1.32.0`; audit guidance: SDK `1.32.0+`. | **Unresolved residual exposure, not “Mitigated.”** `provider-mcp.ts:61` caps the custom reader at 1 MiB; `:636-651` reads the body and `:642` enforces the cap, then `:705` passes the parsed body to the transport; custom token/Host checks are at `:673-684`. These reduce exposure but do not prove safety against collection-validation amplification. The low-level `Protocol.setRequestHandler` still calls `parseWithCompat` (`node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:886-892`), so validation remains in the path. The advisory's higher-level `McpServer` `maxToolInputElements` guidance is conditional and is not asserted applicable to this low-level server. |
| [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) | `body-parser` `2.3.0`; affected `>=2.0.0 <2.4.0`; audit guidance: `2.4.0+`. | **Package reachable in the installed graph, vulnerable API not used by reviewed bridge.** The bridge imports `node:http` (`provider-mcp.ts:26`) and performs its own reader (`:636-651`); no Express or body-parser import or call is present. This is a source-backed API verdict, not an inference from npm audit alone. |
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | Zod `4.6.5`; affected `<4.6.6`; audit guidance: `4.6.6+`. | **Unresolved.** Locked SDK request schemas validate the parsed input through `parseWithCompat` (`shared/protocol.js:886-892`), and the bridge passes that input to `transport.handleRequest` (`provider-mcp.ts:705`). The 1 MiB cap and authentication reduce exposure but do not establish safety against oversized constrained-collection amplification. No dangerous payload was run. |

### Moderate findings and API distinctions

The audit metadata reports five moderate-severity vulnerable package entries, not a count of unique moderate advisories. The high-severity SDK package entry also contains moderate bearer-auth and HTTP-client redirect advisories. Some other package entries contain multiple advisories. Counts below must distinguish package-entry severity from individual advisory severity.

- [GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f), `@hono/node-server` installed `2.1.1`; affected `>=1.19.10 <2.1.3`, fixed `2.1.3+`, is **package-reachable but vulnerable API not used**. The installed locked SDK `dist/esm/server/streamableHttp.js:9` imports `getRequestListener` from `@hono/node-server`, and `:57` and `:135` use it to adapt Node HTTP requests; therefore Hono is on the runtime path despite the project directly importing `node:http`. The advisory specifically concerns `serveStatic`; installed `@hono/node-server/dist/serve-static.mjs:70-150` exports that API, but no bridge or SDK streamable transport call uses `serveStatic`. The full Hono framework and Express/body-parser are distinct APIs and are not used by this bridge's reviewed request path.
- [GHSA-5r4p-p66f-jhc7](https://github.com/advisories/GHSA-5r4p-p66f-jhc7), Hono `4.13.10`, fixed `4.13.11+`, has the same **not-used `serveStatic` API** disposition: the installed framework exposes `serveStatic` at `node_modules/hono/dist/middleware/serve-static/index.js:16-60`, but the bridge does not import or invoke Hono middleware. The SDK's Hono adapter use does not establish reachability of this separate static-file API.
- [GHSA-rvq5-wwqv-78pq](https://github.com/advisories/GHSA-rvq5-wwqv-78pq) (SDK bearer auth; fixed SDK `1.32.0+`) is **not used by the bridge**: custom `x-pi-agy-token` constant-time authentication and localhost Host checking are in `provider-mcp.ts:673-684`; no SDK bearer/OAuth middleware is configured.
- [GHSA-6prh-2h8m-c8cw](https://github.com/advisories/GHSA-6prh-2h8m-c8cw) (SDK client HTTP/OAuth redirects; fixed SDK `1.32.0+`) is **not used**: this code creates a server transport using the low-level imports at `provider-mcp.ts:29-34` and has no SDK client or OAuth request path.
- The `fast-uri`, `ip-address`, and `qs` moderate findings are transitive package findings with no reviewed bridge import or API call. Their exact audit entries and fixed guidance are retained in the accepted source at `.pi/reviewer/audit.json`; reachability of those unrelated transitive APIs is not established by metadata and should be rechecked after a lock refresh.

## Recommended follow-up

- The locked baseline now passes under both executor-run Node 24 and reviewer-run Node 22. Keep the reviewer logs as the accepted Node 22 evidence.
- In a separately scoped dependency change, update the MCP SDK to address its high advisories and review the low-level transport/body-validation path; do not apply higher-level `McpServer` options blindly.
- Update Zod to at least `4.6.6` and body-parser to at least `2.4.0` when intentionally refreshing the lock graph. Review the Hono adapter and static-file APIs separately; package reachability is not vulnerable-API reachability.
- Treat audit counts and advisory ranges as time-sensitive. No upgrades or source remediation were made here.

## Limitations

- Both runtime gate runs were on this macOS host, not Linux CI. `npm ci --ignore-scripts` itself ran under Node 24; the reviewer then verified the stable dependency graph under Node 22. No Node 22 Linux fresh install was executed.
- Node 22 verification is reviewer-run evidence, not executor-run evidence; its exact logs and exit files are in the final detached checkout's `.pi/reviewer/` directory. Node 24 results are the executor's original successful results.
- Two worktrees were involved as described under Provenance. The initial assigned-worktree install was superseded and removed; only the final stable checkout's reviewer logs are accepted. No claims are made that all installation activity occurred only in the final checkout.
- Advisory dispositions are based on the audit JSON, imports, reviewed project source, and installed locked SDK/Hono source. No exploit payloads, dangerous memory probes, inference turns, credentials, or personal auth/session files were used.
- The final detached checkout is intentionally retained at `/var/folders/nj/qr5wt0616qvfzt3x7y4wv9440000gn/T/pi-agy-baseline.vTbjT8/checkout` for operator review; no processes were left running.
