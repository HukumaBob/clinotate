# Mask Post-Processing Design

**Context:** SAM2/SAM3 mask output frequently has a jagged, small-toothed
contour, "speckles" (small isolated blobs disconnected from the main mask),
and "holes" (small gaps inside the main mask). This design cleans that up
with standard OpenCV operations before the mask is considered final. SAM3
(`ml-worker/app/sam3_adapter.py`) is explicitly out of scope for this
change — it's only usable after a hardware upgrade that isn't scheduled,
so wiring post-processing into it now would be dead code with no way to
verify it against real weights.

## Why the algorithm lives in `backend`, not `ml-worker`

The initial framing of this design assumed post-processing would run
inside `ml-worker`'s `Sam2Adapter.predict()`/`track()`, right before PNG
encoding. That changed once the requirement became "the user can drag a
per-mask smoothing slider *after* prediction or tracking has already
produced a mask." Re-running SAM2 on every slider drag would mean a full
Celery/GPU round-trip (seconds, GPU contention) for what should be a
cheap, instant CPU operation on an already-computed raster mask.

So the raw SAM2 mask and the post-processing step are decoupled:
`ml-worker` always produces and stores the *raw* mask, unchanged.
`backend` owns the post-processing algorithm and applies it (a) once,
automatically, right after a job succeeds, using a default strength, and
(b) on demand, synchronously, whenever a user adjusts a specific
annotation's smoothing slider — both without touching the GPU or Celery.

`backend` already depends on `opencv-python-headless` (used today in
`backend/app/media/service.py` for video frame extraction/transcoding),
so this adds no new dependency there. `ml-worker` gets no new dependency
at all — it keeps doing exactly what it does today.

## The algorithm: `backend/app/annotation/mask_postprocess.py`

```python
def postprocess_mask(mask: np.ndarray, strength: float) -> np.ndarray
```

- Input/output: a 2D boolean (or `{0,1}`) numpy array — the raw mask
  before `* 255` / PNG encoding.
- `strength` must be in `[0, 1]`; otherwise raises `ValueError`.
- **`strength == 0` is the identity operation** — the mask is returned
  completely unchanged, no connected-component filtering either. This
  gives a clean, literal "off" state to compare before/after against, and
  it's what a mask keeps if nobody has ever touched its smoothing value
  yet on a codepath that skips the default-apply step (there shouldn't be
  one, but identity-at-zero is the safe fallback regardless).
- For `strength > 0`, four steps, in order, all using kernel/blur radii
  computed as `max(1, round(strength * K * min(height, width)))` (a small
  constant `K`, roughly 0.01–0.02, tuned during implementation against
  real endoscopy frames) — i.e. **relative to frame size**, not absolute
  pixels, so the same strength value behaves consistently across
  differently-sized source videos:
  1. **Opening** (`cv2.morphologyEx(cv2.MORPH_OPEN)`, elliptical kernel)
     — erodes away small speckles/noise on the boundary.
  2. **Closing** (`cv2.morphologyEx(cv2.MORPH_CLOSE)`, same kernel) —
     closes small holes and contour gaps.
  3. **Largest connected component** (`cv2.connectedComponentsWithStats`)
     — keeps only the single largest component, dropping any remaining
     isolated blobs. If the mask is empty after steps 1–2, this is a
     no-op on an empty mask.
  4. **Contour smoothing** — Gaussian blur (`cv2.GaussianBlur`) on the
     binary (0/255) mask with a radius derived from `strength`, then
     re-threshold at the midpoint back to 0/255. Chosen over
     `findContours` + `approxPolyDP` because it stays in pixel space
     (no polygon reconstruction step, so mask topology from steps 1–3 is
     preserved exactly) and can't distort medically-relevant boundaries
     into a faceted polygon look.
- If the mask ends up empty after all steps, it's returned as-is — no
  silent fallback to the pre-processing mask. A user who cranks strength
  high enough to erase a thin/small annotation should see that happen,
  not have it silently undone.
- One parameter (`strength`) drives every step's magnitude together —
  no separate morphology-strength/contour-smoothing knobs. Simpler for
  the one control the user actually sees.

## Data model changes

**`backend/app/annotation/models.py`** — `Annotation` gains:

```python
raw_mask_storage_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
```

Nullable, one Alembic migration. `storage_key` continues to be *the*
value every existing consumer (frontend preview, export, `MasksList`)
reads — always the current post-processed mask. `raw_mask_storage_key`
holds the untouched SAM2 output, written once at creation time and never
overwritten. Annotations created before this change have
`raw_mask_storage_key = NULL`; the re-apply endpoint (below) 404s for
those rather than guessing.

