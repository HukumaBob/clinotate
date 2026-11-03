# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (while below 1.0, a minor bump may
include breaking changes). Phase-by-phase decisions and deviations live in
[ROADMAP.md](ROADMAP.md).

## [Unreleased]

### Added
- QC classification runs: a QC run can use one to six Ultralytics classification models
  (one axis each) instead of a detector. `/qc/:runId` then shows a badge per axis over the
  video, one lane per axis (segments, class time shares, change count) and blip ticks
  (a short A B A stretch), with `[` / `]` stepping through the blips. Flags, commit and
  A/B compare are refused for these runs. `InferenceRun` gains a nullable `axes` column
  (migration `b2c3d4e5f6a7`); `POST /inference/runs` accepts `classifiers`.

- QC reference labeling: a video can carry a hand-labeled reference per classification axis
  (intervals with a label, gaps allowed, no overlap), labeled with digit keys on
  `/qc/reference/:videoId` and shown above the matching model lane on the classification
  run page. A reference is marked compromised when a classification model was trained on
  frames of its video (restorable); the Dataset balance panel and the Train form warn about
  it. New tables `reference_intervals` and `video_references` (migration `c3d4e5f6a7b8`),
  API under `/reference`. A video with intervals cannot be deleted, and deleting a label
  used by a reference is refused with the videos named.

- QC reference evaluation: the classification run page scores each model axis against the
  video's hand-labeled reference over the labeled intervals only: accuracy, per-class
  precision/recall/F1, macro F1, a confusion matrix, error episodes (hatched red on the model
  lane, listed with sort and click-to-seek), boundary versus interior errors with an
  adjustable tolerance (default 2 s), switching delay and model switches versus reference
  transitions. New endpoint `GET /reference/runs/{run_id}/evaluation`; computed per request,
  nothing is stored and there is no migration.

- QC error dataset: on the classification run page, error episodes can be ticked (Select
  all/none per axis, quick filters for interior errors, minimum length and minimum mean
  confidence) and sent to training. "Send to training…" opens a dialog with a live preview and
  creates one new sequence of the QC video, with frames sampled around the episodes and
  classification annotations taken from the video's reference. New endpoint
  `POST /reference/runs/{run_id}/commit-episodes` (a dry run returns the counts and writes
  nothing; at most 500 frames per commit); no migration.

## [0.3.1] - 2026-11-03

### Fixed
- A failed dataset export now says why in the Datasets table (what is wrong, on which frame
  and annotation) instead of only "N findings; export aborted", and links to the frame's
  editor (`/sequences/<id>?frame=<frame id>`).
- SAM2/SAM3 no longer save empty masks: tracking skips frames where the object is gone
  (counted in the job's `empty_frames`) and a single prediction that comes back empty fails
  with a message. Empty masks made dataset exports abort as invalid.
- Tag regions skips mask sources whose mask is empty and reports how many.

### Changed
- DINOv3 crop classifier: with fewer than 50 validation regions the best epoch and early
  stopping follow val loss instead of macro-F1 (one flipped prediction moved F1 by
  several points and froze a barely trained epoch as "best"); the held-out test split,
  when the dataset has one, is now scored with the selected epoch (`test/*` metrics).
- Tag regions panel reads as copy-from / copy-to: classification pickers for source and
  target, same-classification targets disabled, plain-language outcomes.
- Sequence grid Select toolbar regrouped (selection summary, Classify / Regions /
  Analyze sequence / Delete); Rank Quality and Find Similar take labelled parameters in
  popovers; disabled actions explain why.
- Dataset screen: table headers stay in view while scrolling.

## [0.3.0] - 2026-11-01

### Added
- Tag regions: copy the boxes or masks of selected frames into a second annotation with
  a different label (for second-stage classifier training), with a preview, an undo
  (Remove copies) and Select all / Deselect all in the sequence grid. Sources and
  targets can be narrowed by classification; same-classification copies are refused.
  Browser-checked; see ROADMAP.md.
- Model versions record the class names they were trained on (`class_names`,
  ordered by class id) and ship a `classes.json` next to the weights, served
  through the existing artifact download. Versions trained earlier have an
  empty list; their checkpoint still carries the names.
- DINOv3 crop classifier as a second training adapter (`dinov3_classifier`): cuts
  box or mask regions out of an exported detection/segmentation dataset and
  classifies them with a DINOv3 backbone (frozen features or last-blocks
  fine-tuning), with class-imbalance handling and macro-F1 model selection.
  The Train form has a `Model family` select. Not yet verified end to end on a
  real dataset; see ROADMAP.md.

### Changed
- QC inference lists only models trained with Ultralytics; the backend refuses others.
- `NOTICE` now summarises the DINOv3 licence cautiously and points at the licence text.

## [0.2.0] - 2026-10-28

First public release.

### Added
- Media library: video upload, transcoding, sequences of frames, standalone frames.
- Taxonomy (categories, labels, evaluation types) with `taxonomy_version` tracking.
- Frame editor with manual classification, mask and box annotation.
- SAM 2.1 and SAM 3 assisted segmentation: point/box prompts and bidirectional
  tracking through adjacent frames, run in a separate GPU worker.
- Mask post-processing, Rank Quality and Find Similar in the sequence grid.
- Datasets: balance panel, YOLO and COCO export for classification, detection
  and segmentation.
- Training on Ultralytics YOLO11 (n/s/m/l/x) with fine-tuning from a previous
  model version, trainer-agnostic metrics, run history and run comparison.
- QC screen: inference runs, inspection, flagging false positives/negatives
  back to training, A/B comparison, stress tests, review reels.
- Apache 2.0 license, README, CONTRIBUTING.

### Known issues
- 16 backend tests fail on `master` (see ROADMAP.md).
- YOLO11 `l`/`x` models have not been run end-to-end.
- No CI yet.

[0.3.1]: https://github.com/HukumaBob/clinotate/releases/tag/v0.3.1
[0.3.0]: https://github.com/HukumaBob/clinotate/releases/tag/v0.3.0
[0.2.0]: https://github.com/HukumaBob/clinotate/releases/tag/v0.2.0
