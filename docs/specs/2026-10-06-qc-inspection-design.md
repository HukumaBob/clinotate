# QC screen, sub-project 2: inspection

Date: 2026-10-06. Status: implemented 2026-10-06; verified in a real browser.

Extends [the inference-runs design](2026-10-06-qc-inference-runs-design.md)
(sub-project 1, implemented). Source material for the whole module is
`yolo_qc_playground_architecture.pdf` (untracked, Russian); this document
designs its second slice, "Inspection". See the decomposition in the
sub-project 1 spec: 1 inference runs (done), **2 inspection (this document)**,
3 QC flagging to dataset, 4 A/B and stress tests, 5 interpretability.

## Goal

Let a person looking at a finished run choose a confidence threshold for real
use, find the suspicious places in a long video without scrubbing all of it,
and see how fast the model is, using only the predictions already stored for
the run. Flagging errors and returning frames to a dataset is sub-project 3.

## Decisions

| Question | Decision |
|---|---|
| NMS IoU slider from the PDF | Client-side NMS over the stored boxes, slider 0.30 to 0.70. It can only be stricter than the model's own 0.7. |
| Flicker definition | By class presence over processed frames (a short run of presence, or a short gap between two presences), no box tracking. |
| Timeline markers | A custom strip under the player with click-to-seek and previous/next-event navigation. No event table. |
| Latency | Aggregates only, written by the worker into the predictions document. No per-frame timings. |
| Where analysis runs | Entirely on the client, as pure functions over the loaded document. |

Rejected: re-running inference for a new IoU (not interactive); box tracking
for flicker (a mini tracker whose linking is unreliable at stride above 1); a
backend analysis endpoint (a request per slider move and a second source of
truth); a Web Worker (infrastructure for a problem not yet measured).

## Data and worker

Only one thing changes in storage: an optional top-level `timing` block in the
predictions document. No database column, API route, schema or migration
changes, and `openapi.json` is unchanged.

```json
"timing": {
  "frames_measured": 659,
  "preprocess_ms":  {"mean": 1.9, "p50": 1.8, "p95": 2.6, "max": 4.1},
  "inference_ms":   {"mean": 9.4, "p50": 9.1, "p95": 12.0, "max": 21.7},
  "postprocess_ms": {"mean": 1.2, "p50": 1.1, "p95": 1.9, "max": 3.3},
  "total_ms":       {"mean": 12.5, "p50": 12.0, "p95": 15.8, "max": 26.0},
  "model_fps": 80.0
}
```

- Source: Ultralytics' `result.speed` (preprocess, inference, postprocess
  including NMS, in milliseconds, per frame). `total_ms` is the per-frame sum
  of the three; `model_fps` is `1000 / mean(total_ms)`. Video decoding is not
  included: this is model time.
- Percentiles use the nearest-rank method.
- The first measured frame is discarded as GPU warm-up. If only one frame was
  measured it is kept.
- A model object without a usable `speed` yields no `timing`; the field is
  then omitted. A missing measurement never fails a run.
- Older runs (including those made before this change) have no `timing`; the
  field is optional and the format stays backward compatible.
- `InferenceResult` gains `timing: dict | None`. The aggregate computation is
  a pure function in the adapter module. The `inference_run` task writes
  `result.timing` into the document next to `fps` and `classes`.

## Client analysis (`frontend/src/features/qc/analysis/`)

Pure functions with no React. Parameters: `{ threshold, nmsIou, flickerN }`.

- **View.** `buildView(doc, params)` returns the existing `FrameIndex` shape
  with the parameters applied, so the overlay, the legend counts,
  `detectionsAt` and `countByClass` read it instead of the raw document
  without changing their own logic. Steps per frame: keep detections with
  `confidence >= threshold` (boundary included, as today), then greedy
  class-aware NMS (sort by confidence, drop a box whose IoU with an already
  kept box of the same class is `>= nmsIou`). At `nmsIou = 0.70` NMS is skipped
  because the model already applied it at that value. IoU is computed on boxes
  for segmentation too; polygons are not intersected.
