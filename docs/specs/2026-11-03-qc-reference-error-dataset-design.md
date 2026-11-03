# QC screen: a dataset from error episodes, sub-project 4 of 4

Date: 2026-11-03. Status: draft, awaiting approval. Builds on
[QC classification](2026-11-03-qc-classification-design.md),
[reference labeling](2026-11-03-qc-reference-labeling-design.md) and
[evaluation](2026-11-03-qc-reference-evaluation-design.md), all done, and on the
existing QC flagging commit ([QC flagging](2026-10-07-qc-flagging-design.md)).

Decisions marked **(my call)** were made by the author, not the user, and are
open to challenge. Everything else was stated by the user.

## Why

The evaluation shows where a classifier is wrong and which errors it makes
confidently. The user wants those places to become training data, so that the
same mistakes are not repeated: the reference already says what the correct
label is, so no one has to label the frames again. This closes the loop of the
whole QC classification feature: run a classifier, judge it, send its mistakes
back to training.

## Goals

- From a run's evaluation, let the user tick the error episodes they want and
  send them to training in one action.
- Quick filters that set the selection for them (interior errors only, a
  minimum length, a minimum confidence), so a long list of episodes does not
  have to be ticked by hand.
- The result is one new `Sequence` of the QC video: frames cut from the episodes
  (default one frame per second, plus a margin before and after each episode),
  each with classification annotations taken from the reference, ready for the
  existing Dataset screen. No relabeling step.
- A preview (frame count, per-axis label counts) before anything is created.
- Warn, before the commit, that training on these frames will make the video's
  reference no longer an unbiased test.

## Non-goals

- Avoiding a frame that an earlier commit already sent (the platform does not
  record the source frame number of a committed frame; the dialog shows what was
  already sent from this video so the user can judge). **(my call)**
- Reviewing or editing frames and labels inside the dialog (the existing frame
  grid and editor do that afterwards).
- Committing from detection or segmentation runs (they have their own flags
  commit), or from a run without a reference.
- A background job: the commit is synchronous, like the existing flags commit,
  bounded by a frame cap.
- Creating or changing a `Dataset`. The new sequence is picked up on the Dataset
  screen like any other.

## Anti-goals

- Wrong labels in the training data. A frame is never given a label the
  reference does not contain; a frame with no reference label on any axis is not
  sent at all.
- A half-made sequence. The commit is all or nothing; uploaded frames are removed
  when the database write fails.
- Surprising the user about the reference. The compromise warning is shown before
  the commit; committing itself does not change the status (training does, as
  built in sub-project 2).

## Decisions

