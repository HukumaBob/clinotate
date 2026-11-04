# Crop frames of an existing sequence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the sequence grid, select frames and cut them (and every mask of theirs) to a rectangle, with a preview, an automatic proposal and no undo.

**Architecture:** A new backend module `backend/app/media/frame_crop.py` holds the crop and detection logic; two thin routes on the media router call it. Cut images and masks go to new storage keys, rows are updated in one commit, old objects are deleted after it. The frontend adds a `FrameCropPanel` next to the tag-regions panel in the sequence grid toolbar.

**Tech Stack:** FastAPI, SQLAlchemy, OpenCV/numpy, StorageService (MinIO), React/Vite, openapi-typescript.

**Spec:** [docs/specs/2026-11-04-frame-crop-design.md](../specs/2026-11-04-frame-crop-design.md)

## Global Constraints

- English only in code, comments, UI copy; dark theme only.
- Backend tests: `import app.db as db_module` and `db_module.SessionLocal()`, never `from app.db import SessionLocal`; never leave rows or MinIO objects in the real `endoscopy` DB. Backend tests use a `FakeStorage` override of `get_storage_service` (see `backend/tests/test_qc_flags_api.py`), not real MinIO.
- All media bytes go through `StorageService`; no filesystem paths in domain code (the temp-file exception covers only OpenCV calls on video in `media/service.py`; images here are decoded from bytes with `cv2.imdecode`).
- Crop arithmetic is the existing one: `int(size * pct / 100)` per side (`backend/app/media/service.py:_apply_crop`), as a percentage of each frame's own size.
- Crop is irreversible (user decision): no stored original, no undo, no `Frame.crop_box`, no migration, no change to `Sequence.crop_box` or `POST /media/sequences/photos`.
- Frames used by a dataset are refused with 409 through the existing `_raise_if_frames_in_datasets` (`backend/app/media/router.py`).
- At most 500 frames per request.
- After a schema change: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`, check `git diff --stat openapi.json`; never hand-edit `frontend/src/shared/api/generated/`; use `apiClient`.
- Work on `master`, no branches or worktrees; commit per task; pushing is the user's call (ask first).
- Ask before touching dev servers or restarting containers (see memory); the backend runs with `--reload`.

## Review Focus

- A mask with pixels in the removed area: `masks_clipped` counts it, the mask is cut, nothing crashes (Task 1).
- A selection mixing frame sizes: the percentage applies per frame (Task 1).
- A failure after the new objects are uploaded: the database is unchanged and the new objects are deleted; the old objects stay (Task 2).
- A frame in a dataset, a frame of another sequence, an unreadable image, a mask whose size differs from its frame: nothing is changed (Task 2).
- Auto-detect on a borderless frame and on frames that disagree: `null`, not a tiny or wrong rectangle (Task 3).

---

### Task 1: Apply a crop to frames and masks, with dry-run

**Files:**
- Create: `backend/app/media/frame_crop.py`, `backend/tests/test_frame_crop_api.py`
- Modify: `backend/app/media/schemas.py`, `backend/app/media/router.py`

**Interfaces:**
- Produces:
  - `schemas.FrameCropRequest {frame_ids: list[int], crop: CropBox, dry_run: bool = False}`; `schemas.FrameCropResult {frames: int, annotations: int, masks_clipped: int, applied: bool}`.
  - `frame_crop.crop_frames(session: Session, storage: StorageService, sequence_id: int, frame_ids: list[int], crop: CropBox, dry_run: bool) -> FrameCropResult`.
  - Route `POST /media/sequences/{sequence_id}/frames/crop` → `FrameCropResult` (200).

- [ ] **Step 1: Write failing tests** in `test_frame_crop_api.py`. Build the world with a fixture: a procedure, a video-less `Sequence`, `FakeStorage` holding the frame PNGs, `Frame` rows (width/height set), and annotations with masks. Tests:
  - `test_crop_cuts_frames_to_the_requested_insets`: 64x48 frames, crop `{"left":25}` → response `applied True, frames 2`; each `Frame` row has `width 48, height 48`, a new `storage_key` (different from the old one), `size_bytes` of the new object; the new object decodes to 48x48 with the original pixel content; the old object is gone from storage.
  - `test_masks_are_cut_with_the_same_rectangle`: a frame with a MASK annotation having `storage_key` and `raw_mask_storage_key`, both 64x48 → both new keys decode to 48x48, rows point at them, old objects deleted; a CLASSIFICATION annotation on the same frame is untouched; response `annotations` counts only mask annotations.
  - `test_masks_clipped_counts_masks_with_pixels_in_the_removed_area`: one mask white only inside the kept area, one white in the left 25 % → `masks_clipped == 1` (both are still cut).
  - `test_a_mixed_size_selection_uses_each_frames_own_size`: 64x48 and 128x96 frames, crop `{"left":25,"top":10}` → 48x44 and 96x87 (use `int()` truncation).
  - `test_dry_run_reports_the_counts_and_writes_nothing`: same counts, `applied False`, rows and storage keys unchanged, no new objects.
  - `test_ids_and_indexes_do_not_change`: `Frame.id`, `frame_index`, `sequence_id` and annotation labels / `taxonomy_version` are the same after.
- [ ] **Step 2: Run, expect FAIL** (404 on the route): `cd backend && uv run pytest tests/test_frame_crop_api.py -q`
- [ ] **Step 3: Implement.** Schemas as above. `crop_frames` loads the frames of the sequence among `frame_ids` and their annotations with a `storage_key` or `raw_mask_storage_key`; decodes images with `cv2.imdecode(..., IMREAD_COLOR)` and masks with `IMREAD_GRAYSCALE`; cuts with a helper `_cut(image, crop)` that uses the same arithmetic as `_apply_crop` (import and reuse `_apply_crop` from `app.media.service` rather than copying it); counts `masks_clipped` from the non-zero pixels of the annotation's `storage_key` mask outside the kept rectangle; re-encodes PNG. In the real (not dry-run) path upload every new object under a new key `f"{old_key.rsplit('.', 1)[0]}-{uuid4().hex[:8]}.png"`, update `Frame.storage_key/width/height/size_bytes` and `Annotation.storage_key/raw_mask_storage_key` in one `session.commit()`, and only after the commit delete the old objects. Route in `router.py` is thin: call `crop_frames`, map errors in Task 2.
- [ ] **Step 4: Run, expect PASS.** Then re-export openapi.
- [ ] **Step 5: Commit** `feat(media): crop frames and their masks in place`

### Task 2: Guards and failure safety

**Files:**
- Modify: `backend/app/media/frame_crop.py`, `backend/app/media/router.py`
- Test: `backend/tests/test_frame_crop_api.py`

**Interfaces:**
- Consumes: Task 1 `crop_frames`, `FrameCropRequest`.
- Produces: exceptions in `frame_crop`: `CropRefused(Exception)` carrying a message, mapped to 422 by the route (409 for datasets via the existing helper, 404 for an unknown sequence).

- [ ] **Step 1: Write failing tests:**
  - `test_all_zero_crop_is_refused` → 422 (also for a request whose crop leaves no area: `left 60, right 40`).
  - `test_unknown_sequence_is_404`; `test_a_frame_of_another_sequence_is_refused_and_nothing_changes` (422, the sequence's own frame in the same request is also unchanged); `test_empty_frame_ids_is_422`; `test_more_than_500_frames_is_422`.
  - `test_frames_in_a_dataset_are_refused_with_409`: reuse how `tests/test_media.py` puts frames into a dataset for the bulk-delete guard.
  - `test_a_mask_with_a_different_size_aborts_everything`: the mask is 32x32 on a 64x48 frame → 422, no row changed, no new object, old objects intact.
  - `test_an_unreadable_image_aborts_everything` (bytes that are not an image) → 422, nothing changed.
  - `test_a_failure_after_upload_leaves_the_database_untouched_and_deletes_new_objects`: a `FakeStorage` whose third `upload` raises → the response is an error, rows are unchanged, no new objects remain, old objects remain.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Validate before any download (ids belong to the sequence, count 1..500, non-zero crop, dataset guard via `_raise_if_frames_in_datasets`); size and decode errors raise `CropRefused` before the first upload; wrap upload + commit in try/except that rolls back, deletes the objects uploaded so far (best effort, like `store_frames_as_sequence`) and re-raises.
- [ ] **Step 4: Run the whole file, expect PASS; run `tests/test_media.py -k bulk_delete` to confirm the shared helper still passes.**
- [ ] **Step 5: Commit** `feat(media): guard and make frame crop all-or-nothing`

### Task 3: Automatic crop proposal for stills

**Files:**
- Modify: `backend/app/media/frame_crop.py`, `backend/app/media/schemas.py`, `backend/app/media/router.py`
- Test: `backend/tests/test_frame_crop_api.py`

**Interfaces:**
- Produces: `frame_crop.detect_frames_crop(storage: StorageService, frames: list[Frame]) -> CropBox | None`; `schemas.FrameDetectCropRequest {frame_ids: list[int]}`, `schemas.FrameDetectCropResult {crop: CropBox | None}`; route `POST /media/sequences/{sequence_id}/frames/detect-crop` → `FrameDetectCropResult`.

- [ ] **Step 1: Write failing tests** with synthetic stills (a textured disc or noise rectangle inside a black border, plus a small bright "text" block in the border):
  - `test_detect_finds_the_picture_inside_a_black_border`: three frames with the same border (left 20 %, right 10 %) → insets within 2 points, never tighter than the true border.
  - `test_overlay_text_in_the_border_does_not_widen_the_area`.
  - `test_a_borderless_frame_gives_null`; `test_a_tiny_picture_gives_null`.
  - `test_frames_that_disagree_by_more_than_5_points_give_null` (borders 10 % and 30 %).
  - `test_detect_uses_the_median_across_frames` (three frames, one with an odd border within 5 points).
  - `test_detect_route_validates_ids_like_crop` (foreign id → 422).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Per frame: grayscale, downscale to width 320, threshold near-black (named module constant), open with a small kernel, `connectedComponentsWithStats`, bounding box of the largest component, insets in percent; combine per side by the median; return `None` if the largest region covers under 5 % of the frame, if any side's spread exceeds 5 points, or if every median inset is under 1 point; loosen each inset by a 1-point margin (floor 0), round to 1 decimal. Same id validation as Task 2 (reuse the helper).
- [ ] **Step 4: Run, expect PASS; re-export openapi.**
- [ ] **Step 5: Commit** `feat(media): propose a crop from the border of selected frames`

### Task 4: Frontend hooks and the crop panel

**Files:**
- Create: `frontend/src/entities/useFrameCrop.ts`, `frontend/src/features/annotation/FrameCropPanel.tsx`, `frontend/src/features/annotation/FrameCropPanel.test.tsx`

**Interfaces:**
- Consumes: Task 1/3 routes through the regenerated client (`npm run generate-api`); `CropFields`, `ZERO_CROP`, `Crop`, `CropOverlay`, `computeVideoMediaRect` from `features/media`.
- Produces:
  - `useCropFrames()` mutation: `mutateAsync({sequenceId, frameIds, crop, dryRun}) → FrameCropResult`; on a real apply (`dryRun false`) it invalidates `["frames", sequenceId]`, `["frame"]` and the annotation queries the tag-regions hooks invalidate (see `useAnnotations.ts`).
  - `useDetectFramesCrop()` mutation: `mutateAsync({sequenceId, frameIds}) → {crop: Crop | null}`.
  - `FrameCropPanel({sequenceId, frameIds, previewUrl, hasVideo, onClose})`.

- [ ] **Step 1: Write failing tests** (mock the two hooks as in `CropPicker.test.tsx`): the panel shows the four fields and, for a non-zero crop, the overlay over the preview image; "Preview" calls the crop mutation with `dryRun true` and shows "N frames, M masks"; when `masks_clipped > 0` it shows a warning with the number; "Apply" is disabled until a preview exists for the current crop and frames, and the first click arms a confirmation that says the frame count and "cannot be undone", the second click calls the mutation with `dryRun false` and then `onClose`; editing a field or changing `frameIds` discards the preview; "Detect automatically" fills the fields, a `null` result shows "No border found" and leaves the fields alone; a sequence with `hasVideo` shows the one-line re-cut note; Escape calls `onClose`; an API error is shown in the panel.
- [ ] **Step 2: Run, expect FAIL**: `cd frontend && npm run generate-api && npx vitest run src/features/annotation/FrameCropPanel.test.tsx`
- [ ] **Step 3: Implement** the hooks and the panel, following `TagRegionsPanel.tsx` for layout, the armed-confirm pattern and error display.
- [ ] **Step 4: Run, expect PASS; `npx tsc -p tsconfig.app.json --noEmit` shows no new errors in the touched files.**
- [ ] **Step 5: Commit** `feat(frames): crop panel for selected frames`

### Task 5: Wire the panel into the sequence grid

**Files:**
- Modify: `frontend/src/features/annotation/SequenceGridToolbar.tsx`, `frontend/src/features/annotation/SequenceGridPage.tsx`
- Test: `frontend/src/features/annotation/SequenceGridToolbar.test.tsx`, `frontend/src/features/annotation/SequenceGridPage.test.tsx`

**Interfaces:**
- Consumes: `FrameCropPanel` from Task 4.
- Produces: toolbar props `firstSelectedImageUrl?: string`, `sequenceHasVideo?: boolean`.

- [ ] **Step 1: Write failing tests:** the toolbar shows a "Crop" button only with `sequenceId` set, and it is disabled with no selection; clicking it opens the panel, clicking it again or Escape closes it; opening it closes the tag-regions panel and the reverse (one popover at a time, as the existing buttons do); the page passes the first selected frame's `image_url` and whether the sequence has a video.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** in the toolbar next to the tag-regions button using the same open-state pattern; the page computes the two props from `selectedFrames[0]` and the sequence.
- [ ] **Step 4: Run `npx vitest run src/features/annotation`, expect PASS; run the whole `npx vitest run`, expect no new failures.**
- [ ] **Step 5: Commit** `feat(frames): open the crop panel from the sequence grid`

### Task 6: Real-stack check and docs

**Files:**
- Modify: `ROADMAP.md`, `CHANGELOG.md`

- [ ] **Step 1:** Ask before restarting anything; the backend runs with `--reload`, so it picks up the routes. Create a throwaway photo sequence through the API from a real frame (a screenshot with a black border is enough; use no patient frames, scrub any overlay text before it lands in the repo or docs). Give one frame a mask annotation (through the existing API) and one a classification.
- [ ] **Step 2:** In the browser: select all, open Crop, run Detect automatically, read the preview counts, apply; thumbnails reload; open the masked frame and confirm the mask still lies on the same structure; confirm a frame outside the selection is unchanged.
- [ ] **Step 3:** Try a dataset-protected frame (409 message shown) and a second crop of an already cropped frame.
- [ ] **Step 4:** Delete every throwaway row and MinIO object (frames, masks, sequence), listing the prefixes before and after. Add a ROADMAP section (what shipped, deviations, what was and was not checked live) and a CHANGELOG line. Do not put video titles or patient-like names in either file.
- [ ] **Step 5: Commit** `docs: record frame crop in the roadmap and changelog`