- **Flicker.** `findFlickers(view, classCount, n)`. For each class build a
  per-processed-frame presence series ("at least one detection of the class").
  A **blink** is a run of presence of length at most N bounded by absence on
  both sides; a **dropout** is a run of absence of length at most N bounded by
  presence on both sides. A run that touches the start or end of the video is
  not an event, because its boundary is unknown. Events are
  `{ classId, kind, startMs, endMs, frames }` where the times are the
  timestamps of the first and last frame of the run, sorted by `startMs`. It
  also returns `isCoarse`, true when the median spacing between processed
  frames multiplied by N exceeds 1000 ms.
- **Strip.** `buildStrip(doc, durationMs, buckets, threshold)` assigns each
  time bucket a level from the maximum raw confidence of the processed frames
  that fall inside it: `strong` (max at least 0.7 and at least the threshold),
  `moderate` (at least the threshold and below 0.7), `weak` (any detection
  but below the threshold), `none`. It uses the raw document because NMS never
  changes a maximum and "weak" must remain visible when the threshold is high.
  A bucket with no processed frame inherits the previous bucket's level, which
  matches how the overlay holds the previous frame.
- **Navigation.** `nextEvent(events, timeMs)` and `prevEvent(events, timeMs)`
  return the first event starting strictly after, or the last strictly before,
  the current time (1 ms tolerance).

All passes are linear in the number of detections (a 5,000-second video at
25 fps is on the order of 200,000). Recomputation of the view and the events
is deferred with `useDeferredValue` so the sliders stay smooth.

## Interface (`/qc/:runId`)

Layout is unchanged: video on the left, a side panel on the right, stacked on
narrow screens. Three additions.

1. **Strip under the player**, full width of the video. Coloured segments by
   level, flicker marks on top (blink and dropout as different shapes, colour
   by class), a playhead, a hover tooltip with time and maximum confidence.
   Click seeks. "Previous event" and "Next event" buttons (disabled when there
   are no events) and the keys `[` and `]`. Native arrows and space are left
   alone and the letter `N` is reserved for sub-project 3's "false negative".
   A small colour legend, and "No flicker events at these settings" when
   empty.
2. **Display panel** at the top of the side panel: Confidence (0.05 to 1.00,
   step 0.01, default 0.25), NMS IoU (0.30 to 0.70, step 0.05, default 0.70,
   labelled "off" at 0.70), Flicker window N (1 to 10, default 2), and Reset.
   Values persist in `localStorage` (shared by all runs, wrapped in try/catch,
   clamped to the ranges on load; without storage the defaults apply). The
   class legend and its counts follow the view. Below them a line "N flicker
   events (a blink, b dropout)". When `isCoarse` a yellow notice says stride
   is too coarse for flicker detection.
3. **Latency panel**: a table of the four stages with mean, p50, p95 and max,
   plus "Model speed: 80 fps (659 frames measured)". For a run without
   `timing`: "Not recorded for this run".

A hook `useVideoClock(videoRef)` reads `currentTime` from a
`requestAnimationFrame` loop and updates state only when it changes, for the
playhead. The overlay keeps its own loop. The number of strip buckets equals
the container width via `ResizeObserver`, capped at 1600. Sliders have labels
and `aria-valuetext`; the strip has `role="img"` with a description; the event
buttons are keyboard reachable.

## States and errors

- Predictions loading: Display and Latency panels disabled, a placeholder where
  the strip goes; the player already works.
- Predictions failed: the existing message, analysis panels hidden.
- No detections at all: empty strip, no events, zero counts. Not an error.
- No `timing`: "Not recorded for this run".
- Storage unavailable or corrupt: defaults; loaded numbers clamped.

## Testing

Test-first, per CLAUDE.md.

- ml-worker (in the container): the aggregate function (mean, p50, p95, max,
  warm-up discard, a single frame, empty input), the adapter with a stub model
  that has `speed` and one that does not, and the task writing `timing`.
- Client pure functions: `buildView` (threshold boundary, class-aware NMS,
  skipped at 0.70, identical boxes), `findFlickers` (blink, dropout, runs at
  the edges, N, `isCoarse`), `buildStrip` (levels including a threshold above
  0.7, inheritance, empty), event navigation, parameter read/write with range
  clamping.
