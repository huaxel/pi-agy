# @juanbenjumea/pi-agy

Reliable Antigravity delegation for Pi: quota-aware runs, resumable tasks,
repo verification, cancellation, and trustworthy diff summaries.

Pi stays the primary agent and explicitly delegates scoped work to the
Antigravity CLI (`agy`). Choose this package when you want dependable delegation
from any Pi model; choose a provider integration when you want Antigravity to be
your primary model for every turn.

Enhanced fork of [`@bacnh85/pi-agy`](https://github.com/bacnh85/pi-extensions/tree/main/pi-agy).

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
| Conversation resume | None | `conversation_id`, `continue`, session store with task summaries and custom-agent identity, `/agy sessions` picker, `agy_history` discovery tool — runs that time out or are cancelled are recorded too |
| Verify injection | `npm test` only | `just ci` first, then `npm test`/`uv run pytest` |
| Post-write summary | None | Appends `git diff --stat` for newly-dirty files only; pre-existing dirt (including renames and unstaged edits) is listed separately and never misattributed |
| Preflight | Every call | Health/model checks cached 5 min per process; model quotas refresh every minute |
| Quota discovery | None | Read-only `/usage` probe exposes model-specific remaining quota and reset times to agents |
| Custom agents | None | Read-only `agy_agents` / `/agy agents` discovery plus validated `agent` / `agent=name` selection via `--agent` |
| Subagent visibility | None | Native stream progress plus a capped per-run roster in result details/receipts; observations never claim live lifecycle control |
| Concurrency | Unlocked | Per-directory lock (in-process + filesystem, symlink-aware), lock wait counts against the timeout |
| Transient failures | Fatal | One retry when agy fails before doing any work |
| Cancellation | Direct child only | Full process-tree kill on cancel/timeout via detached process groups; a fully delivered result is preserved |

Auth is unchanged: existing `agy` OAuth (`~/.gemini/oauth_creds.json`).

## Antigravity provider (`/model` picker)

This package also registers an `antigravity` provider, so agy-backed models
appear in Pi's global `/model` picker as `antigravity/<id>` (for example
`antigravity/gemini-3-8-flash`). Model entries are discovered from live
`agy models` output at startup (refreshed in the background, no `/reload`
needed); when discovery fails, a fallback catalog keeps the picker populated
and selection yields a clear runtime error instead of an empty list.

Gemini bases with multiple effort tiers expose Pi's thinking-level toggle,
which is sent as agy `--effort` (clamped to tiers the base accepts — Pro has
no medium). Fixed-thinking families (Claude, GPT-OSS) keep agy's exact slug
and never receive `--effort`.

Attached images are staged as files under a process-stable 0700 root
(passed as `--add-dir` so sandboxed turns can open them) and referenced by
path in the turn prompt, so agy opens them with its file tools; images on
tool results ride the delivery the same way. Capped at the 8 newest images /
8 MiB each with strict base64 validation — failures degrade to omitted notes.
Each staging has a dispose handle owned by its turn (suspensions carry
theirs forward); terminal settle, stale-cancel, abandonment, and session
shutdown all reclaim.

Each turn runs on a persistent `agy --input-format stream-json` driver
process (one per working directory) with the transcript rendered as text.
The process is reused across turns — follow-ups skip cold start and re-auth —
and recycled when the model, effort, permissions, or conversation drifts; idle
processes are reaped after five minutes and everything is disposed on session
shutdown. Completed turns are recorded to the same session store as
delegation runs, so `/agy sessions` can resume them. Provider turns take the
same per-directory lock as delegation runs (lock waits count against the turn
timeout), so a provider turn never races `agy_execute` in the same directory.

Read-only tool bridge: provider turns also get an extra `--add-dir`
carrying a localhost MCP server (`pi-agy-tools`) that exposes Pi-side
context agy cannot see otherwise — `agy_sessions_list`, `agy_quota_report`,
and `agy_model_catalog`. The server binds 127.0.0.1 with a per-process
shared secret, serves only reads, and never touches your global agy config.
Set `"providerBridge": false` in `agy-config.json` to run provider turns
plain.

