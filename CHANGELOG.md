# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (while below 1.0, a minor bump may
include breaking changes). Phase-by-phase decisions and deviations live in
[ROADMAP.md](ROADMAP.md).

## [Unreleased]

### Added
- Model versions record the class names they were trained on (`class_names`,
  ordered by class id) and ship a `classes.json` next to the weights, served
  through the existing artifact download. Versions trained earlier have an
  empty list; their checkpoint still carries the names.

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

[0.2.0]: https://github.com/HukumaBob/clinotate/releases/tag/v0.2.0
