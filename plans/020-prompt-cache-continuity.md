# Plan 020: Prompt-cache continuity for provider turns

Status DONE (implemented locally, uncommitted) · Priority P1 · Effort M · Risk MEDIUM · Confidence HIGH for the mechanics, MEDIUM for the cache claims
Category cost/latency. Depends on: none. Written against `26fe09d` on 2026-11-23.

## Why

The user's words: "can you help me improve cache hit performance", then "i've
heard agy is pretty bad at cache hit and also that there's a 15mins cache only".

Both halves are partly true, and pi-agy was making the second half worse than it
had to be. A provider turn sends a large stable prefix (agy's own system prompt,
its 60 built-in tool schemas, and the bridged MCP schemas) before it reaches
anything Pi wrote. When the conversation continues, that prefix is served from
the upstream prompt cache instead of being paid for again. Everything pi-agy
does that restarts a conversation, restarts the child, or replays the transcript
puts that prefix — or the client-side prompt — back on the bill.

## What was measured first (live, agy 1.5.15, `gemini-3.8-flash-low`)

All numbers are `result.usage` from `--output-format stream-json`, either raw or
through the provider. No number below is inferred from documentation.

| Scenario | input | cache_read |
|---|---|---|
| Warm child, turn 1 (fresh conversation) | 10181 | 0 |
| Warm child, turn 2 (same conversation) | 2119 | 8137 |
| Same conversation, **new process**, first resumed turn | 20742 (cumulative) | 28626 |
| Same conversation, new process, delta prompt, cache answered | 2674 | 7249 |
| Same conversation, new process, delta prompt, cache missed | ~9700 | 0 |

Two facts fall out of this, and both were load-bearing for the change:

1. `result.usage` is **conversation-cumulative, across processes**. A
   conversation that reported `input 16311 / cache_read 0` reported
   `input 20742 / cache_read 28626` when a second process resumed it, i.e. the
   totals continued. Differencing against the last committed snapshot is
   therefore correct even after a respawn — and a counter that regressed must
   still fall back to re-priming.
2. The upstream cache outlives the client process. The win comes from
   *continuing the conversation*, not from keeping one child alive.

## What was wrong in pi-agy

1. **A five-minute idle reap.** `PROVIDER_DRIVER_IDLE_MS` was `5 * 60_000`, so
   any pause longer than that killed the warm child and paid a cold start plus a
   re-primed usage baseline inside the window the cache was still live.
2. **`cacheRead` reported as zero after any recycle.** `killChild()` dropped the
   usage baseline, and `spawn(..., resume)` always re-primed, so the first turn
   after an idle reap or an `--effort` change showed `0` input and `0` cache
   reads even though the driver had already counted that conversation.
3. **Diverged transcripts appended to the stale conversation.** After a `/tree`
   rewind, a regenerated reply or a compaction, the delta path was impossible and
   the fallback replayed the whole rewritten transcript *into the old
   conversation*: turns Pi had rewound stayed in the model's context, the kept
   ones were sent twice, and the conversation's usage counters covered a longer
   history than Pi's transcript.
4. **The sync record lived only in memory.** The first turn of every new Pi
   process replayed up to 24 KB of transcript into a conversation agy already
   had, because the delta decision and the divergence check both vanished with
   the process.
5. **Cold turns reported nothing.** With no baseline, that first resumed turn
   reported `0` tokens while paying the whole prefix — the opposite of the
   visibility this work is about.

## What changed

- `PROVIDER_DRIVER_IDLE_MS` is 15 minutes, matching the cache lifetime it sits in
  front of.
- The driver keeps the last committed cumulative snapshot per conversation
  (bounded to eight, newest wins) instead of forgetting it with the child.
- The provider detects transcript divergence itself — rewritten or shrunk
  prefix, replaced assistant anchor — rather than relying on which fallback
  reason fired first, and starts a fresh conversation so the full prompt *is* the
  conversation. A changed prelude (system prompt, tool catalog) still resumes:
  that history is still valid. An abandoned conversation is also banned
  in-process, so a failed restart cannot resurrect it from the session store on
  the retry.
