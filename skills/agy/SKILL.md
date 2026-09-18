---
name: agy-delegate
description: >
  Delegate bulk implementation, scaffolding, repetitive refactors, and
  exhaustive test generation to the Antigravity CLI (agy).
argument-hint: "prompt=\"...\" [model=flash-low|flash-medium|flash-high|pro-low|pro-high|sonnet|opus|gpt-oss] [mode=plan|accept-edits|sandbox]"
license: MIT
---

# agy-delegate

Use the `agy_usage` tool to inspect model-specific quota and reset times when
availability matters, then use `agy_execute` to offload large scaffolding,
repetitive refactors, or exhaustive test generation via the Antigravity CLI.

## Prerequisites

1. Install the Antigravity CLI (a Go binary, not pipx):

   ```bash
   curl -fsSL https://antigravity.google/cli/install.sh | bash
   ```

2. Authenticate in a terminal (one-time):

   ```bash
   agy
   ```

3. Verify the CLI works:

   ```bash
   agy --version
   agy models
   ```

## Tool usage

```
agy_execute prompt="Refactor all snake_case variables to camelCase in src/models/"
agy_execute prompt="Generate exhaustive unit tests for src/auth/" model=flash-low
agy_execute prompt="Plan the migration to ESM" model=sonnet mode=plan digest=true
agy_execute prompt="Implement the approved plan" conversation_id=<id> mode=accept-edits
agy_execute prompt="Adversarial review the diff" model=opus effort=high mode=plan
agy_usage
```

## Modes

| Mode | Purpose |
|------|---------|
| `plan` | Exploration and planning — no edits |
| `accept-edits` (default) | Implementation — agy applies edits directly |
| `sandbox` | Preview changes without applying |

## Rules

- **Default to `mode=plan`** for exploration; escalate to `accept-edits` only for scoped batches.
- **Always review the `git diff`** after agy runs with `accept-edits`.
- **Run `just ci`** (or the project gate) after write modes in this repo.
- **Never use agy for irreversible production changes.**
- Reuse `conversation_id` or `continue=true` for multi-step plan → implement → review.
- Use `flash-medium` by default, `flash-low` for trivial/high-volume work, and `flash-high` for difficult agentic work.
- Escalate within the Gemini quota group to `pro-low` or `pro-high` only when needed.
- Use `sonnet` for normal Claude-group coding/review; reserve `opus` for the hardest architecture or root-cause work.
- Use `gpt-oss` when an open-model alternative is specifically desired.
- Set `effort` (low/medium/high) for finer reasoning control on `sonnet`/`opus`/`gpt-oss` runs; Gemini aliases encode effort in the model id.
- For consequential work, have one family produce and the opposite family review with `mode=plan`; do not spend both groups on trivial tasks.
- Batch related work, avoid parallel calls within one shared-quota group or directory, and use `digest=true` (default) for non-write tasks.

## Enhancements over upstream pi-agy

- **Quota discovery** — `agy_usage` and `/agy usage` report model-specific remaining quota and reset times; executions refresh quota snapshots and return machine-readable `quota_status` as well.
- **Streaming progress** — live tool steps via `stream-json` and Pi `onUpdate`.
- **Conversation continuity** — `conversation_id`, `continue`, session store under `$PI_CODING_AGENT_DIR/agy-sessions.json` (or `~/.pi/agent/agy-sessions.json` by default).
- **Repo-aware verify** — prefers `just ci` when a justfile defines `ci:`.
- **Diff summary** — accept-edits results append newly-dirty files only; pre-existing dirt is listed separately, never misattributed.
- **Per-directory lock** — serializes concurrent agy calls on the same tree across Pi processes (symlink-aware).
- **Cancellation** — abort/timeout kills the full agy process tree, and streamed records plus responses are size-bounded.
