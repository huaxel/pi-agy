# @juanbenjumea/pi-agy

Enhanced fork of [`@bacnh85/pi-agy`](https://github.com/bacnh85/pi-extensions/tree/main/pi-agy).

Delegates bulk work to the Antigravity CLI (`agy`) while Pi stays the conductor.

## Install

```bash
pi install npm:@juanbenjumea/pi-agy
```

Requires Node.js >= 20.3.

## What's different from upstream 0.3.1

| Feature | Upstream | This fork |
|---------|----------|-----------|
| Live progress | Final text only | `stream-json` → Pi `onUpdate` cards |
| Model aliases | Hardcoded ids | Live `agy models` catalog (newest stable generation wins; preview/experimental ignored), static map fallback |
| Conversation resume | None | `conversation_id`, `continue`, session store with task summaries, `/agy sessions` picker, `agy_history` discovery tool — runs that time out or are cancelled are recorded too |
| Verify injection | `npm test` only | `just ci` first, then `npm test`/`uv run pytest` |
| Post-write summary | None | Appends `git diff --stat` for newly-dirty files only; pre-existing dirt (including renames and unstaged edits) is listed separately and never misattributed |
| Preflight | Every call | Health/model checks cached 5 min per process; model quotas refresh every minute |
| Quota discovery | None | Read-only `/usage` probe exposes model-specific remaining quota and reset times to agents |
| Concurrency | Unlocked | Per-directory lock (in-process + filesystem, symlink-aware), lock wait counts against the timeout |
| Transient failures | Fatal | One retry when agy fails before doing any work |
| Cancellation | Direct child only | Full process-tree kill on cancel/timeout via detached process groups; a fully delivered result is preserved |

Auth is unchanged: existing `agy` OAuth (`~/.gemini/oauth_creds.json`).

## Timeouts & cancellation

`timeout_ms` (default 5m, max 10m) is a hard parent-side deadline — lock
waits, preflight probes, and post-run summaries all count against it. When
it fires, the full agy process group is killed so nested tools cannot
outlive the run.

The deadline never discards finished work:

- A response that fully arrived before the kill is returned with an
  explanatory note instead of being thrown away — even if cancellation or
  the deadline landed between delivery and process exit.
- Post-run steps cut short by the deadline (the accept-edits diff summary)
  are skipped with a note rather than failing the run.
- The conversation id is recorded on timeout and cancellation, so the run
  stays resumable via `conversation_id`, `/agy continue`, or `/agy sessions`.

## Tool params (new)

| Param | Description |
|-------|-------------|
| `conversation_id` | Resume agy conversation by ID |
| `continue` | `--continue` most recent conversation |
| `new_session` | Force fresh session; set `false` to reuse last ID for dir |
| `effort` | Reasoning effort via `--effort` (low/medium/high); mostly useful for `sonnet`/`opus`/`gpt-oss` since Gemini aliases encode effort in the model id |
| `stream` | Use `stream-json` (default `true`) |
| `mode` | `accept-edits` by default; use `plan` for exploration/review |

`agy_execute` refreshes quota information before each run (best effort) and
returns it in `details.quota`/`details.quota_status` and the response when
the CLI exposes structured model records. Use the separate `agy_usage` tool
when choosing a model before execution. If the selected model is explicitly
reported as exhausted, the run stops before spending another agent turn and
reports the reset information.
Use `agy_usage` with `model` (for example `model=sonnet`) for a targeted
`available`/`exhausted`/`unknown` status. Older agy versions that do not support
headless `/usage` continue without failing the task. The extension requires
agy 1.1.11+ before invoking `/usage`; older versions are refused safely because
that command could otherwise consume model quota as a prompt.

The `agy_history` tool lists recorded conversations for a directory — ids,
models, ages, and one-line task summaries — so agents can find a
`conversation_id` to resume; `/agy sessions` offers the same in the TUI
picker. Summaries are stored locally (first ~80 chars of each prompt).

## Human-callable `/agy` command

Run agy directly from the Pi TUI — fast path when fully specified, wizard otherwise:

```
/agy flash fix git conflicts        # fully specified → runs immediately
/agy plan sonnet review the diff    # mode + model + prompt
/agy plan                           # wizard: model select → task editor
/agy                                # wizard: mode → model → task editor
/agy continue fix the tests         # continue this directory's last conversation
/agy timeout=10m sonnet big task    # raise the run cap (also 90s / 1500ms; bare = minutes)
/agy sessions                       # pick a recorded conversation to resume
/agy usage                          # inspect model quotas and reset times
```

Leading option tokens (`plan`, a model alias, `continue`, `timeout=…`) are
consumed in any order; the remainder is the prompt. `/agy continue` reuses the
last model when the session store recorded one. `timeout=` caps at 10m.

First token optional: `accept-edits` / `plan` / `sandbox` mode prefix, then a
model alias (`flash`, `pro`, `sonnet`, `opus`, `gpt-oss`, …), then the prompt.
The interactive wizard and direct `agy_execute` calls default to
`accept-edits`; the wizard confirms before writing. Use `plan` explicitly for
exploration/review. Sandbox runs do not bypass agy permission checks.

Missing pieces open interactive dialogs (mode select, model select with
descriptions, multi-line task editor). `accept-edits` asks for confirmation
before writing. The command then runs agy directly with the selected parameters;
progress is shown in the (throttled) status bar and the final response is
notified — no second LLM turn or custom TUI surface. `/agy usage` performs the
same read-only quota check without starting a model turn.

## Config

Optional `$PI_CODING_AGENT_DIR/agy-config.json` (default
`~/.pi/agent/agy-config.json`):

```json
{
  "skipPermissions": true,
  "defaultModel": "flash-medium"
}
```

- `skipPermissions` (default `true`) — pass `--dangerously-skip-permissions`
  for `accept-edits` runs. Set `false` to leave agy's own permission checks in
  place; note print mode has no interactive approval path, so restricted
  operations may fail instead of prompting.
- `defaultModel` — alias used when `agy_execute` omits `model`/`tier`.
- `defaultModelCommand` — shell command whose stdout sets the default alias
  when `defaultModel` is unset (an explicit `defaultModel` always wins).
  Must print one valid alias; failures and invalid output fall back to the
  built-in default. Result cached ~5 min per process. Escape hatch for
  custom resolvers; prefer `quotaBalancing` below.
- `quotaBalancing` — steer the default across agy's quota families by
  recent usage balance: when the Gemini group (flash/pro) carried ≥75% of
  the last 24h of recorded conversations (min 3), the default flips to
  `sonnet` so routine delegation rests the hot group. Tune with
  `AGY_DEFAULT_MODEL_WINDOW_HOURS`, `AGY_DEFAULT_MODEL_MIN_SESSIONS`, and
  `AGY_DEFAULT_MODEL_GEMINI_SHARE`. Missing/corrupt stores mean no signal.

Tool results record `permissions_skipped` in `details` for auditability.

Live catalog resolution ignores preview/experimental model ids so an
unstable entry can never silently become the default. Set
`PI_AGY_ALLOW_PREVIEW=1` to opt into preview ids explicitly.

## Development

```bash
npm test
npm run typecheck
```

## License

MIT
