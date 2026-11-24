# Plan 021: Setup and sign-in as a relay, not a login form

Status DONE — released in 0.8.4 · Priority P2 · Effort M · Risk MEDIUM · Confidence HIGH for the mechanism, MEDIUM for the signed-out relay
Category onboarding/compliance. Depends on: none (extends the provider from 020). Written against `26fe09d` on 2026-11-23.

## Why

The complaint that started it: "auth is much easier on his repo than mine". T3
Code manages an Antigravity runtime and signs you in from inside the app; pi-agy
required you to know that `agy` must be installed and signed in, and a miss
looked like an empty `/model` picker with the fix appearing only after a turn had
already failed.

The constraint that shapes every decision here: this package's whole claim is
that it drives Google's binary instead of reimplementing it (plan 020, README's
comparison table). Anything that performs OAuth, stores tokens, or gates on the
network would trade that away for convenience. So the work is the *handoff*: name
the state, name the one command, watch for it, and relay what the binary already
produces.

## What was measured before writing code

Against the installed CLI (1.5.15), no inference, nothing destructive:

- `agy models` while unauthenticated prints `Error: Please sign in to view
  available models. Launch the CLI without arguments to sign in.` — **no URL**,
  contrary to the print-mode shape the repo had captured earlier.
- `agy acp` + `initialize` answers `agentInfo: {name: "Antigravity ACP Server"}`
  and four `authMethods`, including `oauth-personal` ("Log in with Google").
  This is the surface T3 Code drives (`binaryPath: agy` → argv `["acp"]`).
- `authenticate {methodId: "oauth-personal"}` while **signed in** returns
  `_meta.antigravity.tier` — and the only URL anywhere in that exchange is
  `https://antigravity.google/g1-upgrade`, the tier upsell.
- The official installer downloads from the CLI auto-updater, verifies a SHA-512
  from a release manifest, writes `$HOME/.local/bin/agy` (no sudo), clears the
  macOS quarantine attribute, then runs `agy install` to configure shell paths.
- A fake `HOME` does **not** simulate a signed-out account on macOS: the
  credential lives in the Keychain, which ignores `HOME`. `ANTIGRAVITY_
  EXECUTABLE_DATA_DIR` did not isolate it either.

## What changed

- `extensions/lib/setup.ts`: one state machine with injectable probes.
  `detect()` → `missing-cli` / `signed-out` / `ready` (+ model count), separating
  agy's own ENOENT message from its captured unauthenticated stderr and keeping
  anything else as an error with its original text. `waitForSignIn()` polls
  `agy models` every 3s for up to five minutes, honouring cancellation in the
  loop rather than relying on a probe to notice. `install()` runs only the pinned
  official command, bounded, output captured, then adopts `~/.local/bin` so the
  fresh binary works without restarting Pi.
- `/agy setup` renders that on the TUI status line, offers the installer behind a
  confirmation, and refreshes the model registry when the account becomes usable.
- `/login antigravity` exists because the provider declares `auth.apiKey.login`.
  Its credential is an empty api-key record — a marker that agy is signed in —
  and `resolve` stays unconditional and offline, so a transient failure cannot
  turn a working session into `No models match pattern`.
- `extensions/lib/relay-auth.ts`: drives `agy acp` → `initialize` →
  `authenticate` and forwards the URL the CLI produces into Pi's `auth_url` UI.
  It starts a child that lives until stopped (killing it would abort the browser
  flow it hosts) and is reaped on stop, deadline, or cancellation.
- `/agy doctor` appends `— run /agy setup` to exactly the two failures that
  command fixes.

## The bug the live check caught

The first relay forwarded `https://antigravity.google/g1-upgrade` as a sign-in
link, because any https URL inside the payload was collected. A URL now has to
satisfy both a sign-in field name (`auth_url`, `authorization_url`,
`verification_uri`, …) and a sign-in shape (`accounts.google.com`,
`oauth2.googleapis.com`, or an `/oauth|/login|/sign-in` path). Pinned with a
regression test built from the measured payload. Re-verified live: a signed-in
account relays nothing and reports `authenticated: true`.

