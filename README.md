# @juanbenjumea/pi-agy

Use Google's Antigravity CLI (`agy`) from Pi. This package adds two ways to work:

- **Delegate a task** to `agy` with Pi tools such as `agy_execute`, or the `/agy` command.
- **Use agy as a Pi model provider** through `antigravity/*` in `/model`, with an optional bridge to Pi tools.

Install with:

```bash
pi install npm:@juanbenjumea/pi-agy
```

Requires Node.js >= 20.3 and an installed, authenticated `agy` CLI. Existing agy OAuth credentials are used; this package does not manage authentication.

## Delegate tasks

`agy_execute` runs a task in `plan`, `accept-edits`, or `sandbox` mode. It streams progress and returns the result, quota details when available, and a summary of newly changed files. Runs are serialized per working directory; timeouts and cancellations stop the agy process tree.

Useful options include:

- `model` and `agent` to select a model or configured agy agent
- `conversation_id`, `continue`, and `new_session` to resume work
- `background=true` to return a handle, then use `agy_tasks` to poll, collect, or cancel
- `context=summary|recent` to optionally pass bounded Pi conversation context (default: none)

The `/agy` command runs tasks from Pi's TUI and can also list agents, inspect quota, diagnose setup, and select saved conversations. For example:

```text
/agy plan flash investigate the failing tests
/agy continue fix the remaining issues
/agy sessions
/agy doctor
```

In `accept-edits` mode, Pi confirms before writes. agy's own permission behavior is controlled by its configuration and the package's `agy-config.json` settings below.

## Use agy as a Pi model

The package registers an `antigravity` provider. Select discovered models as `antigravity/<model>` in Pi's `/model` picker. Models are discovered from `agy models`, with a fallback catalog if discovery fails. Gemini thinking levels map to agy's supported effort tiers.

Provider turns use a persistent agy process per working directory and can stage attached images for agy to read. By default, an MCP bridge gives agy read-only Pi context and lets it call active Pi tools through Pi's normal permission and approval flow. Set `"providerBridge": false` in `agy-config.json` to disable the bridge.

Do not install `@estebanforge/pi-antigravity-bridge` alongside this package: both register the `antigravity` provider and `/agy` command.

### Bridge input limits

Authenticated bridge POSTs retain a **1 MiB UTF-8 body cap** and allow at most **10,000 object properties plus array elements** across the entire parsed JSON-RPC body, including metadata, with at most **64 container levels** (root container = level 1). Scalar string content counts toward bytes, not structural elements. Overly wide/deep requests return HTTP **413** before SDK validation, session allocation or tool parking; oversized byte streams retain the existing connection-close behavior. Authentication and localhost Host checks happen first, but authentication alone is not a complexity budget.

The bridge uses the SDK's low-level `Server`, not the high-level `McpServer` tool validator, so it enforces these local structural limits rather than relying on `maxToolInputElements`. These are defensive input bounds, not a guarantee against all resource exhaustion.

The SDK dependency floor is `^1.32.2`; the repository lock qualifies SDK 1.32.2, Zod 4.6.7 and body-parser 2.4.0. A library consumer resolves its own dependency graph: the SDK still permits older Zod through `^3.25 || ^4.0`, and overrides in this package would not enforce a consumer's resolutions. Audit the actual consumer tree; a patched repository lock is not a universal downstream security guarantee.

## Configuration

Optional file: `$PI_CODING_AGENT_DIR/agy-config.json` (default `~/.pi/agent/agy-config.json`). For example:

```json
{
  "defaultModel": "flash-medium",
  "skipPermissions": true,
  "providerBridge": true
}
```

`defaultModel` sets the default for delegated tasks. `skipPermissions` controls agy's permission-bypass flag for `accept-edits` runs; set it to `false` to retain agy's checks. `providerBridge` toggles the provider's Pi-tool bridge.

## Development

Development tests are qualified against the exact Pi SDK fixture version 1.5.2, which requires Node >=22.19.0; qualification ran on Node 22.23.4. The resolved development graph is qualified; embedded Undici is not independently attested.

```bash
npm test
npm run typecheck
```

With an installed agy CLI, `npm run test:live` runs read-only integration checks without starting an inference turn.

## License

MIT
