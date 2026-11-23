# @juanbenjumea/pi-agy

Use Google's Antigravity models from inside Pi — no API key, no second window. If `agy` is installed and signed in, its models appear in your `/model` picker like any other model, and you can hand whole tasks to it on demand.

```bash
pi install npm:@juanbenjumea/pi-agy
```

**Needs:** Node.js >= 20.3 and an installed, signed-in `agy` CLI. It reuses the credentials `agy` already has; this package never asks for a key or manages your login.

## What you get

- **Your existing agy models, in Pi.** Pick `antigravity/<model>` in `/model` and Pi is talking to Antigravity. Nothing to configure, nothing to paste.
- **Models that stay current.** The list comes from `agy models` at startup and every time the picker opens. When Google ships a new model, it shows up — you don't wait for a package update.
- **Real control where it matters.** While Pi can run a shell or write a file, agy's own equivalents are denied for that session, so those actions land in Pi — with your permissions, approval prompts, and diffs. Verified to hold even with agy's permission bypass on.
- **Conversations that behave.** Multi-turn continuity, attached images, a warm process per project — not a fresh cold start on every message.
- **Model tiers without clutter.** A family with several thinking levels is one picker entry with a level toggle (`low` → `xhigh`), not five near-identical rows.
- **Delegation when you want it.** `agy_execute` and `/agy` hand a task to agy as a subprocess, with optional background runs and quota reporting.

## Setup

Two steps, and only the second one is interactive:

```bash
pi install npm:@juanbenjumea/pi-agy
# then, if you do not have it yet:
curl -fsSL https://antigravity.google/cli/install.sh | bash   # Windows: irm https://antigravity.google/cli/install.ps1 | iex
```

1. **Install agy** — Google's CLI, if it is not already there.
2. **Sign in to agy** — run `agy` once and finish its browser sign-in.

Then open `/model` and choose `antigravity/*`.

**Don't want to guess which step you're on?** `/agy setup` names the exact
state — `missing agy`, `not signed in`, `ready` — offers Google's own installer
if the CLI is absent, and if you are signed out it *starts* agy's sign-in for
you: a browser window opens, and the command watches until the account is usable
(about twenty seconds in practice) then refreshes the picker. The same flow is
available as `/login antigravity`, for people who look there first.

**Auth deliberately stays with agy.** This package performs no OAuth, stores no
Google credentials, and opens no connection to Google — it runs Google's own
binary, which owns the account and the network call. That is why setup is a
handoff and not a login form: `/login antigravity` only records a marker that
`agy` is signed in.

It does, however, relay. `agy` ships an agent-protocol mode (`agy acp`) whose
`authenticate` step exists so a client can trigger its sign-in; `/login
antigravity` drives that handshake and, when the CLI hands back a sign-in URL,
shows it as an openable link in Pi. agy still performs the OAuth exchange and
opens the browser. If no URL arrives, you get the terminal command instead —
the same handoff as before.

## How this differs from other Antigravity integrations

Several Pi packages expose `antigravity/*` models and mean very different
things by it. Worth knowing which one you installed:

| | who authenticates | who calls Google | models come from |
|---|---|---|---|
| **pi-agy** (this package) | `agy`, untouched by this package | the official `agy` binary, `--input-format stream-json` | `agy models` |
| `pi-antigravity` and its forks | the package (own OAuth, tokens in `~/.pi/agent/auth.json`) | the package itself, against `cloudcode-pa.googleapis.com` | the Cloud Code Assist API |
| *reference:* T3 Code (not a Pi package) | the Antigravity runtime it manages | the official `agy` binary, `agy acp` | the CLI's ACP handshake |

The middle row is the shape Google has been disabling accounts over: a
reimplementation talking to the consumer OAuth endpoints directly. The first and
last rows differ only in which documented mode of the same binary they drive.
This package never holds a Google token, never opens a connection to Google, and
the only `https://` URLs in `extensions/` are the official installer links.

That is a description, not a permission: whether third-party harnesses may drive
the CLI at all is Google's call, and this package is not affiliated with or
endorsed by Google. Use it with an account you are willing to carry that risk on.

