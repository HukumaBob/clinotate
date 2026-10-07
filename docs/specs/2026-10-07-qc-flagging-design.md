# QC screen, sub-project 3: flagging errors and sending frames to training

Date: 2026-10-07. Status: implemented and verified in a real browser on 2026-10-07
(see [Implementation status](#implementation-status) at the end).

Extends [the inference-runs design](2026-10-06-qc-inference-runs-design.md)
(sub-project 1) and [the inspection design](2026-10-06-qc-inspection-design.md)
(sub-project 2), both implemented. Source material for the whole module is
`yolo_qc_playground_architecture.pdf` (untracked, Russian); this document
designs its third slice, "QC flagging to dataset". Module decomposition: 1
inference runs (done), 2 inspection (done), **3 flagging (this document)**,
4 A/B comparison and stress tests, 5 interpretability and export.

## Goal

While reviewing a finished run, let a person mark the frames where the model
was wrong, and send those frames into the platform's normal annotation and
dataset flow so that they can be used for retraining. This closes the loop
annotate -> train -> QC -> annotate.

## What the platform's data model dictates

Three facts about the existing code shaped every decision below.

1. **Datasets are built from sequences and frozen.** A `Dataset` freezes the
   frames and annotations of the sequences chosen on the Dataset screen
   (`DatasetItem`). There is no "add frames to an existing dataset"
   operation, so the PDF's `target_dataset_id` does not apply. The entry point
   is an ordinary `Sequence` with `Frame` rows, which the Dataset screen can
   then select like any other.
2. **Masks, not boxes, are ground truth.** `AnnotationType.BBOX` exists in the
   schema but nothing reads or writes it; detection and segmentation datasets
   derive boxes from SAM2 masks (`datasets/geometry.py`), and `Annotation.payload`
   holds the SAM prompt. A corrected box from the PDF would be dead data. The
   existing frame editor (box prompt -> SAM2 -> mask) is the way to label.
3. **Independence is grouped by video.** `grouping_key` keeps every sequence
   cut from one video on the same side of a split, so frames sent from a QC
   video cannot leak between train and validation inside a dataset.

## Decisions

| Question | Decision |
|---|---|
| What does "Commit" produce | A new `Sequence` backed by the QC video, holding the flagged frames as ordinary `Frame` rows. No annotations are created automatically. Labelling happens afterwards in the existing frame editor. |
| Who corrects the frames | The existing frame editor (box prompt -> SAM2 -> mask). QC gets no box editor. |
| Leakage of the QC video | Allowed but made visible: the sequence records its origin run, and the run view and history show how many frames of the video were already sent to training. Nothing is forbidden and no "test video" concept is introduced. |
| What a flag points at | A **processed** frame (the one whose predictions are shown). The time snaps to it. A flag is saved on the server at once as a pending flag of the run. |
| Flag kinds | `fp`: nothing real in the frame, so it is saved already marked "no findings" (a hard negative). `fn`: a real object needs labelling (missed, mis-boxed, or present next to a phantom), so it is saved unannotated and waits in the editor. No "low confidence" kind. |
| Execution | A synchronous commit endpoint, like creating a sequence today. |

Rejected: building a box editor in QC and storing `BBOX` annotations (datasets
do not read them and a box-to-mask converter would be needed); exporting only
a YOLO zip (nothing returns to the platform); a client-side queue (lost on
reload, no counters); capturing frames in the browser (the browser's decode
differs from the OpenCV decode the model and the training export use);
committing as a background job (new infrastructure for a case that does not
exist yet; the synchronous path is the same one that creates sequences).

## Data

### Table `qc_flags`

One row per processed frame of one run.

| Column | Meaning |
|---|---|
| `id`, `created_at` | as everywhere |
| `run_id` | FK to `inference_runs`, `ON DELETE CASCADE` |
| `kind` | `fp` or `fn` (enum `qcflagkind`; member names are upper case in Postgres, as for the other enums) |
| `frame_index`, `timestamp_ms` | the frame as keyed in the predictions document |
| `note` | optional, up to 500 characters |
| `created_by_id` | FK to `users` |
| `committed_at`, `frame_id` | set by Commit; `frame_id` is a FK to `frames` with `ON DELETE SET NULL` (deleting the frame in the editor leaves the flag as history) |

Unique `(run_id, frame_index)`: a frame of a run can be flagged once. While
pending its kind and note can change; flagging a frame already sent to
training answers 409 so the same frame never enters training twice.

### Column `sequences.origin_qc_run_id`

Nullable integer with **no foreign key**, deliberately: the origin must outlive
deleting the run, otherwise the contamination note would disappear together
with the history. The per-video count is derived from the video's sequences,
not from runs. `SequenceRead` exposes the field (so `openapi.json` changes).

### Migration

One Alembic file after `d3e4f5a6b7c8`: the enum `qcflagkind`, the table, the
column. `JobType` and the ml-worker are not touched (the worker never reads
flags). `Annotation`, `Dataset`, `Frame`, export and training are unchanged:
`Frame.no_findings_reviewed` already exists.

## API (prefix `/inference`)

| Method | Behaviour |
|---|---|
| `PUT /runs/{id}/flags` | Create or change a flag: `{frame_index, timestamp_ms, kind, note?}`. |
| `GET /runs/{id}/flags` | The run's flags: kind, times, note, whether sent, and the `sequence_id` of a sent one. |
| `DELETE /runs/{id}/flags/{flag_id}` | Remove a pending flag; a sent one answers 409. |
| `POST /runs/{id}/commit` | `{name?}` -> creates the sequence from all pending flags and answers 201 with `SequenceRead`. |
| `GET /videos/{video_id}/sent` | `{sequences, frames}`: how many frames of this video were already sent to training. |

`InferenceRunRead` gains `flags_pending` and `flags_committed`.

### Validating a flag without downloading the predictions

The run must be `succeeded` (else 409), and `frame_index` must be a processed
frame: `frame_index >= 0` and a multiple of the run's `frame_stride` (else 422).
A "missed object" on a frame the model never saw is therefore impossible, and
the server does not download megabytes of predictions per flag.

### What Commit does (all or nothing)

1. Locks the pending flags (`FOR UPDATE`). Two simultaneous commits cannot
   send one frame twice; the second finds none and answers 409.
2. Cuts the frames in **one pass** over the video by exact frame number
   (a sequential `grab`, the same decoder as inference, so the frame is the
   one the model saw), storing PNGs as `frames/{sequence_id}/{n}.png`. A frame
   number past the end of the video answers 422 with the list of such frames
   and nothing is created.
3. Creates the `Sequence`: `video_id` = the QC video, `procedure_id` taken from
   the video (may be null), `origin_qc_run_id` = the run, `start_time` and
   `duration` spanning the flagged frames in whole seconds, a default name
   `QC · <video title> · run #<id> · <date>` or the given one (up to 255
   characters). One `Frame` per flag in time order, its `frame_index` being the
   position in the new sequence. For `fp` the frame gets
   `no_findings_reviewed` (by the committing user, now). Each flag gets
   `committed_at` and `frame_id`.
4. On a failure after objects were uploaded, deletes those objects and rolls
   the database back.

Several commits per run are allowed: each makes a new sequence from the flags
that are pending at that moment.

Deleting a run that has pending flags is allowed and deletes them with it. A
sequence already created keeps its `origin_qc_run_id`. The existing guard that
refuses deleting a video that has sequences also covers QC sequences.

Cost and boundary: the request is synchronous, like creating a sequence, and a
pass over a very long video can take tens of seconds. The real time is
measured during verification and recorded below; a background job is the next
step only if it proves necessary. The `taxonomy_version` rule does not apply:
no annotation is created.

## Interface (`/qc/:runId`)

The layout is unchanged. Four additions.

1. **Flag a frame.** Under the strip, next to the event buttons: "False
   positive (F)" and "Missed object (N)". Pressing pauses the video and snaps
   the time to the processed frame at or before the current time, so the
   overlay shows exactly what the model saw; a short note says so ("Snapped to
   processed frame 3:22"). The same kind on a flagged frame removes the flag,
   the other kind changes it. The keys `F` and `N` match the physical keys
   (they work on a Russian layout) and are ignored while typing and with
   Ctrl/Meta/Alt, like `[` and `]`. A pure helper finds the processed frame
   for a time, next to `detectionsAt`.
2. **Marks on the strip.** Flags are drawn in red on the strip: a square for
   FP, a diamond for FN (shape, not only colour). Pending marks are filled,
   sent ones are outlined. Clicking a mark seeks to it.
3. **Panel "Flags"** in the side panel below Display. A heading with counts
   ("3 pending · 5 sent"); a list of pending flags with the time, the kind, an
   inline note field and a remove button, a click on a row seeks to it; the
   button **"Send N frames to training"**, disabled at zero. It opens a dialog
   (the pattern of the existing dialogs in `features/datasets`) with the name
   (default as above), a summary ("a FP, saved as negatives; b FN, waiting for
   annotation"), the warning "After sending, this video is no longer an unbiased
   test for future runs", Confirm and Cancel. On success: "Created sequence
   '...' · Open in editor", linking to `/sequences/{id}`. Errors (such as
   frames past the end) show in the dialog.
4. **Counts.** The page header shows, when the video already has sent frames,
   "N frames of this video were sent to training" (from
   `GET /videos/{id}/sent`). The history table gets a "Flags" column with
   "pending / sent" per run. Deleting a run with pending flags warns "N
   pending flags will be lost".

Client data: hooks `useQcFlags`, `usePutFlag`, `useDeleteFlag`,
`useCommitQcFlags`, `useVideoSent` on `apiClient` with generated types.
Operations refetch rather than update optimistically: the requests are fast and
races are fewer. Accessibility: the buttons carry `aria-keyshortcuts` and
labels, the flags are a list, the dialog has `role="dialog"`, `aria-modal` and
returns focus.

## States and errors

- A run that is not `succeeded`, or a video that is not browser-playable:
  there is no flagging UI (the page already shows the status or the transcode
  prompt).
- Predictions loading: the FP/FN buttons are disabled. The flag list loads
  separately; if it fails, the panel shows a message with a retry and the rest
  of the page works.
- A failed flag request (409 already sent, 404, network): a message next to the
  buttons; nothing changes.
- Commit errors: 409 "no pending flags" (sent from another tab) refreshes the
  list; 422 lists frames past the end; a storage failure says "Could not
  create the sequence, nothing was changed" and the pending flags remain.

## Testing

Test-first, per CLAUDE.md.

- Backend (isolated database, fixtures in the style of the inference module):
  flag creation, kind change, a frame not a multiple of the stride (422), a
  sent frame (409), 404, a run that is not `succeeded` (409); removal; Commit on
  a tiny real video generated with OpenCV (the sequence has the right
  `video_id`, procedure and `origin_qc_run_id`; one frame per flag; FP frames
  are `no_findings_reviewed`; flags get `frame_id`); a second Commit (409);
  frames past the end (422, nothing created); a storage failure on the Nth
  upload (rollback and cleanup of what was uploaded); default and custom name;
  counts on the run; `GET /videos/{id}/sent`; deleting a run keeps the
  sequence's origin.
- `extract_frames_at`: exact frames by number (the frame's content encodes its
  number), unsorted and duplicated numbers, a number past the end, an empty
  list.
- Client pure functions: the processed frame for a time (before the first,
  between, exactly on, after the last, with a stride), the F/N keys (physical
  codes, Russian layout, modifiers, typing targets), and the create/change/
  remove decision on a repeated press.
- Components and hooks: the Flags panel, the dialog, the hooks with a mocked
  `apiClient`, the history column.
- Before the work is called done, in a real browser: a run of my own on a real
  video, FP and FN flags with snapping, strip marks, Commit and the resulting
  sequence on the Sequences screen with the right frames, an FP frame shown as
  "no findings" in the editor, the second Commit refused, the video badge, and a
  measurement of Commit time on the long video. Cleanup afterwards removes the
  run, the sequence, its frames and objects; run #82 (the user's) is never
  touched.

## Edge cases

A frame at index 0; a flag on the last processed frame; the same kind pressed
twice; a note of 500 characters; several commits from one run; two tabs
committing at once; a video without a procedure; flags on a run whose model was
deleted (the run stays viewable, so flagging works); a sequence frame whose
video object was transcoded between the run and the Commit (the frame number
still addresses the stored file, see the open item).

## Out of scope

Automatic annotations from predictions; `BBOX` annotations; a box editor in QC;
a "low confidence" kind; a background-job Commit; forbidding or marking
"test" videos; adding frames to an existing dataset; bulk flagging by rule;
undoing a Commit; editing notes after sending; showing the origin on the
Sequences list (the field is exposed for it); YOLO zip export (sub-project 5);
A/B comparison and stress tests (sub-project 4).

## Open items for the implementation plan

- The time budget of Commit: closed, measured at 16.3 s on the longest video (see below).
- Which existing dialog in `features/datasets` is the right model.
- Whether `F` on a focused `<video>` is intercepted by the browser's own
  shortcuts.
- If the video was transcoded after the run, frame numbers refer to the file
  as it is now; whether that can shift frames (transcoding keeps the frame
  count and rate in practice) is checked in verification.

## Implementation status

Implemented on `master` (plan: [../plans/2026-10-07-qc-flagging.md](../plans/2026-10-07-qc-flagging.md))
and verified in a real browser on 2026-10-07.

**Commit time, measured.** On the longest video (5088 s, about 127k frames)
with two flags near the end, Commit took 16.3 s: one sequential decode pass
(`grab()` counting, no seeking) plus two PNG uploads. The decode pass
dominates; the cost is the position of the last flag, not the number of flags.
The time-budget open item is closed: synchronous Commit is acceptable for a
single user; the background-job path stays the escape hatch.

### Deviations from the design (final fix wave)

- `PATCH /media/sequences/{id}` answers 409 ("This sequence was made from QC
  flags; re-cutting it would replace the flagged frames") when it would re-cut
  a sequence with `origin_qc_run_id`. Renaming and changing the procedure stay
  allowed.
- `delete_flag` reads the flag `FOR UPDATE`, like `put_flag` and the commit, so
  a DELETE cannot race a Commit.
- Commit window: `start_time = first_ms // 1000`, `duration = max(1,
  ceil(last_ms / 1000) - start_time)`, so the window always covers the last
  flag and a single flag does not give duration 0. Extracted frames are paired
  with flags by `zip(strict=True)` and each extracted index is checked against
  its flag's frame number (a mismatch is a loud 500 with nothing changed).
  Uploaded-object cleanup runs even if the rollback itself fails. An OpenCV
  decoder error inside `extract_frames_at` is raised as `ValueError`, so the
  endpoint answers 422 instead of 500.
- `PUT .../flags` is a partial update: an omitted `note` keeps the stored note;
  an explicit `null` or `""` clears it. The UI no longer resends a cached note
  on a kind change, which removes a race that could erase a just-saved note.
- The Media screen's sequence timeline and `SequenceForm`'s crop inheritance
  ignore sequences with `origin_qc_run_id` (a QC sequence spans first to last
  flag and would otherwise cover regular sequences, block new marks, and
  replace the inherited crop with `null`).
- A commit 409 ("no pending flags", sent from another tab) now also refreshes
  the flag list; the commit dialog returns focus to its opener on close, and
  Escape/Cancel are ignored while the commit is submitting.
- The default sequence name uses the local date, not the UTC date. The
  storage-failure message reads "Could not create the sequence, nothing was
  changed".

### Verification

- Backend: flag API, model and `extract_frames_at` suites in an isolated test
  database, including the fix-wave cases above.
- Frontend: full `vitest run` and `tsc --noEmit`.
- Real browser against the real stack: flagging with `F`/`N`, panel, Commit on
  the longest video, resulting sequence on the Sequences screen, the history
  column and the delete warning.

### Not verified / known limitations

- hiDPI displays.
- Snap exactness at 29.97 fps (review M7): the worker stores
  `timestamp_ms` truncated to whole milliseconds, so seeking to exactly
  `timestamp_ms / 1000` may show the previous video frame. The overlay and the
  saved frame are still correct; seeking to `(timestampMs + 1) / 1000` is the
  cheap guard if it matters.
- Where QC sequences belong on the Media screen's timeline: they are hidden
  there for now. That is a UI decision for the UI/UX spec, not an ad hoc lane.
- SAM2 Track on a QC sequence is meaningless: its frames are seconds or
  minutes apart, not consecutive.
- Pre-existing, not introduced here: deleting a Sequence does not delete its
  MinIO frame objects.
- Deferred minors (note save racing "Remove" can resurrect a flag; a
  hand-crafted frame index past the end blocks every commit until removed;
  the run does not record the video checksum; QC frames are uncropped while
  other sequences of the same video may carry a `crop_box`).