| Question | Decision |
|---|---|
| What is committed | A selection of **error episodes** of one classification run, identified by `(axis name, start_ms)` as the evaluation returns them. The server recomputes the evaluation itself and takes the matching episodes; it never trusts frame lists from the client. An unknown or stale key is a 422. |
| Episodes and the tolerance | An episode's identity, its frames, truth, prediction and confidences do **not** depend on the boundary tolerance; only its `kind` label (`boundary` or `interior`) does. So the request carries no tolerance, the server recomputes with any value, and a key `(axis, start_ms)` ticked under one tolerance means the same episode under another. A stale key (the reference or the run changed since the panel loaded) is a 422 and the panel reloads. |
| The filters' inputs | They use fields the evaluation already returns per episode: `kind` (*Interior only*: `kind == "interior"` under the panel's current tolerance, computed on the client), `frames` (*At least N frames*) and `mean_confidence` (*Mean confidence at least X%*). No new evaluation fields. |
| Margin frames | Margin frames carry the reference label of their own interval and are sent as ordinary labeled frames: context around the mistake, including frames the model got right. They are not "hard negatives only". **(my call)** |
| Selection UI | A checkbox per episode in the evaluation panel, "select all / none", and quick filters that **set** the selection (they do not hide rows): *Interior only*, *At least N frames*, *Mean confidence at least X%*. The footer shows "N episodes selected" and a button "Send to training…". Default: nothing selected. **(my call: default empty)** |
| Which frames | For each selected episode, sample instants on a grid anchored at the episode start, `start_ms + k*step_ms` for every integer k (negative k included) with `start_ms - margin_ms <= t <= end_ms + margin_ms` and `t >= 0` (defaults 1000 ms and 1000 ms, both settable in the dialog), so the first frame of the mistake is always sampled, and take the nearest *processed frame* of the run within half a step of each instant. Frames are therefore always frames the model actually scored, and the frame number is the one stored in the predictions. Duplicates across overlapping episodes are collapsed. **(my call: nearest processed frame within half a step)** |
| Which frames are kept | A sampled frame is kept only when at least one reference axis has a non-orphaned interval containing its timestamp (`start_ms <= ts < end_ms`). Margin frames in gaps or outside the reference are dropped. Frames of the episode itself always qualify (they were evaluated). |
| Labels | For every kept frame, one `CLASSIFICATION` annotation per reference axis that has an interval covering it (all axes of the video's reference, not only the evaluated one: the user labeled them, and it costs nothing). The label is the interval's label; `taxonomy_version` is copied from that label at this moment (CLAUDE.md constraint). One label per axis per frame is guaranteed by the reference's no-overlap rule. |
| Result | One new `Sequence` of the video (`origin_qc_run_id` = the run, name defaulting to `QC errors · <video> · run #<id> · <date>`), one `Frame` per kept frame cut in one sequential pass (`extract_frames_at`), annotations attached. Same atomicity and cleanup rules as `commit_flags`. |
| Cap | At most 500 frames per commit (422 above, with the count and the cap in the message). Lowered from 2000: every cut frame is held in memory before upload; streaming frames to storage is the proper fix. **(my call)** |
| Preview | The same request with `dry_run: true` returns the numbers and writes nothing. The dialog calls it whenever step, margin or the selection change. |
| Reference warning | The dialog states, when the reference status is `clean`, that once a classifier is trained on these frames the reference stops being an independent test (the status flips automatically at training time); when it is already `compromised` it says so plainly. It never blocks. |
| Already sent | The dialog shows the existing "frames of this video already sent to training" figure (`GET /inference/videos/{id}/sent`) so a repeat commit is a conscious choice. |

## API

New route in the reference module (it needs the evaluation and the reference):

`POST /reference/runs/{run_id}/commit-episodes`

```json
{ "episodes": [{"axis": "Anatomy", "start_ms": 14000}],
  "step_ms": 1000, "margin_ms": 1000, "name": null, "dry_run": false }
```

Response `201` (or `200` for a dry run):

```json
{ "dry_run": false, "episodes": 3, "frames": 41, "dropped_unlabeled": 6,
  "annotations_by_axis": {"Anatomy": 41, "Quality": 12},
  "sequence_id": 77, "sequence_name": "QC errors · polyposis · run #169 · 2026-11-03" }
```

(`sequence_id`/`sequence_name` are null for a dry run.)

Errors: 404 unknown run; 409 `RunNotEvaluable` reasons as the evaluation (not a
finished classification run, no reference, predictions gone), and the video
unreadable or frames past the end as in the flags commit; 422 for an empty
selection, an unknown or stale episode key, `step_ms` outside 100..60000,
`margin_ms` outside 0..60000, no frame left after dropping unlabeled ones, more
than 500 frames. After any schema or route change regenerate `openapi.json`.

## Backend

- `backend/app/reference/commit.py` (new): pure sampling `sample_frames(episodes,
  processed, step_ms, margin_ms) -> list[int]` (processed frames as
  `(frame_index, ts_ms)` sorted by time; returns frame indices, deduplicated,
  ascending) and `labels_at(ts, intervals_by_axis) -> list[(axis, interval)]`;
  `commit_episodes(session, storage, run_id, request, user)` which recomputes the
  evaluation (`evaluate_run`'s internals), selects the episodes, samples, filters
  by reference coverage, enforces the cap, cuts the frames in one pass, uploads,
  writes `Sequence`, `Frame` and `Annotation` rows in one transaction and cleans
  up uploaded objects on failure. The frame cutting, upload, rollback and cleanup
  code of `commit_flags` should be shared (extract a helper both use) rather than
  copied; the existing flags tests must keep passing. **(my call)**
- Annotation rows are created directly in the same transaction (not through
  `create_classification_annotation`, which commits per call), with
  `annotation_type=CLASSIFICATION`, `payload={}`, `taxonomy_version` from the
  label, `created_by_id` the user.
- The evaluation internals needed by both the endpoint and the commit (episodes
  with their frame lists) are exposed from `evaluation.py` /`service.py`; no new
  table, no migration.

## Frontend

- `entities/useCommitEpisodes.ts`: a mutation for the real commit and a query-like
  hook (or mutation) for the dry run; on success invalidate the sequences list and
  the video's "sent" figure.
- Pure helpers (own file, tested): `episodeKey(axis, episode)`, `filterSelection(
  episodes, filters)` for the three quick filters (they return the set of keys to
  select), `selectionSummary`.
- `EvaluationPanel` gains the checkboxes, select all/none, the filter chips and the
  footer; the selection lives in the panel and survives a tolerance change
  (episodes are keyed by axis and start, which do not depend on the tolerance) but
  is dropped when the run changes.
- `EpisodeCommitDialog.tsx`: name field, step and margin (seconds), the live preview
  from the dry run (episodes, frames, frames dropped as unlabeled, labels per
  axis), the reference warning, the already-sent note, confirm and cancel; on
  success a link "Open sequence" to the new sequence; errors shown in the dialog.
  Follow the look of the existing `CommitDialog`.
- All UI copy in English; dark theme only.

## Testing

Test-first, per CLAUDE.md.

- Pure sampling and labeling with hand-computed cases: instants and nearest
  frame selection, half-step tolerance, overlapping episodes collapsing, margins
  clipped to the video, margin frames in gaps dropped, a frame covered by two
  reference axes getting two labels, a frame covered by none dropped.
- Service and API tests (isolated DB, fake storage and a tiny real video where
  frame cutting is exercised, as the flags-commit tests do): the whole commit
  creates one sequence with the expected frames, annotations (label, copied
  `taxonomy_version`, one per axis per frame) and `origin_qc_run_id`; `dry_run`
  writes nothing and returns the same counts; the cap; an empty selection; an
  unknown or stale key; run states (404, 409 variants); atomic failure (a failure
  after upload removes the uploaded objects and leaves no rows); the flags commit
  still passes after the shared helper is extracted.
- Frontend: quick filters, the panel's checkboxes and footer, the dialog (preview
  refresh on input, warning texts for clean and compromised, success link, error),
  and that the selection survives a tolerance change.
- Before the work is called done, in a real browser: label a short real video,
  run the classifier, tick episodes, preview, commit, open the new sequence in the
  frame grid and check that the frames show the reference labels as classification
  badges; compare frame count and labels with a hand count; clean up the sequence,
  frames, annotations, objects, intervals and run created.

## Open items for the plan

- The exact sharing point with `commit_flags` (which pieces become the common
  helper), decided after reading it.
- Whether the preview should debounce typing in the step/margin fields (it should:
  the commit endpoint recomputes the evaluation, so keep requests few).
- Where the "Send to training…" footer sits in the narrow sidebar.