## Two ways to use it

Either one works alone; both work together.

| | Use it as | Best for |
|---|---|---|
| **Native models** | A Pi provider (`antigravity/*`) | Everyday chat and coding where you want Antigravity's models driving Pi's tools |
| **Delegation** | `agy_execute` / `/agy` | Handing off a self-contained job, long background runs, second opinions |

## Native models: `antigravity/*`

- **Always current** — discovered from `agy models` at startup and on each picker open. No hardcoded model list to go stale.
- **Fails honestly** — a failed refresh keeps the last good catalog and `/agy doctor` says why. Before the first successful discovery the picker is empty rather than inventing names. Cache-only refreshes never run the CLI.
- **Effort tiers, catalog-driven** — a family offering several tiers is one entry with a toggle; the chosen level becomes `--effort`. Single-tier families keep agy's exact qualified id and never get `--effort`, because agy rejects that combination outright.
- **Persistent turns** — one warm `agy` process per working directory, and attached images are staged where agy can read them.
- **Real Pi integration** — by default a localhost MCP bridge gives agy read-only Pi context and lets it call your active Pi tools through Pi's normal approval flow. Switch it off with `"providerBridge": false` or `/agy bridge off`.

  What that does and doesn't cover: agy keeps one merged MCP registry, so your globally configured agy servers sit alongside the bridge and stay reachable during a Pi turn — the bridge adds Pi's tools, it does not sandbox agy's own. Shell and file writes are the strict part. While the bridge is on, agy's own shell and write tools are denied for the session regardless of which Pi tools this session has, so those operations can only happen through Pi's tools — and a session whose allowlist excludes them simply has none. That deny holds even under `--dangerously-skip-permissions`, which is on by default. Reads are not denied: agy opens and lists files itself, steered toward Pi's tools by guidance rather than blocked. So the bridge controls the operations that change your workspace, not every action agy takes, and agy still runs its own tool loop. Turning the bridge off (`"providerBridge": false`) is the deliberate way to run agy plain, with its own tools and no Pi policy.

Your last observed model list is cached in `agy-provider-models.json` beside `agy-config.json`. It holds only ids `agy models` actually returned, and exists because Pi resolves configured model scopes at startup — without it, a configured `antigravity/<id>` reports `No models match pattern` before the provider has discovered anything.

> Don't install `@estebanforge/pi-antigravity-bridge` alongside this package — both register the `antigravity` provider and the `/agy` command.

## Delegation: hand a task to agy

`agy_execute` runs a task in `plan`, `accept-edits`, or `sandbox` mode, streams progress, and returns the result plus quota details and a summary of newly changed files.

| What you need | How |
|---|---|
| Pick a model or configured agent | `model`, `agent` |
| Pin one exact model id | `model=<id>` |
| Continue earlier work | `conversation_id`, `continue`, `new_session` |
| Long runs without steering | `background=true`; the footer tracks the newest run, `agy_tasks` polls, collects, or cancels |
| Bring Pi context along | `context=summary` or `context=recent` (default: none); `plan`/`sandbox` ask first, naming what leaves |
| Inspect agents, sessions, quota | `agy_agents`, `agy_history`, `agy_usage` |
| Ask agy about itself | `/help`, `/usage`, `/skills`, `/permissions`, `/changelog` (answered by agy, zero tokens) |

A prompt that is one of agy's own print-mode commands (`/help`, `/usage`, `/skills`, `/plugin:list`, …) is answered by agy itself with zero tokens and no conversation. Everything else is task text: the prompt reaches agy with slash/skill expansion disabled, so `/review this` or `/tmp/x is broken` cannot turn into instructions. The exception is `mode: "plan"`, which needs expansion on because agy ignores `--mode plan` while it is disabled.

Runs are serialized per working directory, and timeouts or cancellations stop the whole agy process tree. A foreground run streams its steps as they happen. A background run reports the newest step and its elapsed time in the session footer, and `agy_tasks status` adds how long ago the last activity was, so a slow step and a stalled one do not look the same.