## What the real sign-out test found

Three findings, all from an actual `logout` + sign-in cycle against 1.5.15 (no
fakes):

1. **A bug that the unit tests hid.** A signed-out CLI answers `agy models` with
   `Error: Please sign in to view available models. Launch the CLI without
   arguments to sign in.` — which shares no wording with the print-mode shapes
   the auth detector knew (`authentication required`, …). Detection therefore
   reported `error`, and both `/agy setup` and `/login antigravity` would have
   shown "could not verify the CLI" instead of offering the sign-in. The pattern
   now matches the measured sentence (and the other signed-out phrasings), with
   a regression test built from the verbatim message.
2. **`authenticate` completes the sign-in by itself.** After a real logout,
   driving `agy acp` → `authenticate {methodId: "oauth-personal"}` restored the
   account with no involvement from this package beyond the handshake: the next
   `agy models` succeeded. The full `login()` path ran end to end and returned
   its marker in ~55s, with the observed states `signed-out → polling →
   ready`.
3. **No sign-in URL is printed in this environment.** The only URL on the wire
   was the tier upsell, which the parser correctly refuses. So the relay's link
   branch stays unexercised here; it exists for the case where no browser can
   open (headless/SSH), where agy's print mode documents
   `Authentication required. Please visit the URL to log in:`.

4. **The command can start the sign-in, so it does.** `/agy setup` used to send
   the user to a second terminal; it now launches the same `agy acp` handshake
   that `/login` uses. Measured end to end on a real signed-out account: check at
   0s, "Starting agy's sign-in" at 1s, `ready (7 models)` at 22s, registry
   refreshed. Its wait is bounded at two minutes and the progress line says so.

5. **"Esc to stop" was a lie.** A command handler runs while the agent is idle,
   and `ExtensionContext.signal` is documented as undefined in exactly that
   state, so there was nothing to cancel with. The message no longer promises a
   key that does not exist; the bound is the exit.

## Not verified

The signed-out ACP URL envelope still cannot be observed on a desktop account
with a browser available: the flow completes before any URL would be printed,
and a fake `HOME` cannot sign out a Keychain-backed account. The parser accepts
every documented shape and reports nothing when it recognises none, in which case
the terminal handoff takes over — and, per finding 2, the sign-in succeeds
regardless.

Also unverified: the installer path on Windows, and whether `sh -c "curl … | bash"`
is the right wrapper on a machine without `sh` (Pi itself already assumes a POSIX
shell for the `agy` hints it prints).

## Evidence

- `npm run gate` at release: typecheck, **649 tests**, pack check.
- `tests/setup.test.ts` (15): all three states, transient error kept distinct,
  cancellation, poll-until-signed-in with a fake clock, deadline, and the login
  flow's four branches.
- `tests/relay-auth.test.ts` (9): URL extraction for print-mode and ACP shapes,
  the tier-upsell regression, initialize→authenticate method selection, child
  reaping, and the login wiring with and without a relay.
- Live: detection reports `ready (7 models)` signed in and `missing-cli` with
  `agy` off `PATH`; a real `logout` made detection report `signed-out` and the
  full `login()` flow returned its marker (`signed-out → polling → ready`, ~55s)
  with the account usable afterwards; the relay reported `authenticated: true`
  and relayed no URL.

## Risks

- Showing a sign-in URL in Pi puts a single-use link in the UI. That is the same
  link agy prints in a terminal and the reason Pi has an `auth_url` surface; it is
  never written to logs or to a stored credential.
- The installer is `curl | bash` of Google's own script. It is pinned in code,
  shown to the user before running, and never triggered without a confirmation —
  but it is still remote code, and the manual path stays documented right beside
  it.
- `/login antigravity` writes an auth marker into `agy`'s provider entry in Pi's
  auth store. It contains no secret; `logout` in Pi does not sign you out of agy,
  which the flow says explicitly.
