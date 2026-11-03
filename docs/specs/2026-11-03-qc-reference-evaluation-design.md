# QC screen: evaluation against the reference, sub-project 3 of 4

Date: 2026-11-03. Status: implemented on master 2026-11-03 and live-checked (see ROADMAP). Builds on
[QC classification](2026-11-03-qc-classification-design.md) (sub-project 1) and
[reference labeling](2026-11-03-qc-reference-labeling-design.md) (sub-project 2),
both done.

Decisions marked **(my call)** were made by the author, not the user, and are
open to challenge. Everything else was stated by the user.

## Why

A classification run on a video that has a hand-labeled reference can now be
shown next to that reference, but the user still has to compare the two lanes
by eye. The user wants the platform to score the model against the reference
automatically and to pull out the most useful facts, so that the same mistakes
are not repeated: which classes are confused with which, where the errors sit
(at transitions, which are usually benign, or inside a stable stretch), which
errors the model made confidently, and whether the model flickers more than the
reference changes.

## Goals

- Score one classification run against the reference of its video, per model
  axis, on every processed frame that lies inside a labeled reference interval.
- Show, per axis: frame accuracy; per-class precision, recall, F1 and support;
  the confusion matrix; error **episodes** (runs of consecutive wrong frames)
  with a jump to the moment; errors near a reference boundary separated from
  errors inside an interval; the model's switching delay at reference
  transitions; the model's label switches against the reference transitions;
  and the model's confidence in each episode so confident errors rise to the top.
- Mark the erroneous stretches on the model lane (red hatching), so the paired
  reference and model lanes show mismatches at a glance.
- Compute everything on the server from the stored predictions and the stored
  intervals, so sub-project 4 can use the same episodes to build a dataset.

## Non-goals

- A summary over several reference videos (one model on several videos). One
  run is scored at a time; a cross-video summary can later be built on the same
  endpoint.
- Turning episodes into frames or datasets (sub-project 4).
- Scoring detection or segmentation runs; comparing the scores of two runs.
- A confidence threshold or any filtering of what the model said: scoring uses
  the model's top-1 class exactly as stored.
- Writing anything: evaluation is a pure read. Nothing is stored.

## Anti-goals

- Scores that look better than they are. Gray zones and frames outside the
  reference are excluded, never counted as correct. A model class the
  reference never uses, and a reference class the model cannot output, must
  both show up in the numbers, not vanish.
- Hiding that the reference is not an independent test. If the reference is
  *compromised*, scores are still shown but marked optimistic.
- A slow endpoint. A long video with tens of thousands of processed frames must
  be scored in well under a few seconds.

## Decisions

