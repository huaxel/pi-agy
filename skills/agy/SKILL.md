---
name: agy-delegate
description: Optional, quota-limited Antigravity delegation for substantial work
argument-hint: 'prompt="..." [model=...] [mode=plan|accept-edits|sandbox]'
license: MIT
---
# agy-delegate

Use agy sparingly; your current tools and agent are the default.

- Use `agy_execute` only when the user explicitly asks to use agy. Never delegate autonomously based on perceived benefit. Never launch `agy_execute` through a Herdr pane.
- Prefer one focused run; avoid duplicate or parallel calls. Continue only genuinely unfinished work with `conversation_id` or `continue=true`.
- Use `mode=accept-edits` for scoped implementation and `mode=plan` only when exploration without edits is useful. Do not add separate planning or cross-model review runs by default; reserve them for user requests or material risk. After edits, inspect `git diff` and run the project check (usually `just ci`).
- Keep `context=none` unless prior discussion is needed; prefer `summary` to `recent`. Check `agy_usage` only when quota availability affects a decision.
- Use `background=true` only for long runs that need no steering; collect results with `agy_tasks collect` and cancel abandoned runs. Use `agy_agents` only when the user asks for a configured custom agent.
- Never delegate irreversible production changes.

When the user requests live steering and Herdr is available, run interactive `agy` in a Herdr pane instead of using `agy_execute`. Prompts sent while AGY is busy queue; use Ctrl+C to interrupt its current command before redirecting it. Herdr-run AGY does not take pi-agy's per-directory lock, so use a separate worktree if it could overlap with Pi-managed AGY work.

For tool parameters and current behavior, rely on the `agy_execute` and related tool descriptions; consult the package README for setup and configuration.
