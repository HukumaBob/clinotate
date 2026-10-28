# DINOv3 histology classifier: second-stage training adapter

Date: 2026-10-28
Status: draft, awaiting approval

Adds the platform's second training adapter. Builds on
[2026-08-19-train-screen-design.md](2026-08-19-train-screen-design.md),
[2026-10-08-training-base-models-design.md](2026-10-08-training-base-models-design.md)
and [2026-10-08-train-workspace-design.md](2026-10-08-train-workspace-design.md);
the Train screen layout approved there is unchanged.

Decisions marked **(my call)** were made by the author, not the user, and are
open to challenge. Everything else was stated by the user.

## Why

YOLO is fast and finds *that* there is a polyp. It is not the right tool for
*what kind* of polyp, which is decided by fine surface structure (pit and
vascular pattern). The intended pipeline is two stages:

1. YOLO detects (or segments) the polyp. Already built.
2. A DINOv3-based classifier looks at the cut-out region and names the
   histological type (adenoma, hyperplastic, ...). **This document.**

The labels are histology, i.e. the gold standard, not an endoscopist's guess.

## Scope

In v1:

- A `dinov3_classifier` training adapter behind the existing `TrainingAdapter`
  protocol, trained on the dataset's region annotations (box or mask) cropped
  to the region.
- The full set of histological types present in the taxonomy, not a binary
  adenoma / non-adenoma split.
- Frozen-backbone training and partial fine-tuning.
- Class-imbalance handling and metrics that are honest under imbalance.
- Backend catalog and settings schema, Train screen family, tests, ROADMAP entry.

## Non-goals

- RT-DETR / RF-DETR. Dropped: its only reason to exist was the YOLO licence,
  which does not matter here. Not part of this work.
- DINOv3 as a detection backbone. The object is already located by YOLO.
- **Chained inference** (YOLO box → crop → DINOv3 label on video / QC runs).
  Needed to use the model in practice, but it is its own sub-project with its
  own design; v1 ends with a trained, evaluated `ModelVersion` **(my call:
  split off)**.
- Per-polyp (sequence-level) aggregation of frame predictions. v1 metrics are
  per crop; see Risks.
- Training with LoRA/PEFT, a DINOv3 ViT-H/7B, multi-label output.

## Anti-goals

- Metrics that look good because of imbalance (plain accuracy) or leakage
  (frames of one procedure on both sides of the split).
- Anything that can push the 8 GB GPU into the host hard-reboot seen with SAM2.
- Hard-coding the class list or any assumption about how many examples a
  class has. The tool must behave sensibly on whatever the dataset contains.

## Constraints from the codebase

- Binary media only via `StorageService`; weights as a `ModelVersion`.
- Every label reference carries `taxonomy_version`; class names are recorded on
  the model version and shipped as `classes.json` (as done in `70b0b55`).
- Dataset splits are already assigned per *grouping unit* (video, else
  sequence). The adapter **uses the export's splits as given and never
  re-splits**.
- GPU: RTX 2070, 8 GB, no bf16 (fp16 autocast + GradScaler). torch is pinned
  to 2.7.1 / torchvision 0.22.1 in the ml-worker image.
- Committed text is English only.
- Tests never touch the real `endoscopy` DB; no dev servers or ports are
  stopped without asking.

## Design

### Input: crops are made by the adapter, not by a new export format **(my call)**

The existing dataset export already writes `annotations.json` (COCO, with
`bbox` and polygon `segmentation` per region) and the full-frame images.
That is enough to cut crops, so no new export format and no new `TaskType`.

The adapter accepts datasets of task type **detection** (box crops) or
**segmentation** (mask crops) and reads `annotations.json` + `images/`. Each
region annotation becomes one training sample whose class is the region's
class. Splits come from the export. The existing classification export
(whole frame, directory per class) is not used.

*To confirm while planning (code only, no data):* that the histology label is
carried by the region annotation and flows into the COCO `category_id` for
detection / segmentation datasets. If it is instead a frame-level label, the
sample-building step changes, the rest does not.

Crop settings (exposed as settings):

| setting | meaning | default |
|---|---|---|
| `crop_margin` | extra context around the box, fraction of box size | 0.15 |
| `mask_mode` | segmentation only: `none` (box crop of the region), `zero` (background set to mean colour), `blur` | `none` |
| `imgsz` | side of the square model input, multiple of 16 | 224 |

Crop is padded to a square (not stretched) before resizing, so lesion shape is
not distorted. Box vs mask is a cheap A/B on the user's data, hence a setting.

### Model

DINOv3 backbone (ViT, patch 16) + a small classification head on
`[CLS] ⊕ mean(patch tokens)`.

- Catalog entries (verify exact names and availability at plan time): ViT-S/16,
  ViT-B/16 (default), ViT-L/16 carrying the existing "may not fit in 8 GB"
  note. Others in the family are not offered in v1.
- Loaded through Hugging Face `transformers` **(my call; adds a dependency, to
  be checked against torch 2.7.1 at plan time)**. DINOv3 weights are gated on
  the Hub: the user must accept Meta's licence and provide a token. The adapter
  fails the run with a readable message when weights cannot be fetched.
