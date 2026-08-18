# Dataset export: YOLO and COCO

Date: 2026-08-18
Status: approved

Completes the `datasets` module begun in
[2026-08-15-dataset-screen-design.md](2026-08-15-dataset-screen-design.md),
which deliberately deferred export until class counting could be trusted.
The balance panel now reports honest figures, so writing files can rest on
them.

## Problem

A saved `Dataset` records which frames belong to it, how they split, which
grouping and limits applied — and nothing can be trained on it. There is no
way to get the data out.

Two constraints shape the answer, and both came from the user:

**The corpus will be large.** Today's 1109 frames at 17 MB are a teaching
set. Real datasets will run to gigabytes — 200,000 frames is roughly 3 GB of
images plus one MinIO read and one PNG decode per mask. Anything that holds
an archive in memory, or blocks an HTTP request, is designed for the wrong
scale.

**The dataset must outlive our tooling.** It should be usable in other
annotation tools and trainable by something other than YOLO.

## Geometry has to be derived, not read

`Annotation.payload` for a MASK holds the SAM *prompt* — a base64 PNG and
click coordinates — not the resulting shape. The mask itself is a raster in
object storage under `storage_key`. Verified across the corpus: all 55 MASK
rows carry both a `storage_key` and a prompt payload; none carries a bbox or
polygon.

So every label file is derived by reading the mask raster and extracting
contours with OpenCV, which `annotation/mask_postprocess.py` already uses —
no new dependency. Extraction happens **once per annotation**, and both
serializers consume the same result. The dominant cost of an export is these
reads, and it does not shrink when images are left out of the archive.

## Archive contents

```
dataset-<name>-<id>.zip
├── data.yaml                    # YOLO entry point
├── annotations.json             # COCO, plus provenance
├── images/<split>/...           # only when include_images is set
└── labels/<split>/*.txt         # detection and segmentation only
```

**Both formats, from one extraction.** YOLO because Ultralytics consumes it
directly; COCO because it is the de-facto interchange format — CVAT, Label
Studio, Roboflow, Detectron2, MMDetection and torchvision all read it, and it
carries polygons and boxes natively. The second format is nearly free once
contours exist; only serialization differs.

**Images are optional, included by default.** `include_images` defaults to
true, because a self-contained archive is the point of exporting. Turning it
off leaves the labels, `data.yaml` and `annotations.json`, with each COCO
image entry carrying its `storage_key` so the pixels can be fetched later.

### Label format follows `task_type`

`task_type` already decides which annotations enter a dataset (by
`annotation_scope`); it now also decides the label format, since it would be
strange for it to govern composition but not output.

- **detection** — `labels/<split>/<frame>.txt`, one line per object:
  `class cx cy w h`, normalized to the frame.
- **segmentation** — same path, one line per object:
  `class x1 y1 x2 y2 …`, normalized polygon points.
- **classification** — no `labels/` at all. Ultralytics encodes the class as
  a directory: `images/<split>/<class_name>/<frame>.png`.

### Classification cannot express two labels, so it refuses to guess

A directory-per-class layout physically cannot hold a frame in two classes.
Today no frame carries two classifications (verified: 125 `low_quality` and
28 `caecum`, zero overlap), but nothing prevents it — `Quality` and
`Landmark` are different categories and both are legitimate at once.

When a classification export meets a multi-label frame it **stops with an
error naming the frame and its labels**. It does not pick one. A silently
chosen label produces a dataset that disagrees with what the annotator sees,
and the disagreement surfaces months later.

COCO is unaffected: multi-label is natural there — several `annotations`
rows against one `image_id`, with `bbox` and `segmentation` null for
frame-level labels. The archive stays complete even where the YOLO half
demands singularity.

### File names must be made unique, or the archive loses data

Frames are stored as `frames/<sequence_id>/<index>.png`, so the basename is
only unique within a sequence. Measured on the current corpus: 1109 frames
share just **488 distinct basenames**. Writing them into one `images/<split>/`
directory by basename would silently overwrite more than half the dataset,
and the label files would then point at the wrong pixels.

Every exported file is therefore named `<sequence_id>_<index>.png`, with the
matching `.txt` using the same stem. COCO's `file_name` carries the same
value, so the two halves of the archive agree.

### Negatives

A frame flagged `no_findings_reviewed` is a confirmed-empty example. It goes
into `images/` and gets an **empty** `.txt`, which is exactly how YOLO reads
a negative. In COCO it appears under `images` and produces no `annotations`
row.

## Provenance lives in COCO

`data.yaml` has nowhere to put it, so `annotations.json`'s `info` object
carries: `taxonomy_version`, the resolved class map (each class name with the
`label_id`s it was assembled from), the applied `class_limits` and
`excluded_label_ids`, the split configuration, and the export timestamp.
`data.yaml` gets a comment pointing at it.

This makes the archive self-describing: a year later it is possible to see
what a model was trained on without our database.

## Execution: a Job, not a request

Export runs as `JobType.DATASET_EXPORT` on the existing `video_transcode`
queue.

`POST /datasets/{id}/export` takes `include_images` and returns a `Job` id
without assembling anything. The worker then:

1. reads the dataset's frozen `DatasetItem` rows — composition is already
   fixed, nothing is recomputed;
