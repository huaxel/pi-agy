<!--
Format: one line per user-visible change. State what changed for the user, not how
it was proven or which test fails without it — evidence, reproductions and design
reasoning belong in the commit body. Group by release only; themed subsections are
for releases big enough to need them.
-->

## 0.8.4

- `/agy setup` names whether agy is missing, signed out or ready, offers Google's own installer, and starts the sign-in itself instead of asking for a second terminal.
- `/login antigravity` exists, and relays agy's own sign-in into Pi; what it stores is a marker, not a token, and `resolve` never gates on the network.
- A signed-out CLI is recognised as signed out, not as a broken one.
- `/agy doctor` points at `/agy setup` for the two failures that command fixes.
- A signed-out run no longer loses a warning to the sign-in marker's dedupe slot, and the background footer listener is detached on shutdown instead of accumulating across reloads.

## 0.8.3

- `plan` and `sandbox` ask before forwarding transcript context, naming the mode, the size and an excerpt; with no UI, or on decline, nothing leaves.
- A resumed conversation belongs to the transcript that consumed it, so another session in the same directory starts fresh.
- Reads outside any approval step are bounded and confined to the workspace.
- One bridge client can no longer make the host do unbounded work per batch.
- An oversized image is rejected before its payload is decoded, and a planted temp file can no longer redirect the catalog cache write.
- Rendered agy output carries no terminal control sequences.
- Deep effort tiers survive a cold start, and each workspace keeps its own roster and reasoning baseline.
- A tool schema that cannot be flattened without losing constraints is advertised composed instead of widened.
- The verification gate is found on the physical path, and the dialog names the directory that defines it.

## 0.8.2

- A bridged turn denies agy's own shell and write tools unconditionally, and a bridge that fails to start refuses the turn instead of running without deny rules.
- An unreadable `agy-config.json` fails closed; saves rename atomically and refuse to overwrite a file they cannot parse.
- Accept-edits probes no longer run repository git config, and the dialog names the verify loop and the file that defines it (`just ci (justfile)`).
- Attribution sees files created inside an already-untracked directory, and reads changed paths from git instead of the truncated display text.
- `truncate()` stays inside its cap, stream framing survives a dropped oversized record, id-less tool calls are refused, and an empty terminal response no longer masks denied actions.
- A successful `agy models` roster replaces the alias map instead of merging into it, so a retired alias stops resolving; the model spawned is the one the dialog showed.
- Every action in both workflows is pinned to a commit SHA, and CI declares a read-only token.
- The deny document is asserted on the launched argv by the bridge-contract gate and verified against agy 1.5.14 with its positive control.

