# GPU VRAM gauge in the frame editor

## Problem

The dev GPU (RTX 2070, ~7.6 GiB VRAM, Turing) has crashed the platform
outright when too many frames were tracked in one job or the CUDA cache
wasn't cleared between jobs. ROADMAP.md's Phase 2a deviation log documents
the ~7.6 GiB ceiling as a confirmed hardware limit (OOM happens on the
first frame's backbone pass, not a gradual creep), and explicitly defers
"the exact GPU-memory cap enforced on the frame editor's Track
Backward/Forward inputs" to a later plan. Today nothing measures VRAM live
anywhere — only reactive `torch.cuda.empty_cache()` calls in the adapters,
plus hardcoded numbers in code comments from manual `nvidia-smi`
observation during past debugging sessions (confirmed by direct
investigation of `ml-worker/app/tasks.py`, `sam2_adapter.py`,
`sam3_adapter.py`, and `backend/app/jobs/models.py`).

Users have no visibility into how close a Track/Predict action is to
exhausting VRAM before the process crashes.

## Goal

Give the user a live-during-jobs VRAM indicator in the frame editor: a
traffic-light status (green/yellow/red) plus the exact numbers
(`X.X / 7.6 GiB`), so a crash is visible coming rather than a surprise.

## Scope

- Measure real VRAM usage on the ml-worker process during SAM2/SAM3
  `predict`/`track` jobs, via `torch.cuda.mem_get_info()` (already an
  in-process dependency — no new library).
- Surface that measurement through the existing `Job` polling path the
  frontend already uses (`useJob`, 1500ms `refetchInterval` via React
  Query) — no new endpoint, no new polling loop.
- Render a compact widget in the frame editor's `ToolsPanel`.

## Out of scope (deferred, not part of this design)

- Any live/idle-time polling when no job is running. The gauge is
  job-scoped: it only gets fresh data while `predict`/`track` runs. This
  was an explicit user decision (piggyback on `useJob`, not a new
  always-on endpoint) — simpler, no new infrastructure, accepted trade-off
  that the number goes stale between jobs.
- pynvml or any GPU metric beyond used/total memory (no utilization %, no
  temperature). `torch.cuda.mem_get_info()` is sufficient and adds no new
  dependency.
- Automatically capping the Track Backward/Forward numeric inputs based on
  the measured VRAM. This spec only surfaces the number; enforcing a cap
  on those inputs remains the open question ROADMAP.md already deferred to
  "a following plan" — out of scope here, revisit separately once the
  gauge has been used in practice to see what a sane cap actually is.
- Any change to eviction behavior (`_evict_sam3_models()` /
  `_evict_sam2_models()` in `ml-worker/app/tasks.py`) — those already run
  unconditionally before each job; this spec only adds visibility, not new
  eviction logic.

## Data flow

```
ml-worker task (predict/track)
  -> torch.cuda.mem_get_info() at task start (predict) or once per
     tracked frame (track, alongside the existing progress update)
  -> writes used/total bytes directly onto the Job row (same DB the
     Celery task already writes `progress`/`status` to -- no message
     broker round-trip involved)
  -> GET /jobs/{id} (existing endpoint) includes the new fields
  -> frontend's existing useJob hook (already polling every 1500ms while
     a job is pending/running) picks them up on its next poll
  -> VramGauge reads the latest job's fields from the same React Query
     cache useJob already populates
```

## Backend changes

**`backend/app/jobs/models.py`**: two new nullable columns on `Job`,
sibling to `progress`:

```python
vram_used_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
vram_total_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
```

Deliberately **not** folded into the existing `payload` JSON column.
`payload` is already the job's *input* (`frame_id`, `prompts`, etc., read
by the task at the start) and is never merged/patched mid-task in the
current code (`sam2_predict`/`sam3_track`/etc. only ever *read*
`job.payload`, never write back to it — the *output* goes into a separate
`Annotation.payload`). Writing VRAM data into the same field would risk a
whole-object overwrite clobbering the input the task still needs to read
on a later step (e.g. `track`'s per-frame loop). Separate columns avoid
that hazard entirely and need no key-collision reasoning.

A migration adds both columns (nullable, no backfill needed — historical
jobs simply show no VRAM data, which the frontend already treats as "no
data yet").

**`backend/app/jobs/schemas.py`** (`JobRead` or equivalent): add
`vram_used_bytes: int | None` and `vram_total_bytes: int | None` so they
flow through `GET /jobs/{id}` automatically. Regenerate `openapi.json` per
CLAUDE.md's standing instruction.

**`ml-worker/app/tasks.py`**: at the point each task already does its DB
write for `progress` (predict: once, at completion; track: once per
tracked frame, per the existing per-frame progress-update loop), also set
`job.vram_used_bytes` / `job.vram_total_bytes` from
`torch.cuda.mem_get_info()`:

```python
free_bytes, total_bytes = torch.cuda.mem_get_info()
job.vram_used_bytes = total_bytes - free_bytes
job.vram_total_bytes = total_bytes
```

This call is cheap (a driver query, not a memory operation) and safe to
run on every progress checkpoint without measurably affecting job
duration.

## Frontend changes

**New file `frontend/src/features/annotation/VramGauge.tsx`**: presentational
component, no new data fetching of its own — takes
`vramUsedBytes: number | null`, `vramTotalBytes: number | null` as props.

- Renders nothing meaningful (a neutral "No data yet" state, muted) if
  both are `null` — the case before any job has ever run in this editor
  session.
- Otherwise renders a small colored dot/pill (traffic light) plus text
  `"X.X / Y.Y GiB"` (one decimal place).
- Thresholds, as a percentage of `vramTotalBytes` (portable across GPUs,
  not hardcoded to this dev machine's 7.6 GiB):
  - `< 60%`: green
  - `60–85%`: yellow
  - `> 85%`: red
- When the widget is showing a stale value (no job currently
  pending/running), render at reduced opacity — no pulsing/animation, just
  a visual "this number isn't live right now" cue. "Stale" is determined
  by the caller (see below), not by the gauge itself re-deriving job
  status.

**`frontend/src/features/annotation/ToolsPanel.tsx`**: render
`<VramGauge>` in a new compact section between "Model" and "Label".
`FrameEditor.tsx` already tracks `activeJobId`/`jobQuery` — thread
`jobQuery.data?.vram_used_bytes`, `jobQuery.data?.vram_total_bytes`, and
`jobQuery.data?.status` down through `ToolsPanel`'s existing prop-drilling
pattern (it already receives `onTrack`, `procedureId`, etc. the same way).

**Staleness**: `ToolsPanel` (or `FrameEditor`) keeps the last non-null
`(used, total)` pair in a ref/state across job transitions (a job going
`succeeded`/`failed` doesn't clear the numbers), and derives "is this
live" from whether `jobQuery.data?.status` is currently
`pending`/`running`. This mirrors the same
`pending`/`running`/`succeeded`/`failed` status vocabulary
`describeJobBanner` in `FrameEditor.tsx` already uses for the progress
banner — no new status modeling needed.

## Testing

- Backend: a unit test on the predict/track task (wherever the existing
  progress-write tests already live in `ml-worker/tests/`) asserting
  `vram_used_bytes`/`vram_total_bytes` get set on the `Job` row after a
  run. GPU-dependent — follow the same `@pytest.mark.skipif` /
  GPU-availability pattern already used for other real-GPU tests in this
  suite (per ROADMAP.md's Phase 2a notes), rather than mocking
  `torch.cuda.mem_get_info()` into a fake success.
- Frontend: `VramGauge.test.tsx` — pure presentational component, easy to
  unit test all three threshold colors plus the null/"no data yet" state
  and the stale/reduced-opacity state, all via props (TDD: write these
  first per CLAUDE.md's standing TDD requirement).
- `ToolsPanel.test.tsx`: extend to assert the gauge section renders and
  receives the right props from a mocked `useJob` response.

## Explicitly not addressed here

Per "Out of scope" above: no idle-time polling, no pynvml, no automatic
Track input capping, no eviction logic changes. If the gauge in practice
shows jobs regularly crossing into red before a crash, that's the signal
to open a *separate* brainstorm for capping Track Backward/Forward against
measured VRAM headroom — deliberately not decided here.
