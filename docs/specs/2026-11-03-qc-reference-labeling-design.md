# QC screen: reference labeling, sub-project 2 of 4

Date: 2026-11-03. Status: implemented on master 2026-11-03 and live-checked (see ROADMAP). Builds on
[QC classification](2026-11-03-qc-classification-design.md) (sub-project 1,
done) and the existing frame-level classification taxonomy
([sequence grid classification](../superpowers/specs/2026-08-13-sequence-grid-frame-classification-design.md)).

Decisions marked **(my call)** were made by the author, not the user, and are
open to challenge. Everything else was stated by the user.

## Why

The user wants QC to judge frame classifiers against a hand-labeled
reference and to turn the errors into training data. A reference is a few
control videos labeled by the user **before** any model runs on them, so the
model's accuracy can be measured independently. This sub-project builds the
reference itself: where it is stored, how it is labeled in the QC window, and
whether a video can still be trusted as an unbiased test.

Sub-projects after this one (not in this document): 3 evaluation against the
reference (precision/recall, confusion matrix, error episodes, paired lanes
with red hatching), 4 a dataset built from the error episodes.

## Goals

- Label a video's frame classes as **intervals** on one lane per axis, with
  the keyboard and the mouse, fast enough for videos of many minutes.
- The reference belongs to the **video**, not to a run: every QC run on that
  video shows the same reference.
- Label a video **before any model has run** on it (a page of its own), and
  also edit the reference on the run page, above the model's lanes.
- Gray zones: stretches with no label are first-class. They are excluded from
  later metrics and from training.
- Track whether a reference video is still an unbiased test: *clean* until
  frames of the video are used to train, *compromised* after. The status is set
  automatically and the user is warned before it happens.

## Non-goals

- Metrics, confusion matrices, paired-lane mismatch hatching (sub-project 3).
- Turning intervals into `Frame`/`Annotation` rows or datasets (sub-project 4).
- Undo/redo, multi-user conflict resolution (last write wins), importing a
  reference from existing frame annotations, per-class custom hotkeys
  (digits by order only, chosen by the user).
- Boxes, masks or anything region-based. A reference interval is a frame-level
  class over a time span.

## Anti-goals

- A status that silently lies. A reference must never read *clean* once frames
  of its video went into a training run.
- Losing labeling work. A closed browser tab or a failed request must not leave
  the user believing an interval was saved.
- Making the Dataset or Train screens refuse anything. Warn, never block (the
  existing decision for QC-origin sequences).

## Decisions

| Question | Decision |
|---|---|
| What an axis is | A taxonomy `Category` of the **video's procedure** that has labels of evaluation type `frame_classification` (for colonoscopy: Anatomy and Quality). `outside_the_body` now lives in Anatomy, so a class belongs to exactly one axis. |
| Unit of storage | Time spans in milliseconds on the video, `[start_ms, end_ms)`, one label each. Not frame indices: frame rates vary and later sub-projects compare against processed frames by timestamp. **(my call)** |
| One label per axis per instant | Intervals of one axis never overlap (enforced by the service, not a DB constraint, as for classification annotations). Gaps are allowed and mean "no reference here". |
| Keys | Digits `1`..`9`, `0` assigned to classes in one running sequence over all axes, axes ordered by category id and classes inside an axis by label id (stable until the taxonomy gains a class). Classes beyond the tenth have no key and are started by clicking their chip in the legend. A key therefore identifies both axis and class. **(my call: ordering rule and the click fallback; EGDS has more than ten classes and will need the fallback)** |
| Where it is labeled | A page of its own for a video without a model, `/qc/reference/:videoId`, and the reference lanes on the classification run page (`/qc/:runId`), shown above the model's lane of each axis. |
| Saving | Every change is saved to the server at once. The UI marks a lane "saving" and "not saved" on failure and rolls the change back. No Save button. **(my call)** |
| Compromise | Set automatically when a `TrainingRun` of task type **classification** is created on a dataset that contains frames of a video that has a reference. Runs of other task types (detection, segmentation, including the DINOv3 crop classifier, which trains on region datasets) do not count: the reference holds frame-level class labels and those runs neither see nor learn them. Reaching `running` or `succeeded` is not required: creating the run is the commitment. The status can be restored to clean by an explicit, confirmed action (for a run that was never meaningful); any authenticated user may do it, since roles are stored but enforced nowhere in this repo. **(my call: classification-only, and restore open to any user)** |
| Time base | `start_ms`/`end_ms` are positions on the video the QC player plays (`stream_url`), the same timeline QC inference timestamps already use (`POS_MSEC` of the stored file). The upper bound is `round(videos.duration_seconds * 1000)`. A transcode replaces the stored file; re-encoding keeps the timeline, and this sub-project does not defend against a transcode that changes it. |
| Taxonomy drift | The taxonomy can change under a reference (labels can be edited, including their category). Intervals keep the `category_id`, `label_id` and `taxonomy_version` they were created with. `GET` marks an interval `orphaned: true` when its label is no longer in its category or the category is no longer an axis of the video's procedure; orphaned intervals are listed in a warning and not drawn on a lane. Deleting a label that has intervals is refused with a readable 409. Changing a video's procedure while it has a reference is refused with 409. **(my call)** |
| Warnings | Non-blocking. On the Dataset balance panel (next to the existing QC-origin warning) and on the Train launch form: "These clean reference videos will become compromised: ...". |
| Deleting a video that has a reference | Refused with 409 ("Delete this video's reference first"), like the existing refusal for QC runs. A hand-made reference must not vanish with a video delete. **(my call)** |

