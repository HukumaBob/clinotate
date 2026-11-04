# Crop frames of an existing sequence

Status: draft for approval, 2026-11-04. Sub-project B of the crop /
train-inference-mismatch fix (A, the QC working area, is done). B replaces
the first idea ("crop when a photo set is uploaded"): cropping existing
frames also fixes data that is already stored, so no upload-time crop is
built.

## Why

Training frames are meant to be the clean-video region only. Frames cut from
a video get that through `Sequence.crop_box`, but photo sets (sequences with
no video, uploaded as-is) and older sequences hold frames that still carry
the black border and the device overlay. The platform has 1429 frames, six
photo-only sequences, and a mix of devices, so one frame can need a
different border than the next. Re-creating sets is not an option: frames
carry annotations.

## Goals

- In the sequence grid, select frames, set a rectangle, apply: the selected
  frames are cut to it. Frames with a different border are selected and cut
  separately.
- Every annotation mask of a cropped frame is cut by the same rectangle, so
  mask and image stay aligned.
- An automatic proposal of the rectangle from the selected frames, which the
  user can edit before applying.
- A preview before applying that says how many frames and masks are
  affected and whether any mask has pixels in the area being removed.

## Non-goals

- No undo and no stored original: the crop is irreversible, by the user's
  decision. The preview and a confirmation are the safeguard.
- No crop at upload time, no change to `POST /media/sequences/photos`.
- No `Frame.crop_box` column and no migration: nothing needs to read the
  applied rectangle back.
- No change to `Sequence.crop_box` and to how video sequences are cut. A
  video sequence that is re-cut regenerates its frames from the video with
  the sequence's own crop and discards a crop applied here; the panel says
  so for sequences that have a video.

## Anti-goals

- A frame or mask left half-processed (image cropped, mask not, or the
  reverse), or a storage object left orphaned after a failure.
- Cropping frames that datasets or past exports depend on.
- A proposal that cuts into the picture: when unsure the proposal is
  looser, or absent.

## Decisions already made with the user

- Select frames, crop, save; different borders handled by separate
  selections; an automatic crop proposal in addition to manual fields.
- Irreversible crop.

## Design (calls of mine are marked)

### API

- `POST /media/sequences/{sequence_id}/frames/crop`, body
  `{frame_ids: int[], crop: CropBox, dry_run: bool = false}`.
  `CropBox` is the existing percent-inset model. The rectangle is applied to
  each frame as a percentage of that frame's own size, so a mixed-size
  selection works (same arithmetic as `_apply_crop`: `int()` truncation per
  side). A crop with all-zero insets is refused (422, nothing to do).
  Response: `{frames: int, annotations: int, masks_clipped: int, applied: bool}`
  where `masks_clipped` counts annotations whose mask has any non-zero pixel
  in the removed area. `dry_run=true` returns the same counts and writes
  nothing (the pattern of `commit-episodes`).
- `POST /media/sequences/{sequence_id}/frames/detect-crop`, body
  `{frame_ids: int[]}` → `{crop: CropBox | null}`.
- Validation: every id must belong to the sequence (otherwise 404/422, none
  applied); at most 500 frames per request (my call, a cap in the spirit of
  the 1000-source-region cap elsewhere); frames in a dataset are refused
  with 409 via the existing `_raise_if_frames_in_datasets` (the same rule as
  deleting frames).

### Applying a crop

- All-or-nothing. For each frame: download the image, cut it, re-encode as
  PNG; for each annotation of the frame that has `storage_key` and/or
  `raw_mask_storage_key`, download the mask, require its size to equal the
  frame's, cut it, re-encode. Anything unreadable or size-mismatched aborts
  the whole request (422) before anything is written.
- Cut images and masks are uploaded under **new** storage keys (my call:
  avoids stale browser or presigned-URL caches of the old image); the
  database rows (`Frame.storage_key/width/height/size_bytes`,
  `Annotation.storage_key/raw_mask_storage_key`) are updated in one commit;
  only after the commit are the old objects deleted. A failure before the
  commit deletes the new objects (best effort) and leaves the database as
  it was. This is the ordering `bulk_delete_frames` already uses.
- Annotations without geometry (classification) are untouched. Tag-region
  copies are annotations like any other and are cut too.
- Frame ids, frame indexes, labels and `taxonomy_version` do not change.

### Automatic proposal

- Per frame: grayscale, threshold the near-black pixels, remove small
  specks, take the bounding box of the largest connected non-black region
  (the endoscope picture; overlay text sitting in the black area is small
  and drops out). Per-frame insets are combined across the selected frames
  by the median (my call, robust to one odd frame). If the frames disagree
  by more than 5 percentage points on any side, or the region is tiny, or
  no side has an inset of at least 1 point, return `null` (the UI then says
  why). Insets are loosened by a 1 point margin, as in the QC detector.
- Thresholds are builder's values, to be checked on real frames from the
  dev database.

### UI

- Sequence grid: a "Crop" panel in the toolbar next to the existing tag
  regions panel (same props pattern: `sequenceId`, `selectedFrameIds`),
  enabled when frames are selected. It shows a preview of the first
  selected frame with the existing `CropOverlay`, the four `CropFields`, a
  "Detect automatically" button, and "Preview" / "Apply". Apply asks for a
  confirmation that states the frame count, the mask count, `masks_clipped`
  if non-zero, and that it cannot be undone. After applying, the frame
  queries are invalidated so thumbnails reload.
- For a sequence with a video, a one-line note about the re-cut caveat.

## Testing

- Backend: crop of an image-only frame (size and content), of a frame with a
  mask and a raw mask (same rectangle, same size as the frame), dry-run
  writes nothing, `masks_clipped` is right, a mask-size mismatch aborts with
  nothing changed, a failure after upload leaves the database untouched and
  deletes the new objects, a frame outside the sequence or in a dataset is
  refused, all-zero crop refused, mixed-size selection; detect-crop on
  synthetic bordered stills, on a borderless frame (null) and on disagreeing
  frames (null). Tests use `import app.db as db_module`, never the real DB.
- Frontend: panel enabled only with a selection, preview then apply flow,
  confirmation text, detect fills the fields, null proposal message.
- Real-stack check on a throwaway copy: a photo sequence with a masked
  frame, crop with and without a mask, thumbnails reload, mask still
  aligned. Clean up the rows and MinIO objects.

## Left to the builder

- Threshold and speck-removal values of the proposal.
- Exact panel layout; whether the preview shows more than the first frame.
- A job-in-flight guard (a SAM job touching the same frames); not required
  here, add only if cheap.
- Re-export `openapi.json` after the schema change.
