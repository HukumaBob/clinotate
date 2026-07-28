# Media screen — design

Implements the "Media" section of
[docs/specs/2026-07-23-platform-ui-ux-design.md](../../specs/2026-07-23-platform-ui-ux-design.md)
(`## Media`), the first of the six top-level nav sections
(`Media → Sequences → Tags → Dataset → Train → Results`) to get a real
screen. Everything else in that nav stays out of scope here.

## Scope

In scope: both upload flows (Video → Sequence, Photos → Sequence) and the
raw media library table, exactly as specified in the UI/UX spec's `## Media`
section. Out of scope: a Sequences catalog/list screen with cards (per the
UI/UX spec's own "Sequences list screen" section) — submitting either Media
form navigates straight into the existing single-sequence grid route, per
an explicit decision made during this design's brainstorming (a Sequences
catalog is a separate future task). Also out of scope: "Find similar" /
"Rank quality" (those belong to the Sequences screen's select mode, not
Media).

## Current gap vs. the UI/UX spec

`frontend/src/features/media/{VideoListPage,VideoUploadForm,FrameGrid}.tsx`
and `backend/app/media/{router,schemas,models,service}.py` predate the
UI/UX spec and only support a single-video-title upload with no `Sequence`
name, no crop box, no fps control, no batch photo upload, no raw media
library listing, and no delete. This design replaces that surface with the
one described below; nothing from the old files survives as-is.

## Backend

### Data model changes (`app/media/models.py`)

- `Video` gains `filename: str` (original uploaded filename, for the raw
  media library), `procedure_id: int | None` (`ForeignKey("procedures.id")`,
  nullable for pre-existing rows), `size_bytes: int` (cached at upload time
  so the library listing never has to re-stat MinIO).
- `Sequence` gains `name: str` (required going forward; auto-suggested by
  the frontend, always a plain editable string, never parsed back apart).