Mutating tool bridge: agy turns can also call Pi tools directly. The bridge
parks the MCP call, the provider emits a real shadow `toolCall`, and Pi
executes it with normal permissions, approvals, and diff review; the next
turn's `toolResult` completes the parked call and agy continues. Only active
non-builtin tools are exposed (`agy_*` and `AskAntigravity` excluded — no
recursive delegation); the catalog refreshes per turn and the driver recycles
when it changes so agy always sees a fresh tool list. Suspended turns hold
the agy child with timers off, re-arm on resume, and are abandoned loudly on
cancel, teardown, or a 30-minute stall cap.

Do not install `@estebanforge/pi-antigravity-bridge` alongside this package:
both register the `antigravity` provider id and an `/agy` command.

## Timeouts & cancellation

`timeout_ms` (default 5m, max 10m) is a hard parent-side deadline — lock
waits, preflight probes, and post-run summaries all count against it. When
it fires, the full agy process group is killed so nested tools cannot
outlive the run. agy's own `--print-timeout` is set five seconds later because
agy 1.1.28+ returns partial output with exit code 0 when that internal timer
fires; Pi therefore remains the authoritative timeout owner. Terminal result
envelopes also fail closed: when agy supplies a status, only `SUCCESS` and `OK`
are accepted, even if a failed result carries an empty response and exits 0.

Active tool updates show bounded intent (for example a tool action or async
threshold) but never echo full command lines, which may contain secrets.
Subagent spawn steps likewise produce bounded progress and a final per-run
observation roster (maximum 32). An `active at last event` entry describes the
last stream record only; it does not claim that a controllable process remains live.
Background commands are intentionally not detached or managed out-of-band:
agy exposes no reliable headless task lifecycle or task-to-process ownership,
so timeout/cancellation still kills the full process tree and prevents work from
continuing after the directory lock is released.

The deadline never discards finished work:

- A response that fully arrived before the kill is returned with an
  explanatory note instead of being thrown away — even if cancellation or
  the deadline landed between delivery and process exit.
- Post-run steps cut short by the deadline (the accept-edits diff summary)
  are skipped with a note rather than failing the run.
- The conversation id is recorded on timeout and cancellation, so the run
  stays resumable via `conversation_id`, `/agy continue`, or `/agy sessions`.
  Timeout errors distinguish ids successfully recorded for `/agy continue` or
  `/agy sessions` from ids merely observed when local persistence failed; the
  latter can still be resumed by passing `conversation_id` explicitly.

## Tool params (new)

| Param | Description |
|-------|-------------|
| `background` | Return immediately with a task handle instead of waiting; poll with `agy_tasks status` and collect the result. The run keeps its `timeout_ms` deadline; cancel via `agy_tasks`. |
| `conversation_id` | Resume agy conversation by ID |
| `continue` | `--continue` most recent conversation |
| `new_session` | Force fresh session; set `false` to reuse last ID for dir |
| `effort` | Reasoning effort via `--effort` where supported; `gpt-oss` accepts it, while Claude thinking models reject it and Gemini aliases already encode it |
| `agent` | Optional configured custom agy agent name; discover names with `agy_agents` |
| `stream` | Use `stream-json` (default `true`) |
| `context` | Optional Pi history handoff: `none` (default), `summary`, or `recent` |
| `mode` | `accept-edits` by default; use `plan` for exploration/review |

`agy_execute` refreshes quota information before each run (best effort) and
returns it in `details.quota`/`details.quota_status` and the response when
the CLI exposes structured model records. Use the separate `agy_usage` tool
when choosing a model before execution. If the selected model is explicitly
reported as exhausted, the run stops before spending another agent turn and
reports the reset information. When no model is explicitly requested, an exhausted
quota-balanced default automatically falls back to the first reported available
model family. Explicit model selections fail clearly instead of silently
switching models.
Use `agy_usage` with `model` (for example `model=sonnet`) for a targeted
`available`/`exhausted`/`unknown` status. Older agy versions that do not support
headless `/usage` continue without failing the task. The extension requires
agy 1.1.11+ before invoking `/usage`; older versions are refused safely because
that command could otherwise consume model quota as a prompt.

When agy emits `subagent` stream steps, `agy_execute` returns a capped,
control-safe `details.subagents` list and appends the same observed summary to
tool content. Native rendering deduplicates that synthetic appendix and shows
compact/expanded roster metadata. Conversation ids and log URIs from nested
subagents are deliberately not exposed as lifecycle handles.