2. extracts geometry once per region annotation, keeping only the resulting
   numbers, never the rasters;
3. streams the zip to a temporary file, adding `data.yaml`,
   `annotations.json`, `labels/`, and `images/` when requested;
4. uploads it to `datasets/{id}/export-{timestamp}.zip` and records that key
   in `Job.result_ref`;
5. updates `Job.progress` as frames are processed.

**Streaming to a temp file is required, not stylistic.** Three gigabytes in a
worker's memory is a failure, not slowness. `media/service.py` already uses
`tempfile.NamedTemporaryFile` for OpenCV under the storage rule's sanctioned
exception, and this follows it.

**The queue keeps its name.** `video_transcode` is historically named but is
in practice the CPU-task queue, and export is CPU-only. Renaming would
require changing CLAUDE.md, the documented start command, and a running
worker simultaneously — and a queue-name mismatch is this project's known
cause of silently dropped messages.

**No archive field on `Dataset`.** Exports are repeatable and go stale;
`Job.result_ref` already names one. A `Dataset.storage_key` would assert
there is exactly one export and that it is current, and neither is true.

## Quality control during export

Defects will appear as the corpus grows. SAM can return a mask of a few
pixels from a bad prompt, and such an annotation is noise a detector learns
false positives from.

### The threshold is a fraction, and it is configurable

`PlatformSettings` gains `min_mask_area_fraction`, default `0.0005` (0.05% of
the frame), edited on the existing Settings page beside
`mask_postprocess_strength`.

A fraction rather than a pixel count because frames range from 244×236 to
1920×1072 — a 37× spread in area — so a fixed pixel threshold would mean
wildly different strictness per frame.

### One pass reports every problem, rather than stopping at the first

Export walks the whole dataset accumulating findings, then decides. Fixing
defects one at a time, re-running a multi-gigabyte export after each, is
untenable — and gigabyte datasets are exactly where defects will appear.

**Errors stop the export**, because the data is broken and any automatic
choice would be a guess:
- a mask file missing from storage while `storage_key` is set;
- a multi-label frame in a classification dataset.

**Warnings are filtered and the export continues:**
- a mask below `min_mask_area_fraction`. It is dropped from the labels; the
  frame stays if it has other valid annotations. If it was the only one, the
  frame leaves the dataset and does **not** become a negative — discarding a
  noisy mask is not a claim that the frame is empty, the same rule exclusions
  already follow.

The findings are recorded on the `Job` as structured data — type, `frame_id`,
`annotation_id`, and the measured fraction for filtered masks — so a failed
export lists everything wrong at once and a successful one reports what was
filtered. The user fixes in one batch and re-runs.

**Where they go, specifically.** `Job.error` is a `String(2000)` and cannot
hold a list; truncating a findings report into it would defeat the point of
collecting them all. They go into `Job.payload` — already JSON, already
carrying the job's inputs — under a `findings` key, alongside the
`include_images` flag the request supplied. `Job.error` keeps its existing
role: a short human-readable summary such as `"12 findings; export aborted"`,
with the detail in `payload["findings"]`. No new column, no migration for
this part.

### Export never repairs annotations

An export that quietly corrected a mask would produce a dataset diverging
from what the annotation UI shows. That is the same defect class already
fixed three times on this screen: a panel silently excluding a class, a limit
silently collapsing one, a checkbox disagreeing with its field. The report
gives the same practical outcome — fix everything in one pass — while the
decision stays with the user.

## Scope

**Not included:** training (the Train screen), browsing an archive in the UI,
deleting old exports, and incremental export. The last is worth naming: every
export rebuilds from scratch. At gigabyte scale that is noticeable, but the
alternative — versioned archives and deltas — is its own subsystem, and
building it before the pain is real would be guessing.

## Testing

TDD per repository rule: a failing test precedes implementation.

- Geometry: a rectangular mask yields the expected bbox; a mask with a hole
  yields the correct outer contour; an all-zero mask raises rather than
  silently emitting an empty shape.
- Serializers: coordinates normalized into `[0,1]`; a negative frame yields
  an empty `.txt` and no COCO annotation; the class indices in `data.yaml`
  match those written in the label files — a mismatch here trains the model
  on the wrong class.
- Classification: a multi-label frame stops the export with a message naming
  the frame and both labels.
- Naming: two frames from different sequences that share an index produce two
  distinct archive entries, and each label file matches its own image. This is
  the collision that would otherwise destroy more than half of the current
  corpus.
- Filtering: a mask below the threshold is dropped and reported; a frame
  whose only annotation was filtered leaves the dataset and is not turned
  into a negative; the threshold is read from `PlatformSettings`, not
  hardcoded.
- Provenance: `annotations.json` carries `taxonomy_version`, the class map
  with source `label_id`s, and the applied limits and exclusions.
- Scale: exporting a thousand synthetic frames does not grow memory linearly
  — the guard against the streaming design silently regressing to
  build-in-memory.
- Real archive: download, unzip, and confirm `annotations.json` is accepted
  by an external COCO reader and the YOLO tree matches the layout Ultralytics
  expects. COCO has never been written in this project, so schema conformance
  is verified against a real consumer, not our own assumptions.
