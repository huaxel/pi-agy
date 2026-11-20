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

Quick start: install, make sure `agy` is signed in, open `/model`, choose `antigravity/*`. If anything looks wrong, `/agy doctor`.

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

  What that does and doesn't cover: agy keeps one merged MCP registry, so your globally configured agy servers sit alongside the bridge and stay reachable during a Pi turn — the bridge adds Pi's tools, it does not sandbox agy's own. Shell and file writes are the strict part. While Pi exposes `bash`/`write`/`edit`, agy's own equivalents are denied for the session, so those calls can only happen through Pi — and that deny holds even under `--dangerously-skip-permissions`, which is on by default. Reads are not denied: agy opens and lists files itself, steered toward Pi's tools by guidance rather than blocked. So the bridge controls the operations that change your workspace, not every action agy takes, and agy still runs its own tool loop.

Your last observed model list is cached in `agy-provider-models.json` beside `agy-config.json`. It holds only ids `agy models` actually returned, and exists because Pi resolves configured model scopes at startup — without it, a configured `antigravity/<id>` reports `No models match pattern` before the provider has discovered anything.

> Don't install `@estebanforge/pi-antigravity-bridge` alongside this package — both register the `antigravity` provider and the `/agy` command.

## Delegation: hand a task to agy

`agy_execute` runs a task in `plan`, `accept-edits`, or `sandbox` mode, streams progress, and returns the result plus quota details and a summary of newly changed files.

| What you need | How |
|---|---|
| Pick a model or configured agent | `model`, `agent` |
| Pin one exact model id | `model=<id>` |
| Continue earlier work | `conversation_id`, `continue`, `new_session` |
| Long runs without steering | `background=true`, then `agy_tasks` to poll, collect, or cancel |
| Bring Pi context along | `context=summary` or `context=recent` (default: none) |
| Inspect agents, sessions, quota | `agy_agents`, `agy_history`, `agy_usage` |

Runs are serialized per working directory, and timeouts or cancellations stop the whole agy process tree.

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

In `accept-edits` mode Pi confirms before writes. agy's own permission behaviour is controlled by its config and by `skipPermissions` below.

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

- **The bridge is local and locked down.** It listens on `127.0.0.1` only, requires a per-process secret header, and caps each authenticated request at 1 MiB and 10,000 structural elements across 64 levels, rejecting oversized input before any session or tool work happens.
- **No runtime dependencies.** Everything the bridge needs from MCP lives in `extensions/lib/mcp-transport.ts`: JSON-RPC 2.0 dispatch, the initialize handshake, `tools/list`, `tools/call`, `ping`, session ids, and both JSON and SSE framing. The official SDK is a dev dependency, so the bridge tests keep driving this server with a real client and `agy` itself still connects to it — while an install of this package pulls nothing. Pi supplies the peer packages. `npm audit` is clean, and CI blocks on high or critical advisories and missing registry attestations.
- **Turns in flight are serialized** per directory, so a delegated run can never race a provider turn in the same project.

## Development

```bash
npm run gate          # typecheck + full suite + pack check, in one exit code
npm test              # full suite
npm run typecheck
npm run test:live     # read-only, no inference
npm run test:bridge   # billable: deny-rule and park-path evidence
npm run test:provider # billable: two turns, usage and reuse
```

`test:live` only reads your installed CLI. `test:bridge` proves the `--settings` deny document really stops agy's built-in shell tool — with a positive control, so a pass can't mean the model just declined to act — and reports how many bridged calls one turn produces. `test:provider` spends two short turns on a budget alias (`npm run test:provider -- <model-id>`) to assert streamed text, the conversation id, native usage, and that a reused process reports a delta rather than cumulative counters.

Tests are qualified against the Pi SDK fixture at exactly 1.5.2, which needs Node >= 22.19.0 (ran on 22.23.4).

## License

MIT