| Question | Decision |
|---|---|
| Where it runs | On the server: `GET /reference/runs/{run_id}/evaluation?boundary_ms=2000`, downloading the run's predictions document from storage as the A/B comparison already does. Pure functions in `backend/app/reference/evaluation.py`; no tables. **(my call)** |
| Which frames | Every processed frame of the run whose timestamp `ts` lies in a reference interval of the matched axis (`start_ms <= ts < end_ms`). Frames in gaps, and frames of a model axis with no matching reference axis, are *excluded* and only counted. |
| Matching a model axis to a reference axis | By class names, exactly as on the run page (`matchAxes`): the reference axis sharing the most class names with the model axis, ties to the lower category id, none when nothing is shared. Orphaned intervals are ignored. |
| Truth and prediction | Truth is the label name of the reference interval that contains the frame; prediction is the model's top-1 class name taken from the run's document (`axes[i].classes[class_id]`). |
| Class vocabulary | The union of the model axis's classes and the reference axis's classes. A truth class the model cannot output gets recall 0 and shows up as a confusion-matrix row; a model class never present in the truth gets support 0 and shows its false positives. Ratios with a zero denominator are `null`, not 0. |
| Per-class numbers | `tp`, `fp`, `fn`, `support` (truth frames of the class), `precision`, `recall`, `f1`. Overall `accuracy` over evaluated frames and `macro_f1` over classes with support greater than 0. |
| Error episode | A maximal run of consecutive *evaluated* processed frames (no gap frame between them) with the same truth class and the same wrong predicted class. Fields: `start_ms`, `end_ms` (timestamp of the first and of the last frame), `frames`, `truth`, `predicted`, `kind`, `mean_confidence`, `max_confidence`. |
| Boundary versus interior | An error frame is a *boundary* error when it lies within `boundary_ms` (default 2000, settable) of either edge of the reference interval that contains it; otherwise *interior*. An episode is `boundary` when every one of its frames is, otherwise `interior`. Per-axis totals count frames of each kind. The user said abrupt changes are normal at transitions and a reason for suspicion elsewhere, which is why they are separated. **(my call: the rule for the episode kind)** |
| Switching delay | For every pair of touching reference intervals of the axis with different labels (`A.end_ms == B.start_ms`), the lag is the time from `B.start_ms` to the first evaluated processed frame inside B whose prediction equals B's label; `null` ("never switched") when there is none or B's label is not a model class. Reported as the list, the median of the non-null lags and the count of nulls. |
| Switches versus transitions | `model_switches` = number of adjacent evaluated frame pairs (no gap between them) whose predictions differ; `reference_transitions` = number of touching different-label interval pairs; `excess_switches = model_switches - reference_transitions` (may be negative). |
| Confident errors | Each episode carries its mean and max top-1 confidence. The API does not sort for the user: the list is in time order; the screen offers "longest first" and "most confident first". |
| Compromised reference | Scores are returned with `reference_status`; the screen shows a note that they are optimistic when it is `compromised`. |
| Errors | 404 unknown run; 409 with a plain reason when the run is not a finished classification run or its video has no reference intervals. An axis with no matching reference axis is returned with `matched: false` and empty numbers, not an error. |

## Response shape

```json
{
  "run_id": 168, "video_id": 3051, "reference_status": "clean",
  "boundary_ms": 2000,
  "axes": [
    {
      "name": "Anatomy", "matched": true,
      "reference_category_id": 110, "reference_axis_name": "Anatomy",
      "frames_total": 847, "frames_evaluated": 300, "frames_excluded": 547,
      "accuracy": 0.82, "macro_f1": 0.7,
      "classes": [{"name": "caecum", "support": 120, "tp": 100, "fp": 5, "fn": 20,
                   "precision": 0.95, "recall": 0.83, "f1": 0.89}],
      "confusion": {"labels": ["caecum", "colon_left"], "matrix": [[100, 20], [5, 175]]},
      "errors": {"boundary_frames": 40, "interior_frames": 14},
      "transitions": {"reference": 2, "model_switches": 5, "excess_switches": 3,
                      "median_lag_ms": 800, "never_switched": 0,
                      "lags": [{"at_ms": 13855, "from": "caecum", "to": "colon_left", "lag_ms": 800}]},
      "episodes": [{"start_ms": 14000, "end_ms": 15200, "frames": 30,
                    "truth": "colon_left", "predicted": "colon_right",
                    "kind": "boundary", "mean_confidence": 0.71, "max_confidence": 0.93}]
    }
  ]
}
```

Rows of `confusion.matrix` are truth classes, columns are predicted classes, in
the order of `labels`.

## Backend

- New `backend/app/reference/evaluation.py`: pure functions over plain data
  (a processed-frame list per axis with timestamp, predicted class name and
  confidence; the reference intervals of the matched axis with label names), so
  they are unit-testable without a database: `evaluate_axis(frames, intervals,
  boundary_ms) -> AxisEvaluation`. Frames are sorted by timestamp; the interval
  containing a timestamp is found with `bisect`, so the cost is O(frames x log
  intervals).