`Annotation.payload` (existing JSONB column) gains a
`mask_postprocess_strength: float | None` key — the strength value
actually baked into the current `storage_key` contents, used by the
frontend to pre-fill each mask's own slider.

**`backend/app/settings/models.py`** — `PlatformSettings` gains:

```python
mask_postprocess_strength: Mapped[float] = mapped_column(Float, default=0.3)
```

Same singleton-row pattern as `max_track_range_frames`. One migration,
seeded to `0.3` for the existing row. `SettingsRead`/`SettingsUpdate`
(`backend/app/settings/schemas.py`) gain the matching field
(`Field(ge=0, le=1)` on the update side), and `update_settings()`
(`backend/app/settings/service.py`) takes/sets it alongside the existing
parameter. This is the same admin-editable `/settings` page — a new
"Mask post-processing" section next to the existing "GPU / Performance"
one, one number input labeled "Default mask smoothing strength (0–1)".

## `ml-worker` changes

None to `sam2_adapter.py` — `predict()`/`track()` keep returning the raw
SAM2 mask exactly as today. The only change is in `ml-worker/app/tasks.py`:
wherever `Annotation(...)` is constructed after a successful
`sam2_predict`/`sam2_track` job, `raw_mask_storage_key` is set to the same
value as `storage_key` (both point at the just-uploaded raw PNG):

```python
mask_key = f"masks/{frame_id}/{job_id}.png"
storage.upload(mask_key, result.mask_png, content_type="image/png")
annotation = Annotation(
    ...,
    storage_key=mask_key,
    raw_mask_storage_key=mask_key,
    ...,
)
```

`sam3_predict`/`sam3_track` are untouched — SAM3 annotations simply never
get a `raw_mask_storage_key`, consistent with post-processing being SAM2-only
for now.

## Applying the default strength once a job succeeds

**`backend/app/jobs/router.py`'s `get_job`** (the endpoint the frontend
already polls for job status) gains a side effect: when the job's status
is `SUCCEEDED` and its `Annotation`s haven't been post-processed yet
(checked via `payload` not containing `mask_postprocess_strength`), backend:

1. Reads the strength to apply: the job's own payload
   `mask_postprocess_strength` if the request that created it set one
   (i.e. the user had moved the ToolsPanel slider before hitting
   Predict/Track), otherwise `platform_settings.mask_postprocess_strength`.
2. For every `Annotation` with this `job_id`: downloads `raw_mask_storage_key`
   from MinIO, runs `postprocess_mask(strength)`, re-uploads to the same
   `storage_key` path (overwriting it in place — no new MinIO key per
   apply), and sets `payload["mask_postprocess_strength"] = strength`.

This logic lives in a new `apply_default_postprocess_for_job(session, job)`
function in `backend/app/annotation/service.py`, called from `get_job`.
Because this only runs once per job (guarded by the payload check), a
client polling `GET /jobs/{id}` repeatedly after SUCCEEDED doesn't
re-trigger it.

**`Sam2PredictRequest`/`Sam2TrackRequest`** (`backend/app/jobs/schemas.py`)
gain an optional field:

```python
mask_postprocess_strength: float | None = Field(default=None, ge=0, le=1)
```

`enqueue_sam2_predict`/`enqueue_sam2_track` (`backend/app/jobs/service.py`)
store it in `Job.payload` alongside the existing fields, unchanged
otherwise. SAM3 request schemas are not touched.

## Per-mask re-apply endpoint

**`PATCH /annotation/annotations/{annotation_id}/mask-postprocess`**
(new route in `backend/app/annotation/router.py`):

- Body: `{"strength": float}` (`ge=0, le=1`).
- 404 if the annotation doesn't exist or `raw_mask_storage_key is None`
  (nothing to re-derive from — includes pre-migration annotations and any
  SAM3 annotation).
- Downloads `raw_mask_storage_key` from MinIO, runs
  `postprocess_mask(strength)`, re-uploads to the existing `storage_key`
  path (in place), updates `payload["mask_postprocess_strength"] = strength`.
- Returns the updated `AnnotationRead`. `mask_url` is unchanged as a URL
  (same MinIO key) even though its content changed — the frontend must
  cache-bust (e.g. append `?t=<timestamp>`) when refreshing the preview
  `<img>` after this call, since the browser/CDN would otherwise serve a
  stale cached image for an unchanged URL.

