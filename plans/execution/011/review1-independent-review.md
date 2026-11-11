**REQUEST_CHANGES** — the qualification route is sound, but its cold-execution handoff needs one important correction.

### [PLAN-01] Make baseline reconstruction and isolation executable

- **Evidence:** **“Execution baseline and commands”**, [line 126](/Users/juanbenjumea/projects/pi-extensions/pi-agy/plans/011-qualify-patched-pi-development-host.md:126), requires a fresh worktree at `1bf9d29`, ordered prerequisite patches, and the integration manifest. Current `git status` shows `plans/` is untracked, so those artifacts will not accompany that worktree. Patch paths and transfer commands are omitted. **“Repository conventions and gate”**, [line 38](/Users/juanbenjumea/projects/pi-extensions/pi-agy/plans/011-qualify-patched-pi-development-host.md:38), requires an isolated environment, but the command table supplies bare npm/node commands without the corresponding setup.
- **Impact:** A cold executor must invent how to obtain the approved baseline and apply the isolation requirements before executing candidate dependency code. Those are load-bearing steps for preserving prior integration and avoiding personal configuration.
- **Effort:** S.
- **Risk:** LOW — documentation correction only.
- **Confidence:** HIGH — prerequisite artifacts exist under `plans/patches/`; all **74 current baseline hashes match** the integration manifest.
- **Fix sketch:** Add an explicit reconstruction recipe naming the original artifact root, seven exact patch paths/order, manifest location, sequential application, and hash-comparison command. Include the concrete environment wrapper with private HOME, cache and agent directory, explicit tool paths, working-directory verification, and STOP on missing artifacts or baseline mismatch.

Otherwise, the plan appropriately distinguishes configuration trust from unauthenticated input, SDK imports from CLI startup, and resolved packages from embedded/runtime code. The major **development-fixture qualification** route is justified; source/API/test/support changes correctly require STOP. The public transcript helpers do not justify speculative compatibility scaffolding.

This is honestly a **qualification plan, not verified remediation**. Candidate compatibility remains untested, embedded Undici provenance remains unresolved, and development pins cannot patch downstream hosts.

No files changed. No tests, installations, audits, Pi launches, model/provider calls, or host updates were performed. The existing 341-test result was treated solely as the previously passed old-fixture baseline.