### The `/agy` command

Runs tasks straight from the TUI — no second LLM turn, and what you confirm is what runs.

```text
/agy plan flash investigate the failing tests
/agy plan model=argon investigate the failing tests
/agy continue fix the remaining issues
/agy sessions
/agy doctor
```

Also: `/agy agents`, `/agy usage`, `/agy quota`, `/agy bridge on|off|status`.

The model picker refreshes the full concrete id list each time it opens, with alias shortcuts alongside. Discovery failures show the reason and mark cached choices as unverified.

### How aliases resolve

Aliases resolve against your live catalog, never a shipped table. An alias is a family plus an optional tier — `sonnet`, `flash-low`, `pro-high` — and matches an id containing those tokens contiguously, with a tier only as trailing tokens.

- A family with no tiers answers its tier aliases with its top id, so a flagship named without a tier still serves `pro`.
- A retired tier stops resolving and fails with an actionable message instead of quietly substituting a neighbour.
- The concrete id that actually ran is always reported in the run receipt.

In `accept-edits` mode Pi confirms before writes. The dialog names the model that will actually run, the working directory, the pre-run dirty state, and — when the workspace defines one — the verify loop with the file that defines it (`just ci (justfile)`), because approving the run approves that repository code too. agy's own permission behaviour is controlled by its config and by `skipPermissions` below.

`plan` and `sandbox` cannot modify your workspace, so they run without that dialog — that is what makes them the cheap way to iterate. They do ask before `context` forwarding: the dialog names the mode, the size, and an excerpt of what leaves, because the text reaches agy and, through it, a model provider. Without a UI, or on decline, the run does not happen and nothing is forwarded.

## Configuration

Optional file: `$PI_CODING_AGENT_DIR/agy-config.json` (default `~/.pi/agent/agy-config.json`).

```json
{
  "defaultModel": "flash-medium",
  "skipPermissions": true,
  "providerBridge": true
}
```

- `defaultModel` — default model for delegated tasks. Always wins when set.
- `defaultModelCommand` — shell command whose stdout is a model alias, for quota-aware defaults. Output is validated and cached for a few minutes. Runs verbatim via `sh -c`, so only point it at something you control.
- `quotaBalancing` — with no default configured, flip to `sonnet` once the Gemini group carried most recent work (≥ 3 conversations in 24h at > 75% share). Tune with `AGY_DEFAULT_MODEL_WINDOW_HOURS`, `AGY_DEFAULT_MODEL_MIN_SESSIONS`, `AGY_DEFAULT_MODEL_GEMINI_SHARE`. Unreadable usage means no signal, never an error.
- `skipPermissions` — agy's permission-bypass flag for `accept-edits` runs, default `true`. Set `false` to keep agy's own checks; note agy's print mode has no interactive approval path, so restricted operations may then simply fail.
- `providerBridge` — the provider's Pi-tool bridge, default `true`.

Resolution order: `defaultModel` → `defaultModelCommand` → `quotaBalancing` → built-in fallback.

## Notes for the curious

- **The bridge is local and locked down.** It listens on `127.0.0.1` only, requires a per-process secret header, and caps each authenticated request at 1 MiB and 10,000 structural elements across 64 levels, rejecting oversized input before any session or tool work happens. It bounds the other direction too: a Pi tool result longer than 64,000 characters is relayed head and tail with the omitted count named, so a runaway tool cannot flood agy's context.
- **No runtime dependencies.** Everything the bridge needs from MCP lives in `extensions/lib/mcp-transport.ts`: JSON-RPC 2.0 dispatch, the initialize handshake, `tools/list`, `tools/call`, `ping`, session ids, and both JSON and SSE framing. The official SDK is a dev dependency, so the bridge tests keep driving this server with a real client and `agy` itself still connects to it — while an install of this package pulls nothing. Pi supplies the peer packages. `npm audit` is clean, and CI blocks on high or critical advisories and missing registry attestations.
- **Turns in flight are serialized** per directory, so a delegated run can never race a provider turn in the same project.
- **A signed-out run fails immediately.** agy waits on a browser sign-in that cannot happen inside a
  delegated run or a provider turn. That stderr line stops the child and returns one recovery
  sentence, rather than the run idling out its timeout. The OAuth URL is never copied into Pi.
