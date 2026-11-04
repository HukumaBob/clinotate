# QC working area: crop frames before the model, as in training

Status: draft for approval, 2026-11-03. Sub-project A of two. Sub-project B
(crop when uploading a photo set) gets its own short design afterwards.

## Why

Training data is cut from the "clean video" region only: the black frame
and the device overlay (patient name, date, player chrome) are removed by
hand, via `Sequence.crop_box`, when frames are extracted from a video.
Inference does the opposite: the ml-worker feeds the model the *whole*
decoded frame, border and overlay included. Same model, two different input
distributions. After resizing to the model's input size, objects have a
different scale, and a classifier that looks at the entire frame also sees
device-specific pixels it never trained on. Quality drops, and QC then
measures the mismatch rather than the model.

The border differs per device and the doctor can move the picture
(left/right/etc.), so no fixed constant or per-device preset is possible.
The crop has to be decided per video.

## Goals

- Every QC inference run (classification, detection, segmentation) feeds
  the model the same kind of region that training saw: the clean-video
  area, cropped per video.
- The area is chosen when a run is created: by hand with the same editor
  the sequence form already uses, or detected automatically and then
  adjustable by hand.
- The QC player keeps showing the **full** video, with the working area's
  outline drawn on it. Detections and masks lie on the full frame.
- Frames flagged in QC and committed to a sequence (training data) are
  cut with the same area, so they match what the model saw.

## Non-goals

- No crop on `Video`. Sequences keep their own `crop_box`; the existing
  mechanism for sequence extraction is unchanged.
- No per-frame or moving crop. One rectangle per run.
- No retroactive change of existing runs or of already stored frames.
  Existing runs have no area and mean "full frame", as before.
- Photo-set upload is sub-project B.
- No automatic switching of what the model sees based on device
  recognition, no model-side learning of borders (mixing bordered frames
  into the training set was considered and rejected, see below).

## Anti-goals (a failure even if it technically works)

- Detections or masks drawn shifted on the full-frame player.
- Auto-detection that crops into the lumen (too tight) so QC silently
  evaluates a different picture than training did. When unsure, the
  detector must prefer a looser area and the user adjusts.
- Training-vs-inference drift reintroduced through the commit path:
  committed FP/FN frames must not be full-frame while the model saw crops.

## Decisions already made with the user

- Crop at inference for all three tasks, not only classification. The
  border matters less for detection/segmentation but it still matters.
- Rejected: training on a mix of bordered frames from many devices. It
  spends model capacity on ignoring noise, risks learning the overlay as
  a shortcut (an overlay correlated with a class), and needs devices we
  may not have. Cropping removes the nuisance deterministically.
- The area is created when a run is created (manual or automatic) and is
  used as the run's "working zone".
- The player shows the full video with the zone outline.
- Existing manual crop mechanism for sequences stays as is.

## Design (builder's calls marked "my call")

### Data

- `InferenceRun.crop_box`: nullable JSON, same shape and validation as the
  existing `CropBox` (percent insets: left/right/top/bottom, each 0..100,
  opposing sides sum below 100). `null` = no crop. Alembic migration adds
  the column. Exposed in `InferenceRunRead` and accepted in
  `InferenceRunCreate` (both the single-model and the classifiers form).
- The value is copied into the Celery job payload as `crop_box`.
  (my call: percent insets rather than pixels, because the existing editor,
  overlay and `_apply_crop` already speak percent and it is independent of
  resolution.)

### Cropping in the ml-worker

- `UltralyticsInferenceAdapter` and `ClassificationAdapter` take
  `crop_box` in their request and crop each retrieved frame right after
  `capture.retrieve()`, before the perturbation (my call: the stress test
  should perturb what the model actually receives) and before the model.
  Use one shared helper whose arithmetic is identical to
  `app.media.service._apply_crop` (same `int()` truncation), so training
  frames and inference frames are cut the same way. The ml-worker is a
  separate package and cannot import the backend, so the helper is
  duplicated with a test pinning both to the same outputs.
- Detection/segmentation: the model outputs normalised coordinates
  relative to the cropped image. Before writing the predictions document,
  map every bbox and polygon point back to the full frame using the real
  pixel rectangle kept by the crop (after `int()` truncation):
  `x_full = (x0 + x * (x1 - x0)) / width`, likewise for y. (Implementation
  call: nominal percentages differ from this on odd frame sizes.) Stored predictions are therefore always in
  full-frame normalised coordinates, and the frontend needs no remapping.
  Bbox width/height scale by the same factors.
- The predictions document records the applied `crop_box` for traceability
  (optional key; absent for old runs).
- Classification output is per frame, no geometry; only the crop applies.

### Choosing the area

- Run form (`frontend/src/features/qc/RunForm.tsx`): add the existing
  `CropFields` and show `CropOverlay` on the QC video preview. Default is
  "auto".
- Auto-detection, backend endpoint `POST /inference/videos/{id}/detect-crop`
  returning a `CropBox` (my call: a separate endpoint, so the form can show
  the proposal and let the user adjust it before starting the run).
  Method: sample about 50 frames spread across the video, compute the
  per-pixel standard deviation over time, threshold it, take the bounding
  box of the largest connected region, add a small margin, return it as
  percent insets. Rationale: the endoscope image changes over time while
  the border and burned-in text are static even when bright.
  Behaviours to define in the plan: videos too short or too static to
  decide (return no crop and say so), margin size (my call: default to the
  same slack the user leaves by hand, verified on real labelled videos
  before trusting it).
- The form should suggest the video's most recent sequence `crop_box` as a
  starting point (my call: matches the existing `mostRecentCrop`
  behaviour and costs nothing), with auto-detect as an explicit button.

### Player

- `RunViewPage` / `PredictionOverlay` draw `CropOverlay` for the run's
  `crop_box` over the full video, using the existing `mediaRect` logic.
  No change to how detections are drawn, since they are already in
  full-frame coordinates.
- A/B compare (two runs on one video): each run may have its own area;
  the outline of each is drawn in its own pane. Runs with different areas
  remain comparable because both store full-frame coordinates and
  per-frame labels. Axis agreement for classification is unaffected.

### Flag commit path

- `store_frames_as_sequence` / `extract_frames_at` get an optional `crop`,
  and `commit_flags` passes the run's `crop_box`. The created `Sequence`
  stores that `crop_box`, like a sequence cut from the video form.
  A run with no area behaves exactly as today.

## Testing

- Unit: the crop helper (percent to pixel arithmetic, zero crop identity,
  parity with `_apply_crop`); coordinate remap for boxes and polygons,
  including the round trip crop then remap on a synthetic frame.
- Adapters with a fake model: detections come out in full-frame
  coordinates for a non-trivial `crop_box`.
- Backend API: create run with and without `crop_box`, validation errors,
  payload contains the crop; detect-crop on a synthetic video with a
  static border and moving centre, and on a static video.
- Commit path: frames cut with the run's crop, sequence `crop_box` set.
- Frontend: form fields and overlay, player outline.
- Per project rules: one real-browser pass against the real stack, and a
  real run on a video with a border comparing quality with and without
  the area. Tests must use `import app.db as db_module`, never the real
  database.

## Left to the builder

- Margin and threshold values of the auto-detector, validated on the
  user's real videos.
- Exact UI placement of the auto-detect button and the preview.
- Whether the shared crop helper lives in one more place; keep it small.
- Re-export `openapi.json` after schema changes, per CLAUDE.md.