- `Frame` gains `size_bytes: int` (cached at upload time, summed for a
  standalone `Sequence`'s row in the raw media library).

No new tables. A photos-batch upload is represented in the raw media
library as one row per standalone `Sequence` (`video_id is None`) — not a
separate `Photo`/`PhotoUpload` model. This means "one library row" and "one
Sequence" are the same thing for photo-origin sequences, unlike for video
(where a `Video` can have multiple child `Sequence` rows extracted from
different time ranges) — an accepted asymmetry, not a bug, decided during
brainstorming.

### `CropBox` semantics

`{left, right, top, bottom}`, each a percentage `0–100`, each an **inset
from that edge** (matching the UI/UX spec's field names read as symmetric
margins, not two corner coordinates): `left`/`top` inset from the
left/top edge, `right`/`bottom` inset from the right/bottom edge. All zero
(or the field omitted) means no cropping. `extract_frames` converts
percentages to pixels against the source frame's actual `shape` before
slicing, so the box is always valid regardless of the video's resolution.

### Schemas (`app/media/schemas.py`)

```python
class CropBox(BaseModel):
    left: float = 0
    right: float = 0
    top: float = 0
    bottom: float = 0

class VideoRead(BaseModel):
    id, filename, title, fps, duration_seconds, procedure_id, created_at

class SequenceCreate(BaseModel):   # video -> sequence extraction
    name: str
    start_time: int
    duration: int
    fps: float
    crop: CropBox | None = None

class SequenceCreateStandalone(BaseModel):   # kept for programmatic use; gains `name`
    name: str
    procedure_id: int
    start_time: int = 0
    duration: int = 0

class SequenceRead(BaseModel):     # gains `name`
    id, name, video_id, procedure_id, start_time, duration, created_at

class MediaLibraryItem(BaseModel):
    id: int
    kind: Literal["video", "photo"]
    filename: str
    procedure_id: int | None
    uploaded_at: datetime
    size_bytes: int
    linked_sequence_count: int
```

`linked_sequence_count` is always `1` for a `kind="photo"` row (the
sequence counts itself) and the count of child `Sequence` rows for
`kind="video"`.

### Endpoints (`app/media/router.py`)

- `POST /media/videos` — extended: accepts `procedure_id` (optional Form
  field), stores `filename` from `UploadFile.filename` and `size_bytes`
  from `len(data)`.
- `GET /media/sequences/suggest-name?procedure_id=<id>` → `{"name": str}`.
  Computes `"{procedure.name} {today:%Y-%m-%d} #{n}"` where `n` is
  `1 + count(Sequence.name LIKE "{base}%")` created today for that
  procedure. Purely a suggestion — the frontend shows it pre-filled in an
  editable field, never enforces the format server-side.
- `POST /media/videos/{video_id}/sequences` — `SequenceCreate` now carries
  `name`/`fps`/`crop`; `extract_frames(video_bytes, sample_fps=payload.fps,
  crop=payload.crop)` replaces the previous hardcoded `sample_fps=1.0`.
- `POST /media/sequences/photos` (new) — `multipart/form-data`:
  `files: list[UploadFile]`, `name: str` (Form), `procedure_id: int`
  (Form). Creates one `Sequence(video_id=None, procedure_id=..., name=...)`
  and all its `Frame` rows in a single request/transaction (frame ordering
  = upload order). Reuses the existing per-image validation from
  `upload_standalone_frame` (rejects non-images with 422).
- `GET /media/library` (new) — merges all `Video` rows and all standalone
  `Sequence` rows (`video_id is None`) into `list[MediaLibraryItem]`,
  sorted by `uploaded_at` descending.
- `DELETE /media/videos/{video_id}` (new) — `404` if missing; `409` if any
  `Sequence.video_id == video_id` exists ("delete or reassign its
  sequences first"). Otherwise deletes the DB row (storage object cleanup
  follows the existing `StorageService` deletion pattern if one exists,
  else is left as an accepted gap — media files are cheap to orphan versus
  risking a silent data-loss path; not addressed further here).
- `DELETE /media/sequences/{sequence_id}` (new) — only for
  `video_id is None` rows reached from the library (video-derived
  sequences are deleted from the Sequences screen, out of scope here).
  `404` if missing or if `video_id is not None` (wrong screen for that
  case). `409` if any of its `Frame` rows has an `Annotation`.

### Service layer (`app/media/service.py`)

- `extract_frames(video_bytes, sample_fps, crop=None)` — crop applied via
  NumPy slicing (`frame[top_px:height-bottom_px, left_px:width-right_px]`)
  before `imencode`, computed from the source frame's actual `shape` each
  call.
- `suggest_sequence_name(session, procedure, today) -> str` — the naming
  logic described above, factored out so the router stays thin.

## Frontend

### Routing (`app/App.tsx`)

- `/videos/:videoId/sequences/:sequenceId` → replaced by `/sequences/:sequenceId`
  (the `videoId` param was never read inside `SequenceGridPage`; standalone
  photo sequences have no `video_id` to put there). No alias kept — no
  in-app link references the old path today.
- `/videos` → replaced by `/media` → `MediaPage`.
- `LoginPage`'s post-login `navigate("/videos")` → `navigate("/media")`.

### Components (`frontend/src/features/media/`)

Old `VideoListPage.tsx` / `VideoUploadForm.tsx` / `FrameGrid.tsx` are
deleted and replaced by:

- **`MediaPage.tsx`** — top-level screen: `VideoUploadFlow` and
  `PhotosUploadFlow` side by side, `MediaLibraryTable` below both.
- **`VideoUploadFlow.tsx`** — two-step: (1) `VideoUploadForm` (file +
  title + Procedure select), calling `POST /media/videos`; (2) on success,
  reveals `ExtractSequenceForm` for the just-uploaded video: `name` (via
  `useSuggestSequenceName`, editable), Start timestamp, Duration, FPS,
  Procedure (pre-filled from step 1), a collapsed 4-field crop box.
  Submitting calls `POST /media/videos/{id}/sequences` then navigates to
  `/sequences/:sequenceId`.
- **`PhotosUploadFlow.tsx`** — drag & drop / click-to-browse zone
  accepting multiple images, thumbnail grid preview (`URL.createObjectURL`,
  revoked on unmount/replace), `name` (auto-suggested, editable), Procedure
  select. Submitting calls `POST /media/sequences/photos` (multipart, all
  files in one request) then navigates to `/sequences/:sequenceId`.
- **`MediaLibraryTable.tsx`** — renders `MediaLibraryItem[]`: filename,
  kind badge (video/photo), procedure name, uploaded date, human-readable
  size (e.g. `1.2 MB`), linked sequence count, Delete button. Delete shows
  a confirm dialog; if the backend returns 409 the button stays and an
  inline error explains why (linked sequences exist / annotations exist).

### Hooks (`frontend/src/entities/`)

- `useMediaLibrary()` — `GET /media/library`, query key `["media-library"]`.
- `useSuggestSequenceName(procedureId)` — `GET
  /media/sequences/suggest-name`, disabled until a procedure is picked.
- `useCreateSequenceFromVideo()` — extends the existing video-upload
  mutation pattern; invalidates `["media-library"]` on success.
- `useCreatePhotoSequence()` — multipart POST mutation; invalidates
  `["media-library"]`.
- `useDeleteVideo()`, `useDeleteSequence()` — mutations invalidating
  `["media-library"]`; surface the backend's 409 detail message to the
  caller for the inline error display.

All new API calls go through the generated `apiClient`
(`frontend/src/shared/api/client.ts`) once `openapi.json` is regenerated
from the new backend endpoints — no hand-rolled `fetch()`.

## Error handling

- Non-image file in a photos batch → backend 422 (reuses existing
  `UnidentifiedImageError` handling) → surfaced inline next to that
  file's thumbnail in `PhotosUploadFlow`, not a page-level toast, since one
  bad file in a batch shouldn't block clearly showing which one failed.
- Delete with existing links/annotations → backend 409 with a message →
  `MediaLibraryTable` shows it inline, delete stays available (not
  silently disabled) so the message is visible without a separate hover.
- Crop box producing an empty/invalid region (e.g. `left + right >= 100`)
  → backend 422 with a validation message before any frame extraction is
  attempted.

## Testing

TDD per `CLAUDE.md`: failing test before implementation, both sides.

**Backend (pytest):**
- `suggest_sequence_name` ordinal counting (same procedure/day increments,
  different day resets, different procedure is independent).
- `POST /media/sequences/photos` creates one `Sequence` + N `Frame` rows
  in upload order; rejects a non-image file in the batch with 422.
- `extract_frames` crop math: known input frame shape + crop box → exact
  expected output pixel dimensions; all-zero crop is a no-op.
- `DELETE /media/videos/{id}` and `DELETE /media/sequences/{id}` 409 paths
  (linked sequences / linked annotations) and the success path.
- `GET /media/library` returns both kinds, correct `linked_sequence_count`
  for a video with 0/1/many child sequences and for a photo sequence
  (always 1).

**Frontend:**
- Unit tests (mocking `apiClient`) for: name auto-suggestion wiring,
  `PhotosUploadFlow`'s per-file error display, `MediaLibraryTable`'s
  delete-confirm and 409-error display.
- One real-browser Playwright e2e extending the existing
  `annotation-flow.spec.ts` pattern: upload a video → extract a sequence
  with a crop box → land on `/sequences/:id` with the expected frame
  count; a second scenario uploads a photo batch → lands on
  `/sequences/:id` with N frames. Per this repo's testing-philosophy
  section (CORS/auth/build bugs only real-browser e2e caught before),
  this is not optional polish — it is required before claiming the feature
  works end-to-end.

## Deviations from the old (segmentation) platform

None beyond what the UI/UX spec itself already logged in its own `##
Media` section — this design doesn't revisit those decisions, only fills
in the backend/frontend implementation gap left after that spec was
written.