- **A turn fails on silence, not on duration.** agy can legitimately emit nothing while one shell tool or one large edit runs, and a flat per-turn deadline killed those turns mid-work. A live phase now stops only after 15 minutes with no stream activity, and a 30-minute ceiling bounds a phase that keeps emitting activity without finishing. The error says which one fired: `went quiet for 15m with no stream activity` or `timed out`. A phase parked on a Pi tool is owned by Pi and has its own deadline.
- **The prompt cache lives upstream, and it outlives a process.** Most of a turn's input is a stable prefix (agy's own system prompt and built-in tool schemas, plus the bridged MCP schemas), so a continued conversation reads it from the provider cache instead of paying for it again: a live two-turn check on one child reported `input 10181 / cache_read 0`, then `input 2119 + cache_read 8137`. Measured on agy 1.5.15, that cache survives a *process* restart too — a second process resuming the same conversation reported `cache_read 28626` on its first turn — so the win comes from continuing the conversation, not from keeping one child alive. The child is still kept for 15 minutes of idle, matching the cache lifetime, because a cold start is latency you do not need to pay inside that window.
- **Usage counters are conversation-cumulative, not per turn.** agy's `result.usage` is a running total, so consecutive turns are differenced against the last snapshot to avoid double counting. The snapshot is remembered per conversation across recycles (bounded to eight), which is what lets a respawned child still report the `cache_read` of its first resumed turn instead of a blank row.
- **A new process continues the conversation instead of replaying it.** What the last completed turn sent — transcript length, prefix and reply fingerprints, a hash of the system prompt, the bridged tool catalog key, and the conversation's cumulative usage — is recorded in `agy-sessions.json` beside the conversation id. A fresh process validates that record against the transcript it is about to send and, when it still holds, sends only the new messages; a stale one degrades to a full prompt. The recorded usage snapshot is what lets that first turn report its own tokens instead of a blank row: measured `input 2674 + cache_read 7249` when the upstream prefix cache answered and `input 9732` when it did not, against `~19k` for the same turn replayed in full.
- **A diverged transcript starts a new conversation.** After a `/tree` rewind, a regenerated reply or a compaction, agy's server-side conversation still holds turns Pi no longer has. Resuming it would put the abandoned turns in the model's context and replay the kept ones a second time, so the next turn starts clean and sends the transcript as the whole conversation. `/agy doctor` names this case. A changed system prompt or tool catalog is *not* divergence: that history is still valid, so it resumes.

## Development

```bash
npm run gate          # typecheck + full suite + pack check, in one exit code
npm test              # full suite
npm run typecheck
npm run test:live     # read-only, no inference
npm run test:bridge   # billable: deny-rule and park-path evidence
npm run test:provider # billable: two turns, usage and reuse
npm run test:bridge-contract  # synthetic wiring check, no agy process or inference
```

`test:live` only reads your installed CLI. `test:bridge-contract` drives the provider's real registration, tool projection and loopback MCP transport against an in-memory fake `agy` child: one active Pi tool is listed beside the five bridge builtins, a fixed synthetic call round-trips, a second client initializes on the same bridge, and any real process launch fails the run. It proves local wiring only, not that agy discovers a model or answers a turn. `test:bridge` proves the `--settings` deny document really stops agy's built-in shell tool — with a positive control, so a pass can't mean the model just declined to act — and reports how many bridged calls one turn produces. `test:provider` spends two short turns on a budget alias (`npm run test:provider -- <model-id>`) to assert streamed text, the conversation id, native usage, and that a reused process reports a delta rather than cumulative counters.

Tests are qualified against the Pi SDK fixture at exactly 1.5.2, which needs Node >= 22.19.0 (ran on 22.23.4).

## License

MIT