- Weights are never committed or redistributed by this repo.

### Training modes **(my call)**

- `frozen` (default): backbone frozen, features computed once per crop and
  cached, head trained on the cache. Minutes, negligible VRAM, and the honest
  baseline against which fine-tuning must justify itself. Augmentation is not
  applied in this mode (cached features); a setting `frozen_tta_flips` caches
  flipped views as extra samples.
- `partial`: unfreeze the last `unfreeze_blocks` transformer blocks with
  layer-wise learning-rate decay, AMP fp16, gradient checkpointing, small
  batch.

### Imbalance and evaluation

- `class_balance`: `none` | `weighted_loss` (inverse-frequency, capped) |
  `balanced_sampler`. Default `weighted_loss`.
- Optional label smoothing.
- Model selection and early stopping on **validation macro-F1**, not accuracy.
- Reported per epoch (`on_epoch`, trainer's own key names): train loss, val
  loss, val macro-F1, balanced accuracy, accuracy.
- `TrainingResult`: `per_class` (precision, recall, F1, support), `confusion`
  (no `background` label, this is not detection), `class_names` ordered by
  class id, `metrics` (macro-F1, balanced accuracy, accuracy, best epoch).
- Classes absent from the validation split are reported with support 0 and
  excluded from macro averages, with a line in the run log saying so. A class
  with no training samples is excluded and logged.

### Augmentation (partial mode)

Horizontal and vertical flip, small rotation, mild scale / random-resized
crop, small brightness / contrast change. Hue and saturation jitter default to
zero: colour is a diagnostic cue. No mosaic, no cut-mix.

### Weights format

One `.pt` with: backbone identifier, the trained tensors only (head, plus
unfrozen blocks in `partial` mode), preprocessing config (`imgsz`, margin,
mask mode, normalisation), and class names. The frozen backbone is re-fetched
from the Hub cache at load time, which keeps frozen-mode versions to a few
hundred KB. `classes.json` is shipped alongside, as for YOLO.

### Platform integration

- `ml-worker/app/dinov3_classifier_adapter.py`; registered next to the YOLO
  adapter. The `TrainingAdapter` protocol does not change.
- `backend/app/training/catalog.py`: second entry in `_TABLES`.
- `backend/app/training/params.py`: second settings table (groups: basic,
  crop, optimization, augmentation, system), validated like the YOLO one;
  presets for `frozen` and `partial`. Unknown keys rejected as today.
- Fine-tuning *from a ModelVersion* (existing feature): supported only for
  versions of the same adapter and the same backbone; otherwise 422.
- Train screen: a new family tab driven by the same schema. No new screen or
  interaction model.
- `openapi.json` regenerated after backend changes.

## Testing and verification

TDD. ml-worker tests via the documented `docker cp` + `docker compose exec`
workflow (host `.venv` has no torch).

- **Unit, no gated weights:** a tiny randomly initialised ViT stands in for the
  backbone. Cover: crop geometry (margin, clamping at image border, square
  padding, mask modes), sample building from COCO, splits respected and never
  re-split, class weights, macro-F1 with absent classes, classes with no
  samples, `class_names` order, checkpoint round-trip, `should_stop` honoured at
  an epoch boundary, weights-unavailable error message.
- **Backend:** catalog and settings validation for the new adapter, presets,
  422 on incompatible fine-tune parent. Tests use `db_module.SessionLocal()`.
- **Live:** one real `frozen` run on ViT-S and one on ViT-B, then one short
  `partial` run on ViT-B with conservative batch size and a watch on VRAM.
  ViT-L is not run live. The user's own dataset is used for the live run; any
  rows or MinIO prefixes the run creates are removed afterwards, sweeping every
  table.
- **ROADMAP:** new phase entry with deviations and what was actually verified.

## Risks

- **Licence.** `NOTICE` records DINOv3's licence as Meta's custom licence
  (described there as non-commercial research use, "verify current"). The user
  considers the project freeware, so this is compatible, but the current terms
  must be re-read at plan time and `NOTICE` / README updated if they changed.
- **Rare classes.** Histological types differ widely in frequency. The tool
  handles imbalance mechanically, but a class with a handful of polyps cannot
  be learned or reliably measured; metrics will show it, they will not fix it.
- **Frame-level metrics overstate certainty.** Histology is per polyp while
  samples are per frame; many near-identical frames of one polyp inflate
  support and make val scores look more stable than they are. The video-level
  split prevents leakage but not this. Sequence-level aggregation is a natural
  follow-up.
- **VRAM.** The host has hard-rebooted under GPU memory pressure. Defaults are
  conservative (fp16, small batch, gradient checkpointing for partial mode);
  large models carry a visible note and are never run live.
- **`transformers` dependency** may conflict with the pinned torch pair; checked
  first thing in the plan, before any other work.

## Left to the builder

Exact Hub model ids and processor details; the cache layout for frozen
features; default numeric values of optimizer settings and presets; the form
copy and help texts; the migration, if any is needed for per-run settings
(the existing settings JSON is expected to suffice).
