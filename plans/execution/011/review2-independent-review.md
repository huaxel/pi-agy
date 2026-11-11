**REQUEST_CHANGES** — PLAN-01’s artifact reconstruction and isolation details are resolved, but the new wrapper has one material guard defect.

### [PLAN-02] Make the working-directory guard fail explicitly

- **Evidence:** In **“Execution baseline and commands”**, [line 173](/Users/juanbenjumea/projects/pi-extensions/pi-agy/plans/011-qualify-patched-pi-development-host.md:173), `clean_run` relies on `set -e` to stop after failed `cd` or directory verification. The project gate at [line 200](/Users/juanbenjumea/projects/pi-extensions/pi-agy/plans/011-qualify-patched-pi-development-host.md:200) invokes that function within an `&&` list.
- **Impact:** Bash suppresses implicit `errexit` inside functions used in those conditional positions. A failed directory guard could therefore reach the npm command in the wrong directory.
- **Effort:** S.
- **Risk:** LOW — shell guard correction only.
- **Confidence:** HIGH — static shell semantics.
- **Fix sketch:** Make both checks explicit: `cd "$WT" || return 1` and `test "$(git rev-parse --show-toplevel)" = "$WT" || return 1`. Do not rely on `set -e` for this boundary.

The exact artifact root, ordered patches, dual 74-file checks, baseline copies, private directories and prefixed commands otherwise address the previous finding. No other material gap identified in this revision.

This remains **candidate qualification, not completed remediation**; compatibility and embedded Undici provenance remain unverified.

Review was static only. No setup, worktree creation, installs, tests, Pi/provider calls, edits, credential reads or delegation occurred.