## Data

### `reference_intervals`

| Column | Notes |
|---|---|
| `id` | |
| `video_id` | FK `videos`, `ON DELETE RESTRICT` (see the decision above) |
| `category_id` | FK `categories`; the axis. Denormalised from the label so overlap checks are one indexed query. |
| `label_id` | FK `labels` |
| `taxonomy_version` | copied from the label at creation, never re-derived (CLAUDE.md constraint) |
| `start_ms`, `end_ms` | integers, `0 <= start_ms < end_ms <= duration`; minimum length 100 ms **(my call)** |
| `created_by_id`, `created_at`, `updated_at` | |

Index on `(video_id, category_id, start_ms)`. One Alembic file; no backfill.

### `video_references`

One row per video that ever had an interval: `video_id` (PK, FK `videos`),
`compromised_at` (nullable), `compromised_by_training_run_id` (nullable plain
integer, no FK: the origin must outlive deleting the run). Created lazily with
the first interval. The status is derived:

- no intervals: `none`
- intervals and `compromised_at` null: `clean`
- `compromised_at` set: `compromised`

## API (new module `backend/app/reference/`, prefix `/reference`)

- `GET /reference/videos/{video_id}`: `{video_id, procedure_id, status,
  compromised_at, compromised_by_training_run_id, axes, intervals}` where
  `axes = [{category_id, name, classes: [{label_id, name, key}]}]` (key is the
  digit or null) and `intervals` are the stored rows. 404 for an unknown video;
  an empty `axes` for a video without a procedure or a procedure with no
  frame-classification labels (the UI says so).
- `POST /reference/videos/{video_id}/intervals`: `{label_id, start_ms, end_ms}`
  returns 201 with the interval. 422: label not a frame-classification label of
  this video's procedure, `end_ms <= start_ms`, shorter than 100 ms, outside
  `[0, duration]`. 409 when it overlaps another interval of the same axis.
- `PATCH /reference/videos/{video_id}/intervals/{id}`: any of `label_id`
  (relabel; must stay inside the same axis), `start_ms`, `end_ms`; same
  validation and 409.
- `DELETE /reference/videos/{video_id}/intervals/{id}`: 204.
- `POST /reference/videos/{video_id}/restore-clean`: clears `compromised_at`;
  409 when the video has no reference.
- `GET /reference/datasets/{dataset_id}/exposure`: the clean reference videos
  whose frames are in the dataset: `[{video_id, title, frames}]`, for the Train
  launch warning. The Dataset balance response gains the same list for the
  selected sequences (field `reference_exposure`).
- Overlap checks run in one transaction that locks the video row, so two
  simultaneous requests cannot both succeed on overlapping spans.
- Training hook: `training.service.create_training_run` calls
  `reference.service.mark_compromised(session, dataset_id, run_id)` after the
  run row exists; it sets `compromised_at` on every reference video that has
  frames in the dataset's items (through `DatasetItem.frame_id` to `Frame` to
  `Sequence.video_id`) and is a no-op for videos without a reference, already
  compromised, or when the run's task type is not classification. The
  exposure endpoint and the balance-panel list apply the same task-type rule
  (a detection or segmentation dataset reports no exposure).
- Media: deleting a video with intervals answers 409.
- After any schema or route change regenerate `openapi.json` (see CLAUDE.md).

## Labeling behavior

State on the page: the playhead time `t`, a selected interval (or none), and per
axis at most one **growing** interval.

