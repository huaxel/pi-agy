# Plan 019: Live subagent and step counts for a running turn

Status DONE (implemented locally, uncommitted) · Priority P2 · Effort S–M · Risk LOW · Confidence HIGH
Category observability. Depends on: none. Written against `6c5ac83` on 2026-11-20.

## Why

The user's words: "not seeing what's happening". The footer and `agy_tasks` now
report the newest activity line and how long ago it was, which fixed the blind
spot for a stalled run. What a line cannot answer is shape: two subagents were
launched, one finished, one is still working, or a run is doing its tenth tool
step with nothing else in flight.

T3 Code answers this for Antigravity by reconstructing batches from agy's own
profile directory. That path was investigated here and rejected (see below);
the same information is already in our stream, just thrown away as a string.

## What already exists (verified in this checkout)

- `extensions/lib/subagents.ts` models a subagent as
  `{ step_index?, slot, name, type?, task?, status: "active" | "done" | "error", duration_seconds?, error? }`,
  bounded by `MAX_OBSERVED_SUBAGENTS = 32`.
- `stream.ts:315` accumulates those observations into `AgyRunResult.subagents`
  for every parsed step (`observeAgySubagents`).
- `stream.ts:140` turns a subagent step into one progress label
  (`formatAgySubagentProgress`), so live activity already mentions subagents.
- `execute.ts:266` appends a `## Subagent activity` section to a delegated
  result, and `execute.ts:306` puts `subagents` into the returned details, which
  `agy_tasks collect` exposes.

So the missing piece is not detection. It is (a) an aggregate view while the run
is in flight and (b) the same aggregate in `agy_tasks status` and `/agy doctor`
instead of only in a finished result.

## Why not read agy's own store

Inspected read-only, metadata only, on this machine (agy 1.5.13):

- `~/.gemini/antigravity-cli/conversations/<conversation-id>.db`, SQLite. Tables:
  `steps`, `parent_references`, `battle_mode_infos`, `executor_metadata`,
  `gen_metadata`, `trajectory_meta`, `trajectory_metadata_blob`.
- `steps` columns: `idx, step_type, status, has_subtrajectory, metadata,
  error_details, permissions, task_details, render_info, step_payload,
  step_format`. Payloads are protobuf blobs; `parent_references` is
  `(idx, data blob)` and held 0 rows in the sampled conversation.
- `brain/<conversation-id>/` holds artifacts such as `implementation_plan.md`.

Reading it would mean decoding unpublished protobuf and reading a user's
conversation store, and Node 22 carries `node:sqlite` only behind
`--experimental-sqlite`, so a zero-dependency package would need the external
`sqlite3` binary. All three costs are real, and the data is already in the stream
we parse. Rejected. Do not add this dependency without a new decision.

## Scope

Change: `extensions/lib/subagents.ts`, `extensions/lib/stream.ts`,
`extensions/lib/background.ts`, `extensions/tools.ts`,
`extensions/lib/provider.ts` (activity label only), `extensions/lib/doctor.ts`,
and their tests. No new dependencies, no profile-directory reads, no change to
what is buffered per run beyond one small aggregate.

## Steps and tests

1. **Add a pure aggregate.** `summarizeObservedSubagents(agents): { active, done,
   error, total, latest? }` in `subagents.ts`, reusing `clean()` for `latest`.
   Test: empty list, mixed statuses, duplicate slots, the 32-observation bound,
   and a `latest` that prefers `active` over terminal entries.
2. **Carry the aggregate.** Extend the delegation progress path so the same
   aggregate can be attached to a background snapshot without re-parsing labels:
   add `subagents?: AgyObservedSubagent[]` to `BackgroundRunCallbacks` progress
   (or a second optional parameter `activity?: { subagents?: ... }`), then
   `BackgroundTaskSnapshot.subagents` is the summary, not the list.
   Test: runner exposes the summary, `lastActivityAt` still advances, and a
   task with no subagent steps carries `undefined` rather than zeros.
3. **Surface it.** Append `· 1/2 subagents` (active/total, plus `failed N` when
   errors exist) to `formatLiveBackgroundStatus`, and add a `subagents:` line to
   `agy_tasks status` for running tasks. Keep `MAX_LIVE_STATUS_CHARS = 120`, so
   the suffix must be dropped before the label is clipped.
   Test: label formatting with and without subagents, with an error, and at the
   length bound; `agy_tasks status` text for running and terminal tasks.
4. **Provider turns.** `provider.ts` already forwards `onActivity` labels; when
   the label is a subagent step, append the same suffix from the accumulator.
   Test: a fake turn emitting two subagent steps and one terminal result yields
   an activity label carrying `1/2 subagents`.
5. **Doctor.** Add the active driver's aggregate to the Provider line only when
   a turn is live, e.g. `provider used · 1/2 subagents`. Test in `doctor.test.ts`
   with the existing fake provider status fixtures.
6. Run the focused suites, then `npm run gate`.

## Implementation record

Implemented in the working tree: `summarizeObservedSubagents` and
`formatSubagentCounts` in `subagents.ts`; `AgyProgressMeta` on the stream
progress handler, emitted by `spawn.ts`; meta threaded through `execute.ts` and
`BackgroundTaskRunner`; `subagents` on `BackgroundTaskSnapshot`, appended to
`formatLiveBackgroundStatus` (dropped before clipping), to `agy_tasks status`
and to list snapshots; the provider driver suffixes a subagent activity label
and exposes the aggregate in its snapshot, which `/agy doctor` reports while a
turn is live. Tests: subagents 8, background 20, stderr 6, full suite 554,
typecheck, packaging and the isolated contract gate pass. Not independent-reviewed
and not released.

## Done and maintenance

A running background task and a live provider turn both say how many subagents
are in flight, `agy_tasks status` repeats it, and `/agy doctor` reports it only
while a turn is live. Nothing new is persisted, no profile directory is read, and
the aggregate is derived from stream data that was already parsed. If agy changes
its subagent step shape, `observeAgySubagents` is the single place to follow, and
the summary stays a pure function of it.