- Components through props: the Display panel, the Latency panel, the event
  buttons. Strip drawing and `useVideoClock` are browser glue verified in a
  real browser, not with mocks.
- Before the work is called done: a new run on a short video so that `timing`
  exists (values plausible), the sliders and recomputation on real data,
  flicker events on a real video, and a timing measurement of the recompute on
  run #82 (19,800 frames) with a target of tens of milliseconds, not hundreds.

## Edge cases

Empty document, a single processed frame, all frames below the threshold,
identical boxes in NMS, threshold exactly on a confidence, a run at the video
edge, N larger than the run, a class id outside `classes`, a threshold above
0.7, a document without `timing`.

## Out of scope

Flagging false positives and negatives and committing to a dataset
(sub-project 3); model comparison and stress tests (4); Grad-CAM, anomaly
reels and export (5); per-frame latency and its chart; tracking boxes into
tracks; a Web Worker; red "human flagged" strip marks; a class filter;
per-run saved parameters; NMS over masks. The cosmetic flash of "Train a
detect or segment model first." on `/qc` is a separate small fix.

## Open items for the implementation plan

- The exact "coarse stride" constant (1000 ms in this design) may need tuning
  after real use.
- The slider recompute budget is a target, to be confirmed on run #82.

## Deviations from the first draft

- `buildStrip` returns `{ level, maxConfidence }` per bucket, so the hover
  tooltip can show the best confidence.
- The previous/next event buttons are disabled only when there are no events;
  clicking when none exists in that direction does nothing.
- The loading state shows a text placeholder instead of disabled panels, and
  the Latency panel is not rendered until the predictions load.
- The strip and the event buttons render only when the duration is known and
  positive (otherwise the same placeholder).
- Aggregates keep two decimals.
- `summarize_timing` ignores NaN, infinity and bool stage values, so the
  predictions document can never contain bare `NaN`/`Infinity`.
- The keys also match the physical bracket keys (`BracketLeft`/`BracketRight`)
  so they work on any keyboard layout, ignore Ctrl/Meta/Alt, and a focused
  range slider does not block them.
- The flicker window field ignores an empty edit (it keeps a local draft and
  restores the value on blur).
- A null or partial `timing` is treated as not recorded.

## Verification

Run on the real stack on 2026-10-06 with a fresh run (stride 5, 3960 frames,
`yolo11n-run268`; deleted afterwards) and the user's run #82 (stride 1, left
untouched).

Passed:
- Timing: `timing` block present, 3959 frames measured (warm-up dropped),
  inference mean 6.08 ms (p95 6.81, max 161.62), total mean 7.89 ms,
  model_fps 126.8; stage means sum to the total.
- Strip: one bucket per pixel, hover tooltip, click-to-seek, playhead.
- Threshold slider at 0.05/0.25/0.5/0.9: the painted strip equals an
  independent `buildStrip` in all cases; hidden detections are not painted
  green. NMS slider: "off" at 0.70, counts fall at 0.5 and 0.3.
- Flicker window N=1..10; the coarse notice appears from N=6 at stride 5;
  events checked against the raw frames.
- Navigation by buttons and by `[`/`]`; the keys are ignored while the
  flicker field has focus.
- Persistence across reload, Reset, and a corrupt stored value falling back to
  defaults.
- Old run #82 shows "Not recorded for this run".
- Performance on #82 (19,800 frames, 33,822 detections), median of 5:
  buildView 3.2 ms (worst case 6.4 ms), findFlickers 2.3 ms (580 events),
  buildStrip 1.1 ms.
- Resize to 1000x800 rebuilds the strip to its CSS width; 0 console errors or
  warnings.

Not verified: a segmentation run, hiDPI, touch, blocked storage in a real
browser (unit-tested only), the coarse notice on a stride-30 run, playback CPU
with hundreds of marks, and whether the database `duration_seconds` equals the
real stream duration.

Observations: at stride 1 the flicker marks overlap into a band along the
strip; clustering them is a follow-up.