- `agy-sessions.json` records the sync: conversation id, model, transcript
  length, prefix and reply fingerprints, a **hash** of the system prompt (never
  the prompt), the bridged tool catalog key, and the cumulative usage snapshot.
  A fresh process validates it with the same comparisons a live turn uses, so a
  stale record costs a full prompt and never produces a wrong delta. Foreign
  records are validated on read and refused on write; a record naming a different
  conversation is dropped.
- The usage snapshot travels to the driver as a baseline hint and back as the new
  snapshot, so the first cold-resumed turn reports its own tokens. A failed or
  partial turn clears the record — only for the conversation that turn touched.

## The cold-resume miss, found

What started as an unexplained 1-in-5 cache hit on cold resumes turned out to be
pi-agy's own doing, and it took two candidate causes rather than one:

**Two directories pi-agy adds to agy's workspace changed name per process** — the
MCP bridge's config dir (`bridge-<pid>-<seq>`) and the image staging root
(`pi-agy-images-<mkdtemp>`). Every agy child receives both in `--add-dir`, so the
workspace surface it is given differed between Pi processes and the upstream
prefix cache could not be reused.

Measured on 1.5.15, two turns per row, `cache_read` on the *second* turn of a
fresh process:

| variation | result |
|---|---|
| per-process staging dir (what shipped) | `input 19006 / cache_read 0` |
| one fixed staging dir for both processes | `cache_read 7326` |
| staging stable, bridge off | `cache_read 7339` |
| staging stable, bridge on, stable config dir, **different port inside it** | `cache_read 7293` |
| everything stable, through the provider | `input 2250 / cache_read 7420` |

Two consequences worth recording:

- The port, the token and the config file's contents do **not** matter; only the
  directory path does. So the bridge keeps binding an ephemeral port and writing
  a fresh URL — the path is what had to be stable.
- The earlier "ruled out" conclusions for `--add-dir` paths and for the bridge
  were **wrong**: each was confounded by the other, since both were per-process
  at the same time. Ruling a cause out requires the other causes to be fixed
  first, which is the real lesson of this plan.

Fixes: the staging root is a stable, verified directory under the temp dir (not a
symlink, a directory, owned by this user — otherwise it falls back to a private
`mkdtemp`), with a 24-hour sweep of stale workspace scopes; the bridge prefers a
workspace-derived port and a workspace-derived config dir, and falls back to the
old per-process dir and an ephemeral port when that port is already taken by
another live session in the same workspace.

## What is still not claimed

Nothing about the cache left open: a cold resume now reads the prefix, twice
measured, with the mechanism understood.

Not verified: the installer path on Windows (plan 021), and behaviour on a
machine whose `--add-dir` set differs for some other reason (another package
adding a per-process directory would reproduce the same bug).

## Evidence

- `npm run gate`: typecheck, **569 tests**, pack check.
- New regression tests: cold-resume delta from the store, cold-resume divergence
  → fresh conversation, failed turn clears only its own record, store
  round-trip/validation/refusal, retained usage baseline across a recycle,
  rewound/regenerated turns restart while a prelude change resumes, abandoned
  conversation stays abandoned after a failed restart.
- Mutation checks: removing the store seed fails both cold-resume tests;
  removing the abandonment guard fails the restart test; restoring the old
  re-prime path fails the recycle test.
- Live: `npm run test:provider` (warm child, two turns) reports
  `input 2119 + cache_read 8140`; the cold-resume table above came from raw `agy`
  probes plus provider runs, and the final row is a real provider cold resume.
- Tests: the bridge's config dir and port are stable per workspace and fall back
  when the port is taken; the staging root is stable across a re-resolve and
  refuses a planted symlink.

## Risks

- A persisted record is a claim about a conversation this process did not run.
  It is bounded by the same fingerprint comparisons as a live turn, so the worst
  case is an extra full prompt — never a wrong delta — and the record is dropped
  when it names another conversation.
- Two Pi sessions in one directory share `agy-sessions.json`; the last writer
  wins. Fingerprint validation degrades that to a full prompt.
- Conversation counters are cumulative per the measurement above. If a future
  `agy` build resets them per process, `diffAgyUsage` returns `undefined` on the
  regression and the turn re-primes — a blank usage row, not a wrong one.
