# Sequence grid: "Rank Quality" and "Find Similar" cleanup suggestions

## Problem

The sequence grid's Select mode (`SequenceGridToolbar.tsx`, shipped
2026-08-06) currently only supports manual checkbox selection and bulk
delete. The originating UI/UX spec
([docs/specs/2026-07-23-platform-ui-ux-design.md](../../specs/2026-07-23-platform-ui-ux-design.md#select-mode--bulk-frame-cleanup))
describes two suggestion tools meant to sit on top of it — "Find similar"
and "Rank quality" — that were explicitly deferred as a "later iteration"
when the base toolbar shipped. This spec is that iteration.

With long endoscopy sequences (hundreds of frames extracted from video),
manually scanning for blurry/out-of-focus frames or near-duplicate frames
to prune before annotation is slow. The reference Django project
(`segmentation`) already solved this with a
working `rank_frames`/`find_similar_frames` implementation
(`segmentation/views.py`), which this design adapts to this codebase's
architecture (FastAPI + Celery `ml-worker` + React), while upgrading both
algorithms to their current state of the art (see "Algorithm choices"
below) rather than porting the reference's exact models.

## Goals

1. **Rank Quality** — a toolbar control that scores every frame in the
   sequence with a no-reference image-quality metric and auto-checks the
   worst N% (percentage configurable), so the annotator can bulk-delete
   low-quality frames (motion blur, out-of-focus, bubbles/glare) without
   opening each one individually.
2. **Find Similar** — a toolbar control that embeds every frame and
   auto-checks near-duplicate frames (cosine similarity above a
   configurable threshold), keeping the best-quality frame in each
   duplicate cluster unchecked, so the annotator can prune redundant
   frames from slow camera movement.
3. Both are **suggestions, not automatic actions**: they only pre-check
   candidate frames (visually marked) in the existing Select-mode
   checkbox set. The annotator reviews, can uncheck any frame, and the
   existing "Delete selected" button performs the actual deletion — no
   new deletion path.
4. Auto-checked frames are visually distinguishable from manually-checked
   ones (red outline + reason badge, e.g. `low quality` or `dup 96%`), and
   a "Clear marks" action can undo the auto-checks specifically, without
   touching frames the annotator checked by hand.

## Non-goals

- Any change to how "Delete selected" or manual checkbox selection work —
  both are reused unmodified.
- Persisting quality scores or embeddings on the `Frame` model permanently
  (no new `Frame` columns, no Alembic migration). Each run is a one-shot
  Celery job whose result lives only in `Job.payload`/a small result blob
  for the lifetime of that job — see "Data flow" below for why this is
  sufficient.
- "Auto-Segment Sequence" (batch SAM2/SAM3 inference across a sequence) —
  this exists in the reference project's toolbar but is an unrelated
  feature (bulk ML *annotation*, not frame cleanup) and is not part of
  this spec.
- Re-running both tools automatically when frames are added/removed after
  a run — clearing marks (or re-clicking the button) is a manual action.

## Algorithm choices

The reference project used PIQE (via `pyiqa`) for quality and ResNet-18
embeddings + cosine similarity + Union-Find for similarity. Both are
several years old; current (2026) options in the same `pyiqa` library and
the broader embedding-model landscape are meaningfully better, so this
design upgrades both rather than porting the reference verbatim:

- **Quality: TOPIQ** (`pyiqa.create_metric('topiq_nr')`) instead of PIQE.
  TOPIQ is a modern deep-learning no-reference IQA metric trained on
  large human-preference datasets and correlates better with human
  quality judgment than PIQE, which is older and mostly sensitive to
  blockiness/compression artifacts rather than the blur/glare/out-of-focus
  issues endoscopy frames actually have. Same fallback strategy as the
  reference: if `torch`/`pyiqa` fail to load, fall back to Laplacian
  variance (`cv2.Laplacian(gray, CV_64F).var()`, inverted so lower score =
  worse quality, matching TOPIQ's polarity convention below).
- **Similarity: DINOv2 (ViT-B/14)** instead of ResNet-18. DINOv2 is a
  self-supervised, vision-only model specifically stronger than
  classification-pretrained CNNs like ResNet-18 at near-duplicate
  detection and fine-grained visual similarity — it encodes pixel/geometry
  structure rather than semantic class, which is what "is this the same
  moment in the video, barely moved" actually needs. It's also a better
  fit than CLIP-style models, which are tuned for text-image alignment,
  not instance-level visual similarity. Note the reference project itself
  prototyped DINOv2 (`technology_test/dinov2_attention.py`) but shipped
  ResNet-18 in production — this design completes that upgrade.

Both metrics are exposed as `float` scores per frame; quality score
convention: **lower is worse** for TOPIQ-family (matches TOPIQ's native
scale, roughly 0-1, higher-is-better) — see "Score polarity" note in
Backend section for the exact convention used across both the primary and
fallback path.

## Data flow

Both tools follow the existing SAM2/SAM3 Celery job pattern exactly
(`backend/app/jobs/`, `ml-worker/app/tasks.py`), since both algorithms are
GPU/torch-backed and can take several seconds on a large sequence — this
must not block the API worker, and the frontend already has a working
job-polling hook (`useJob`) to reuse.

1. Frontend calls `POST /media/sequences/{sequence_id}/rank-quality` (or
   `/find-similar`) with `{"percent": 20}` (or `85`).
2. Backend validates the sequence exists, guards against a duplicate
   in-flight job for the same sequence+type (mirroring
   `transcode_video`'s 409 guard), creates a `Job` row
   (`job_type=JobType.RANK_QUALITY` / `JobType.FIND_SIMILAR`,
   `payload={"sequence_id": ..., "percent": ...}`), dispatches
   `celery_app.send_task(...)`, returns `JobRead` (201).
3. Frontend starts polling via `useJob(job.id)` (existing hook, 1.5s
   interval, stops at `succeeded`/`failed`).
4. ml-worker's Celery task loads all frames for the sequence via
   `StorageService`, scores/embeds them, writes the result as JSON into
   `Job.result_ref`... **except `result_ref` is a `String(500)` meant for
   a storage key, too small for a per-frame score list on a
   several-hundred-frame sequence.** Two options considered:
   - (a) Reuse `Job.payload` (already `JSON` typed, no size constraint) to
     also hold the result, written by ml-worker alongside `status`.
   - (b) Add a new JSON column.
   This design takes **(a)**: on success, the task updates the same `Job`
   row's `payload` in place, merging in a `"result"` key (e.g.
   `payload["result"] = {"worst_ids": [...], "scores": [...]}`), leaving
   the original request fields (`sequence_id`, `percent`) untouched. This
   needs zero schema changes and matches the "no new Frame columns"
   non-goal — results are transient, scoped to one job's lifetime.
5. Frontend, once `useJob` reports `succeeded`, reads
   `job.payload.result`, auto-checks the returned frame IDs in the
   existing `selectedFrameIds` Set (tracked separately as
   `autoCheckedFrameIds` so "Clear marks" only removes these), and stores
   the per-frame reason (score/similarity) for badge rendering.

### Backend: two new endpoints

In `backend/app/media/router.py`, alongside the existing bulk-delete
endpoint, following the `transcode_video` pattern exactly (sequence
existence check, in-flight-job 409 guard, `enqueue_*` service call,
`JobRead` response, `201`):

```python
@router.post("/sequences/{sequence_id}/rank-quality", response_model=JobRead, status_code=201)
def rank_sequence_quality(sequence_id: int, payload: RankQualityRequest, ...) -> Job: ...

@router.post("/sequences/{sequence_id}/find-similar", response_model=JobRead, status_code=201)
def find_similar_sequence_frames(sequence_id: int, payload: FindSimilarRequest, ...) -> Job: ...
```

New schemas in `backend/app/media/schemas.py`:
`RankQualityRequest { percent: int }` (1-99, default 20),
`FindSimilarRequest { percent: int }` (1-99, default 85 — this is a
similarity *threshold*, not a worst-N% cut, but kept as the same
`percent` field name/shape as the reference project and the UI/UX spec's
"threshold input" language for consistency).

New `JobType` members in `backend/app/jobs/models.py`:
`RANK_QUALITY = "rank_quality"`, `FIND_SIMILAR = "find_similar"`. New
`enqueue_rank_quality`/`enqueue_find_similar` functions in
`backend/app/jobs/service.py`, mirroring `enqueue_sam3_predict`'s shape.

**Deviation from the UI/UX spec's literal text:** that doc describes "a
threshold input" (singular) shared by both buttons. This design gives
each button its **own** percent input with its own default (20 vs 85),
matching the reference project's actual UI (two separate inputs) and
because the two numbers mean different things (worst-N% cut vs.
similarity threshold) — sharing one input/default would make one of the
two controls default to a nonsensical value. Noted here since it's a
small, deliberate departure from the existing written spec.

### ml-worker: new adapter + tasks

New module `ml-worker/app/quality_adapter.py`:

```python
class QualityAdapter:
    def __init__(self): self._metric = None  # lazy, module-pattern like Sam2Adapter
    def score(self, frame_bytes: bytes) -> float: ...  # TOPIQ, falls back to Laplacian variance
```

New module `ml-worker/app/similarity_adapter.py`:

```python
class SimilarityAdapter:
    def __init__(self): self._model = None  # lazy DINOv2 ViT-B/14
    def embed(self, frame_bytes: bytes) -> np.ndarray: ...  # L2-normalized 768-d vector
```

Both follow the existing singleton-per-process caching pattern from
`tasks.py` (`_get_default_sam3_adapter`-style module-level singleton), and
both are new model families sharing the same GPU as SAM2/SAM3 — they must
participate in the existing cross-family eviction (`_evict_sam3_models()`
/ `_evict_sam2_models()` calls at the top of every task) so they don't
compete for VRAM simultaneously with a concurrent Predict/Track job. New
`_evict_quality_models()`/`_evict_similarity_models()` helpers, called at
the top of every task including the existing SAM ones (so a
Predict/Track job evicts these too, and vice versa) — extending the
existing eviction call sites is an in-scope, targeted change to
`tasks.py`, not a new pattern.

New Celery tasks in `ml-worker/app/tasks.py`, registered on the **default
queue** (same as SAM2/SAM3 — no dedicated queue needed since, unlike the
`video_transcode` worker, this runs in the same GPU container and process
as the other ML tasks it must not run concurrently with):

```python
@celery_app.task(name="rank_quality")
def run_rank_quality(job_id: int) -> None: ...

@celery_app.task(name="find_similar")
def run_find_similar(job_id: int) -> None: ...
```

**`run_rank_quality`:** load all `Frame` rows for `payload["sequence_id"]`
ordered by `frame_index`, download each via `StorageService`, score with
`QualityAdapter.score()`, sort worst-first, take
`round(len(frames) * percent / 100)` frames, write
`payload["result"] = {"scores": [{"frame_id", "score"}, ...], "worst_ids": [...]}`.
Progress updated per-frame like the existing track tasks
(`job.progress = int((i+1)/len(frames)*100)`, committed each iteration).

**`run_find_similar`:** load all frames, embed each with
`SimilarityAdapter.embed()`, compute all-pairs cosine similarity
(`embeddings @ embeddings.T`, small enough to be dense — sequences are at
most a few hundred frames), Union-Find cluster any pair
`>= percent/100`, and for each cluster of size ≥ 2, score every member
with `QualityAdapter.score()` (reusing the quality adapter — same
GPU-resident-model-at-a-time constraint applies, load/evict quality then
similarity model sequentially, not concurrently) and keep the
best-quality frame unchecked, marking the rest `duplicate_ids`. Write
`payload["result"] = {"duplicate_ids": [...], "pairs": [...], "similarity_map": {frame_id: similarity}}`.

### ml-worker: new dependencies

Neither `torchvision` nor `pyiqa` nor `opencv` are currently installed in
`ml-worker` (confirmed: absent from `pyproject.toml`, `uv.lock`, and the
Dockerfile's explicit `RUN uv pip install` steps). `torch==2.7.1` is
already pinned and installed. New Dockerfile lines needed, following the
existing precedent of pinning exact versions with a comment explaining
why:

- `pyiqa` (for TOPIQ) — pure PyPI package, works with the already-pinned
  torch.
- `opencv-python-headless` (for the Laplacian-variance fallback path) —
  headless variant since this is a server container with no display.
- DINOv2 is loaded via `torch.hub.load('facebookresearch/dinov2', 'dinov2_vitb14')`
  (no extra package beyond `torch`/`torchvision`; `torchvision` is
  already installed for SAM2's image transforms per the existing
  Dockerfile) or via `transformers` if the hub-load path proves
  unreliable offline — implementation detail to confirm in the plan, not
  a spec-level decision, since it doesn't change the design's shape.

## Frontend

### Toolbar changes (`SequenceGridToolbar.tsx`)

While in Select mode, add two new control groups (each: number input +
button), following the existing toolbar's Tailwind conventions
(`rounded px-3 py-1.5 text-sm`, `bg-gray-800 text-gray-200
hover:bg-gray-700`, `disabled:opacity-40`):

- **Quality group:** percent `<input type="number">` (default 20, min 1,
  max 99) + **"Rank Quality"** button. Disabled while a rank-quality job
  is in flight (spinner/label change, same as any other async action in
  this codebase); disabled if the sequence has 0 frames.
- **Similarity group:** percent input (default 85, min 1, max 99) +
  **"Find Similar"** button, same disabled/loading conventions.
- **"Clear marks"** button, hidden until at least one auto-check exists
  from either tool this session, clears `autoCheckedFrameIds` (removing
  those, and only those, from `selectedFrameIds`) and the badge/reason
  map.

New props threaded from `SequenceGridPage.tsx` (owns the state, same as
`selectedFrameIds` today): `qualityPercent`, `similarityPercent`,
`onRankQuality`, `onFindSimilar`, `onClearMarks`,
`isRankQualityRunning`, `isFindSimilarRunning`, `hasAutoMarks`.

### Page state (`SequenceGridPage.tsx`)

New state alongside existing `selectedFrameIds`:
- `autoCheckedFrameIds: Set<number>` — subset of `selectedFrameIds`
  added by a suggestion tool, not manually.
- `frameMarkReasons: Map<number, { kind: "quality" | "similarity"; label: string }>`
  — e.g. `{ kind: "quality", label: "low quality" }` or
  `{ kind: "similarity", label: "dup 96%" }`, for badge rendering.
- `activeJobId: number | null` + `activeJobKind: "quality" | "similarity" | null`
  — tracks the in-flight suggestion job for `useJob` polling; only one
  suggestion job runs at a time (buttons disabled while either is
  in-flight, matching the ml-worker's one-task-at-a-time constraint and
  keeping the UI simple).

On job success: merge returned frame IDs into both `selectedFrameIds` and
`autoCheckedFrameIds` (entering Select mode automatically if not already
active, since suggestions imply intent to review/delete), populate
`frameMarkReasons` from the result payload's scores/similarities.

Manually checking/unchecking a frame that happens to be auto-marked
removes it from `autoCheckedFrameIds` only if the user *unchecks* it (the
mark reason badge can stay or clear — clearing on uncheck is simpler and
avoids a stale badge on a frame no longer selected, so: unchecking a
frame always clears its entry from both `autoCheckedFrameIds` and
`frameMarkReasons`, regardless of who checked it).

### New API hooks (`frontend/src/entities/useFrames.ts`)

Two new mutations, mirroring `useDeleteFrames`'s shape (call `apiClient`,
return the parsed `JobRead`, no cache invalidation needed since these
don't change frame data, only return a job to poll):

```ts
export function useRankQuality(sequenceId: number) {
  return useMutation({
    mutationFn: async (percent: number) => {
      const result = await apiClient.POST("/media/sequences/{sequence_id}/rank-quality", {
        params: { path: { sequence_id: sequenceId } },
        body: { percent },
      });
      return result.data;
    },
  });
}
// useFindSimilar mirrors this against /find-similar
```

`SequenceGridPage` also calls the existing `useJob(activeJobId)` hook
to poll whichever job is active, and reacts to its `succeeded`/`failed`
transition in a `useEffect`.

### Badge rendering (`FrameThumbnail.tsx`)

New optional props: `markReason?: { kind: "quality" | "similarity"; label: string }`.
When present: red outline on the card (`ring-2 ring-red-500` added to the
existing root button's className) and a small badge, positioned
`absolute right-2 top-2` (mirroring the existing checkbox's
`absolute left-2 top-2` on the opposite corner) — e.g.
`rounded bg-red-700/90 px-1.5 py-0.5 text-xs text-white`, text = the
`label` (`"low quality"` / `"dup 96%"`).

## Testing

Per this repo's TDD requirement, failing tests before implementation, at
each layer:

- **Backend:** unit tests for the two new endpoints — sequence-not-found
  404, duplicate-in-flight-job 409, successful `Job` creation with
  correct `job_type`/`payload`. No real ML computation tested here (that
  belongs to ml-worker's own test suite) — these tests exercise the
  job-creation contract, same scope as existing `transcode_video` tests.
- **ml-worker:** unit tests for `QualityAdapter`/`SimilarityAdapter`
  (torch/pyiqa available in the container per
  `ml_worker_test_workflow` — run via `docker cp` + `docker compose exec`,
  not the host venv) and for `run_rank_quality`/`run_find_similar` task
  logic — worst-N% selection math, Union-Find clustering correctness on a
  small synthetic similarity matrix, fallback-to-Laplacian path when the
  primary metric raises.
- **Frontend:** `SequenceGridToolbar.test.tsx` additions for the two new
  button groups (disabled states, percent input bounds) and
  `SequenceGridPage.test.tsx` additions for the auto-check/clear-marks
  state machine, mocking `apiClient` and `useJob` per existing
  conventions in this codebase.

## Rollout note

Per this repo's stated testing philosophy (`CLAUDE.md`), after both
phases are implemented and unit tests pass, this must be exercised once
against the real running stack (`docker compose up`, real ml-worker
container, real browser) — not just trusted from mocked frontend tests
and `TestClient`-based backend tests — before being considered done,
since GPU/model-loading behavior (VRAM eviction ordering between four now
six model families, `torch.hub` download on first run, real TOPIQ/DINOv2
output ranges on real endoscopy frames) can't be verified any other way.

## Implementation phases

Per the user's explicit request, delivered as two sequential phases under
one plan:

1. **Phase 1 — Rank Quality.** Full vertical slice: `JobType.RANK_QUALITY`,
   `QualityAdapter`, `run_rank_quality` task, the quality-side toolbar
   controls, badge rendering, and Clear marks (scoped to quality-only
   marks, since Find Similar doesn't exist yet). Shippable and useful on
   its own.
2. **Phase 2 — Find Similar.** Adds `JobType.FIND_SIMILAR`,
   `SimilarityAdapter`, `run_find_similar` (reusing `QualityAdapter` for
   per-cluster best-frame selection — built in Phase 1), the
   similarity-side toolbar controls, and extends Clear marks/badge
   rendering to cover both mark kinds uniformly (the state shape in
   "Frontend" above already accounts for both from the start, so Phase 2
   is additive, not a rework of Phase 1's state).