Context handoff is opt-in and text-only. `summary` sends up to 12,000
characters from the latest durable summaries and four conversational messages;
`recent` sends up to 40,000 characters from the recent conversational tail.
Both exclude Pi system prompts, thinking, tool arguments, tool results, images,
and custom extension messages. The current delegated task is appended after the
reference context and remains authoritative.

The `agy_agents` tool runs the read-only `agy agents` subcommand and returns
configured custom-agent names without spending a model turn. Pass an exact
name as `agy_execute agent`; initial selection is always explicit, while known
conversation resumes restore their recorded agent.

The `agy_history` tool lists recorded conversations for a directory — ids,
models, custom agents, ages, and one-line task summaries — so agents can find a
`conversation_id` to resume; `/agy sessions` offers the same in the TUI
picker. Summaries are stored locally (first ~80 chars of each prompt), and a
recorded custom agent is restored when that conversation resumes.

The `agy_tasks` tool manages background runs started with
`agy_execute background=true`: `list` shows tasks per directory, `status`
polls state and recent progress, `collect` returns the terminal result and
frees the record, and `cancel` aborts a live run. Background runs keep their
`timeout_ms` deadline, serialize on the per-directory lock like foreground
runs, and are recorded to the session store on completion so nothing is lost
when a payload goes uncollected; session shutdown aborts anything still live.

## Human-callable `/agy` command

Run agy directly from the Pi TUI — fast path when fully specified, wizard otherwise:

```
/agy flash fix git conflicts        # fully specified → runs immediately
/agy plan sonnet review the diff    # mode + model + prompt
/agy agents                         # list configured custom agents (read-only)
/agy plan agent=gsd-debugger investigate the crash
/agy context=summary plan sonnet review our earlier decision
/agy plan                           # wizard: model select → task editor
/agy                                # wizard: mode → model → task editor
/agy continue fix the tests         # continue this directory's last conversation
/agy timeout=10m sonnet big task    # raise the run cap (also 90s / 1500ms; bare = minutes)
/agy sessions                       # pick a recorded conversation to resume
/agy doctor                         # diagnose CLI, models, agents, quota, config, sessions, lock, provider, and repo gate
/agy usage                          # inspect model quotas and reset times
/agy bridge [on|off]               # inspect or toggle the provider MCP bridge (takes effect next turn)
```

Leading option tokens (`plan`, a model alias, `agent=name`, `continue`,
`context=summary`, `context=recent`, `timeout=…`) are consumed in any order;
the remainder is the prompt. `/agy continue` reuses the last model and custom
agent when the session store recorded them. `timeout=` caps at 10m.

First token optional: `accept-edits` / `plan` / `sandbox` mode prefix, then a
model alias (`flash`, `pro`, `sonnet`, `opus`, `gpt-oss`, …), then the prompt.
The interactive wizard and direct `agy_execute` calls default to
`accept-edits`; the wizard confirms before writing. Use `plan` explicitly for
exploration/review. Sandbox runs do not bypass agy permission checks.

`/agy doctor` performs no inference and spends no model tokens. It reports the
installed CLI version, discoverable stable model aliases, optional custom-agent
discovery, quota support, active config, recorded sessions, workspace lock state,
provider runtime state (driver turns/reuses/recycles, bridge tool count,
suspended turns awaiting Pi tools, live image staging), and detected
verification gate.

Missing pieces open interactive dialogs (mode select, model select with
descriptions, multi-line task editor). `accept-edits` asks for confirmation
before writing. The command then runs agy directly with the selected parameters;
progress is shown in the throttled status bar and a durable, expandable receipt
is appended to Pi's transcript. Receipts are TUI-only custom entries: they are
not sent to the primary model, and context handoff excludes them. Stored task
text is capped at 500 characters and result text at 8,000 characters. Stripped-down
hosts fall back to a normal notification. `/agy usage` performs the same read-only
quota check without starting a model turn; `/agy agents` likewise lists custom
agents without inference.

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
  operations may be reported as `denied_actions` instead of prompting. The
  extension rejects a denied run with no response and visibly warns when agy
  returns an explanatory response alongside denied actions.
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

With an installed, authenticated `agy`, run `npm run test:live` to verify the
CLI version, stable model catalog, custom-agent roster, quota schema, and doctor
integration against the real binary. The smoke uses read-only commands only and
does not start an inference turn or spend model tokens.

## License

MIT