## Frontend

**`ToolsPanel.tsx`** — a new "Mask smoothing" section (placed right after
the existing "Model" section, since it's a property of SAM output in
general, not Track-specific): one `<input type="range" min={0} max={1}
step={0.01}>`, labeled with its current numeric value. Backed by a new
`maskSmoothingStrength` field in `frameEditorStore.ts` (+
`setMaskSmoothingStrength`), initialized from `GET /settings`'s
`mask_postprocess_strength` on first load (same query-key/cache entry the
Settings page and `TrackControls` already use for
`max_track_range_frames`) — so the global admin default pre-fills the
slider, and moving it only affects this editing session, not the stored
global default. `FrameEditor.tsx`'s `refinePredict()` and `handleTrack()`
add `mask_postprocess_strength: state.maskSmoothingStrength` to their
request payloads.

**`MasksList.tsx`** — each listed mask/annotation row gets its own
`<input type="range">` "Smoothing" control, pre-filled from
`annotation.payload.mask_postprocess_strength` (present for every SAM2
annotation, since the default-apply step in `get_job` guarantees it's set
by the time a job's annotations are visible). `onChange` (debounced, e.g.
300ms after the user stops dragging) fires a `useMutation` calling
`PATCH /annotation/annotations/{id}/mask-postprocess`, and on success
invalidates the frame's annotations query (TanStack Query) so the
`mask_url` preview `<img>` re-renders with a cache-busting suffix.

**Generated types**: `Sam2PredictRequest`/`Sam2TrackRequest`'s new
optional field and the new `PATCH .../mask-postprocess` route both need
`backend/scripts/export_openapi.py` re-run (`PYTHONPATH=. uv run python
scripts/export_openapi.py`) to update the committed `openapi.json` before
`npm run dev`'s `generate-api` prebuild hook picks up the new shapes.

## Testing

TDD per `CLAUDE.md` — failing test first, throughout.

- `backend/tests/annotation/test_mask_postprocess.py` — pure-function
  unit tests for `postprocess_mask()`: a mask with an isolated 2px speckle
  loses it after opening + largest-component; a mask with a small internal
  hole has it closed; `strength=0` is a byte-for-byte identity; contour
  jaggedness measurably decreases (e.g. contour perimeter / area ratio
  drops) as `strength` increases; out-of-range `strength` raises
  `ValueError`. No DB, no MinIO, no GPU — plain numpy fixtures, runs in
  the normal backend test suite.
- `backend/tests/annotation/test_mask_postprocess_endpoint.py` — TDD for
  the new PATCH route: 404 with no `raw_mask_storage_key`, successful
  re-apply updates `storage_key`'s MinIO content and `payload`, strength
  validation (422 outside `[0,1]`).
- `backend/tests/jobs/test_job_default_postprocess.py` — `GET /jobs/{id}`
  applies the default (from `platform_settings` or the job's own payload)
  exactly once per job on the SUCCEEDED transition; a second poll doesn't
  re-run it (assert via a spy/mock on `postprocess_mask` call count, or by
  asserting MinIO content is written exactly once).
- `backend/tests/test_settings*.py` — extend existing coverage for
  `max_track_range_frames` to also cover `mask_postprocess_strength`
  (GET default, PATCH validation, PATCH persists).
- `ml-worker/tests/test_tasks_sam2.py` (or wherever `Annotation` creation
  from `run_sam2_predict`/`run_sam2_track` is already covered) — extend to
  assert `raw_mask_storage_key == storage_key` on the created annotation.
  No changes needed to `test_sam2_adapter.py` — the adapter itself is
  untouched by this design. Run via the existing `docker cp` +
  `docker compose exec` workflow (host `.venv` lacks torch/numpy).
- Frontend: `MasksList.test.tsx` gains cases for the new per-mask slider
  and its debounced mutation; `ToolsPanel.test.tsx` gains a case asserting
  `maskSmoothingStrength` is included in Predict/Track request payloads.

## Deviations from the original framing

The idea started as "post-process inside `ml-worker`'s adapter, gated by
a single global settings toggle read once at request time." Two things
moved it to the current shape during design: (1) the user wants a
per-mask, post-hoc-adjustable slider rather than a fire-and-forget
request-time parameter, which rules out baking post-processing into the
GPU adapter call itself; (2) `backend` turned out to already depend on
`opencv-python-headless` for unrelated video work, which settled where the
one canonical copy of the algorithm should live once re-running SAM2 for
every slider tweak was ruled out as too slow/GPU-hungry.