- **A class key** `k` (axis A, class L):
  - No growing interval on A: start one at `s`, label L, where `s` is the end of
    the nearest interval of A that ends at or before `t` if it is at most 1 s
    before `t`, otherwise `t`. Its right edge follows the playhead (playing or
    scrubbing) and is saved as it moves (throttled to about once a second).
    **(my call: the 1 s snap window)**
  - A growing interval of the same class exists: close it at `t` (the second
    press finalizes).
  - A growing interval of another class exists: close it at `t` and start a new
    growing interval of L at `t` (the "next key snaps to the end of the
    previous" flow).
  - An interval is selected and nothing is growing: relabel the selected
    interval to L instead of starting a new one. **(my call)**
- **Esc** closes every growing interval at `t`. **Del** deletes the selected
  interval.
- **Mouse:** a lane segment is selectable; its two edges have handles that can
  be dragged, and dragging an edge scrubs the video so the user sees the frame.
  An edge stops at the neighbouring interval of the same axis and at the video
  bounds, and never goes below the minimum length. Dragging the right edge of a
  growing interval is the "drag while watching" flow. Neighbours are
  independent: moving an edge never moves another interval, so gaps can be
  created and kept.
- The right edge of a growing interval never passes the start of the next
  interval of its axis (it is clamped there) and never goes left of its own
  start plus the minimum length.
- **Keys while typing in a field** (blip window, names) are ignored, the same
  rule as the QC keys; `[` and `]` keep their blip-navigation meaning.
- Each lane shows the share of the video it covers ("74% labeled") and, on the
  video's page, the status badge (`none`, `clean`, `compromised`) with the
  restore action for `compromised`.
- On the run page the reference lane sits above each model lane whose axis
  matches: the model lane of an axis is matched to a reference axis by class
  names (a model class matches a reference class of the same label name). A
  model axis with no matching reference axis shows no reference lane.

## Frontend

New folder `frontend/src/features/reference/`.

- Pure, unit tested: `keymap.ts` (axes and classes to digit keys), `intervals.ts`
  (start/close/relabel/edge-move/clamp/snap/coverage over a list of intervals;
  no DOM), `matchAxes.ts` (model axis to reference axis by class names).
- `entities/useReference.ts`: hooks over `apiClient` for the reference, the
  interval mutations (with optimistic update and rollback) and restore.
- Components: `ReferenceLanes` (editable lanes with handles and the playhead),
  `ReferenceKeys` (the legend, chips are clickable), `ReferenceStatus` (badge
  plus restore), `ReferencePage` (route `/qc/reference/:videoId`: player, legend,
  lanes, status).
- `AxisLanes` from sub-project 1 receives the reference through its existing
  optional `reference` prop; the run page shows a banner when the video's
  reference is compromised.
- Entry points: a "Label reference" link on the QC page next to the video
  picker and on a video's row in the QC run history.
- Warnings: a block in the Dataset balance panel and on the Train launch form
  listing the clean reference videos that training would compromise.
- All UI copy in English; dark theme only.

## Testing

Test-first, per CLAUDE.md.

- Backend (isolated database via `import app.db as db_module`): interval
  create/patch/delete with every 422/409 rule; overlap detection including an
  interval that exactly touches its neighbour (allowed); relabel across axes
  refused; label from another procedure refused; taxonomy version copied;
  status derivation; `mark_compromised` on training run creation with and
  without reference videos in the dataset; `restore-clean`; exposure endpoint;
  video delete refused while a reference exists; two concurrent overlapping
  creates yield exactly one 201.
- Frontend pure logic: key assignment (including more than ten classes), start
  with and without snapping, same-key close, other-key close-and-start,
  relabel of a selected interval, edge clamping against neighbours and bounds,
  growing interval clamped at the next interval, coverage, axis matching by
  class names (including a model class missing from the reference).
- Frontend components: the lane renders gaps, handles drag an edge, the legend
  chip starts an interval, saving/not-saved states, rollback on a failed save.
- Before the work is called done, label a short real video in a real browser
  (keys, drag, gap, relabel), reload to see it persisted, run the model, see the
  reference above the model lane, create a training run on a scratch dataset and
  see the status flip, then clean up every row, run and object created.

## Open items for the plan

- Where the readable 409s for deleting a label with intervals and for changing
  a video's procedure live (taxonomy router `DELETE /labels/{id}`, and whatever
  Media route edits a video's procedure, if one exists); `ON DELETE RESTRICT`
  alone would surface as a raw database error.
- Checked while writing: `outside_the_body` is already in Anatomy in the dev
  taxonomy for both procedures (colonoscopy category 110, EGDS category 106).
  The duplicate label names seen in sub-project 1 are the two procedures'
  separate categories, not taxonomy versions.
- How the page keeps the growing interval's save traffic and the optimistic
  state consistent while the playhead moves every frame (throttle, last write
  wins, flush on close and on page hide).
- The exact entry-point placement on the QC page.