- `backend/app/reference/service.py`: `evaluate_run(session, storage, run_id,
  boundary_ms) -> EvaluationRead` loads the run, checks it is a succeeded
  classification run, loads the video's reference (`get_reference`), downloads and
  parses the predictions document, matches each model axis to a reference axis
  (`match_axes`, a Python port of the frontend `matchAxes` with the same tie
  rule), and calls `evaluate_axis` per axis.
- Router: `GET /reference/runs/{run_id}/evaluation` with `boundary_ms` query
  (`0 <= boundary_ms <= 60000`, default 2000; 422 otherwise).
- After any schema or route change regenerate `openapi.json` (see CLAUDE.md).

## Frontend

- `entities/useEvaluation.ts`: `useEvaluation(runId, boundaryMs, enabled)`,
  query key `["evaluation", runId, boundaryMs]`; refetched when the reference of
  the video changes (invalidate `["evaluation"]` from the reference mutations'
  settle) so editing the reference updates the scores.
- `features/qc/classification/EvaluationPanel.tsx` in the run page's right
  sidebar, under the blip window: an axis selector, the summary (accuracy, macro
  F1, evaluated and excluded frame counts, boundary/interior error counts, switch
  and lag figures), the per-class table, the confusion matrix, the boundary
  tolerance input, a note when the reference is compromised or the axis is
  unmatched, and the episode list (time, truth to predicted, length, mean
  confidence, kind) with sort buttons "longest first" and "most confident first";
  clicking an episode pauses and seeks to its start. Pure helpers (sorting,
  formatting, hatching spans) in their own tested files.
- Red hatching: `AxisLanes` gets an optional per-axis `errorSpans` (the episodes'
  `start_ms` to `end_ms` plus one processed-frame step) and draws a red hatched
  overlay on the model lane at those spans; the playhead and the existing blip
  ticks stay on top. The overlay is memoised with the lane segments so a playhead
  tick does not recompute it.
- Nothing is shown (and no request is made) while the video has no reference
  intervals; the panel then says "Label this video's reference to score the
  model" with the existing "Label reference" link.
- All UI copy in English; dark theme only.

## Testing

Test-first, per CLAUDE.md.

- `evaluation.py` unit tests with hand-computed numbers: a tiny run where every
  count, precision, recall, F1, the confusion matrix, the episodes, the
  boundary/interior split, the lags and the switch counts are checked against
  values worked out by hand; a truth class absent from the model's classes; a
  model class absent from the truth; a frame in a gap (excluded, and it breaks
  an episode); an empty axis; a frame exactly at `end_ms` (excluded, the end is
  exclusive); touching versus non-touching intervals for the transitions; a lag
  that is `null`; zero denominators give `null`; `boundary_ms=0`.
- Service and API tests (isolated DB, a fake storage object like the compare
  tests): run states (not found, not finished, a detection run, no reference),
  a matched and an unmatched axis, orphaned intervals ignored, the compromised
  status passed through, the `boundary_ms` bounds.
- A performance test: 50,000 processed frames and 300 intervals are scored in
  under one second.
- Frontend: sorting and formatting helpers, the panel with a mocked hook (all
  sections, both sort modes, seek on click, the unmatched/compromised/no-reference
  states), the hatching spans, and `AxisLanes` rendering the overlay without
  recomputing segments on a playhead tick.
- Before the work is called done: in a real browser, label a short real video,
  run the classifier on it, and compare every number on the panel with a
  hand count for a few frames; check that editing the reference refreshes the
  scores and that the red hatching sits on the frames where the lanes differ.
  Clean up every row, run and object created.

## Open items for the plan

- Whether `match_axes` should live next to the frontend's `matchAxes` as a
  shared fixture of cases (the two implementations must agree) or only be
  tested on its own; recommended: a small shared JSON of cases both tests read.
- Where exactly the panel sits relative to the blip window in the sidebar and
  how the sidebar scrolls with the confusion matrix on a tall class list.
- Whether to cap the episode list sent to the client (hundreds of episodes on
  a very noisy model); recommended: send all, the panel virtualises or caps the
  display at a few hundred rows with a "show more".
