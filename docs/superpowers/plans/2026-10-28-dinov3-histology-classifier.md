# DINOv3 Histology Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Train a DINOv3-based classifier on region crops (box or mask) of an exported detection/segmentation dataset, as the platform's second training adapter.

**Architecture:** First make the platform adapter-aware (today the backend service, the `model_train` worker task and the Train form are hard-wired to `ultralytics_yolo`). Then add `dinov3_classifier`: crops are cut from the export's `annotations.json` + `images/`, a DINOv3 backbone + linear head is trained either on cached frozen features or with the last N blocks unfrozen, and results are reported through the existing `TrainingResult`.

**Tech Stack:** FastAPI/SQLAlchemy backend, Celery ml-worker (torch 2.7.1 / torchvision 0.22.1 pinned), Hugging Face `transformers` for DINOv3, React/Vite frontend.

**Spec:** [docs/superpowers/specs/2026-10-28-dinov3-histology-classifier-design.md](../specs/2026-10-28-dinov3-histology-classifier-design.md)

## Global Constraints

- English only in code, comments, docs, UI copy. Conversation with the user is Russian.
- Work directly on `master`; no branches or worktrees. Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Do not push or tag.
- Backend tests: `import app.db as db_module` + `db_module.SessionLocal()`, never `from app.db import SessionLocal`. Tests never write to the real `endoscopy` DB.
- ml-worker tests run in the container: `docker cp` the files, then `docker compose exec ml-worker ...` (host `.venv` has no torch; the Dockerfile does not COPY `tests/`). Code changes only deploy after an image rebuild.
- torch is pinned to `2.7.1` / `torchvision 0.22.1`; do not let a new dependency move them (the lock uses `constraint-dependencies`).
- GPU is 8 GB, no bf16: fp16 autocast + `GradScaler`. ViT-L is never run live. Dev servers/ports are not stopped without asking.
- Binary media only through `StorageService`. DINOv3 weights are fetched from the Hub (gated, `HF_TOKEN` already wired in `docker-compose.yml`) and never committed.
- The adapter uses the export's `split` per image as given and never re-splits.
- After any backend schema/route change: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`, check `git diff --stat openapi.json`. Never hand-edit `frontend/src/shared/api/generated/`.
- Metric keys are the trainer's own: `train/loss`, `val/loss`, `val/macro_f1`, `val/balanced_accuracy`, `val/accuracy`.
- Adapter name string: `dinov3_classifier`. Existing: `ultralytics_yolo`.

## Review Focus

1. Dataset with a single class, or a class that has zero validation samples → run completes, macro metrics skip absent classes, log says which.
2. Region at/over the image border, zero-area box, or degenerate polygon → crop clamps or the region is skipped with a log line; never crashes the run.
3. Dataset with no usable regions (only negatives) → run fails with a readable message, not a stack trace.
4. A DINOv3 `ModelVersion` offered to QC inference (which loads Ultralytics weights) → rejected with a readable 4xx.
5. Gated weights without access/token → run fails with a message naming the model id and the licence step.

---

## File Structure

Backend
- Modify `backend/app/training/catalog.py` — adapter-keyed tables, task-type support, backbone ids.
- Modify `backend/app/training/params.py` — second settings table + presets.
- Modify `backend/app/training/service.py`, `router.py`, `schemas.py` — `adapter` parameter, per-adapter headline, backbone recorded in run config.
- Modify `backend/app/inference/service.py` — refuse versions not trained by `ultralytics_yolo`.

ml-worker
- Create `ml-worker/app/adapters.py` — `get_training_adapter(name)` registry.
- Create `ml-worker/app/dinov3_crops.py` — samples from COCO, crop geometry. Pure, no torch.
- Create `ml-worker/app/classifier_metrics.py` — class weights, confusion, macro-F1 etc. Pure numpy.
- Create `ml-worker/app/dinov3_model.py` — backbone loading, head, checkpoint save/load.
- Create `ml-worker/app/dinov3_classifier_adapter.py` — the `TrainingAdapter`.
- Modify `ml-worker/app/tasks.py` — dispatch by `run.adapter`; `pyproject.toml`/`uv.lock`/`Dockerfile` — `transformers`.
- Tests: `ml-worker/tests/test_adapters.py`, `test_dinov3_crops.py`, `test_classifier_metrics.py`, `test_dinov3_model.py`, `test_dinov3_classifier_adapter.py`.

Frontend
- Modify `TrainPage.tsx`, `TrainConfigForm.tsx`, `runLogic.ts`, `compareLogic.ts`, `RunOverview.tsx`.

---

### Task 1: Gate — `transformers` works with the pinned torch and the gated weights are reachable

This is checked first because everything else depends on it; a failure changes the plan.

**Files:**
- Modify: `ml-worker/pyproject.toml`, `ml-worker/uv.lock`, `ml-worker/Dockerfile` (only if the install order needs it)

**Interfaces:**
- Produces: confirmed Hub model ids for ViT-S/16, ViT-B/16, ViT-L/16 and the `transformers` class used to load them (`AutoModel`), recorded in a comment block at the top of `ml-worker/app/dinov3_model.py` in Task 6.

- [ ] **Step 1: Add `transformers` to `ml-worker/pyproject.toml` dependencies; `uv lock`; confirm `git diff ml-worker/uv.lock` does not change the `torch`/`torchvision` entries.**
- [ ] **Step 2: Rebuild the image and in the container run `python -c "import transformers, torch; print(transformers.__version__, torch.__version__)"`.** Expected: torch `2.7.1+cu126`, a `transformers` version that contains DINOv3 (`from transformers import DINOv3ViTModel` imports).
- [ ] **Step 3: With the real `HF_TOKEN`, load the smallest DINOv3 ViT (search the Hub for the `facebook/dinov3-vits16-*` ids; take the pretrain, not the satellite variant) with `AutoModel.from_pretrained`, run a 1×3×224×224 fp16 forward on GPU, print `last_hidden_state.shape` and the hidden size.** If the token lacks access, stop and tell the user to accept Meta's licence for the model on the Hub; do not work around it.
- [ ] **Step 4: Re-read the current DINOv3 licence text on the model card and compare with `NOTICE` (line ~52) and README (line ~47); if the terms differ from "non-commercial research use", update both and mention it to the user.**
- [ ] **Step 5: Commit** `chore(ml-worker): add transformers for DINOv3`.

---

### Task 2: Backend — adapter-aware catalog, settings and run creation

**Files:**
- Modify: `backend/app/training/catalog.py`, `service.py`, `router.py`, `schemas.py`, `params.py` (signature only here)
- Test: `backend/tests/test_training_catalog.py`, `test_training_service.py`, `test_training_api.py`

**Interfaces:**
- Produces in `catalog.py`:
  - `YOLO_ADAPTER = "ultralytics_yolo"` (keep `ADAPTER_NAME` as an alias), `DINOV3_ADAPTER = "dinov3_classifier"`
  - `ADAPTER_TASKS: dict[str, tuple[TaskType, ...]]` — YOLO: all three task types; DINOv3: `(DETECTION, SEGMENTATION)`
  - `adapters_for(task_type: TaskType) -> list[dict]` → `[{"id", "label", "supported"}]` (label e.g. "YOLO11", "DINOv3 crop classifier")
- Produces in `service.py`: `create_training_run(..., adapter: str = YOLO_ADAPTER)`; `list_base_models(session, dataset_id, adapter=YOLO_ADAPTER)`; `get_settings_schema(session, dataset_id, adapter=YOLO_ADAPTER)`; raises `InvalidBaseModel` when the adapter does not support the dataset's task type; fine-tune parent must satisfy `parent_run.adapter == adapter`.
- Produces: `GET /training/adapters?dataset_id=N` → `list[AdapterOption]` (`id: str, label: str, supported: bool`); `adapter` query param (default `ultralytics_yolo`) on `/training/base-models` and `/training/settings-schema`; optional `adapter` field (default `ultralytics_yolo`) on `TrainingRunCreate`.
- `_headline(adapter, task_type, metrics)`: DINOv3 → `f"macro-F1 {metrics['val/macro_f1']:.3f}"`; YOLO behaviour unchanged.

- [ ] **Step 1: Write failing tests**
  - `test_adapters_for_detection_lists_both`, `test_adapters_for_classification_marks_dinov3_unsupported`
  - `test_create_run_defaults_to_yolo_adapter` (existing behaviour pinned; run.adapter == "ultralytics_yolo")
  - `test_create_run_rejects_dinov3_on_classification_dataset` → `InvalidBaseModel`
  - `test_fine_tune_parent_must_share_adapter` (YOLO parent offered to a dinov3 run → `InvalidBaseModel`)
  - API: `GET /training/adapters?dataset_id=` 200 and 404 for unknown dataset; `POST /runs` with unknown `adapter` → 422
- [ ] **Step 2: Run them; expect FAIL** (`pytest backend/tests/test_training_catalog.py backend/tests/test_training_service.py backend/tests/test_training_api.py -q`).
- [ ] **Step 3: Implement per Interfaces.** Replace each module-level `ADAPTER_NAME` use in `service.py` (lines ~106, 113, 147, 200, 205, 211, 215) with the `adapter` argument. `params._TABLES`/`catalog._TABLES` stay keyed by adapter; an adapter with no table entry returns `[]`/no settings.
- [ ] **Step 4: Run the three files plus the full `backend/tests/test_training_*.py`; expect PASS** (known pre-existing red tests are unrelated — see memory `reference_pre_existing_red_tests`).
- [ ] **Step 5: Regenerate `openapi.json`; commit** `feat(training): make the backend adapter-aware`.

---

### Task 3: Backend — refuse non-Ultralytics models in QC inference

**Files:**
- Modify: `backend/app/inference/service.py` (near line 82, after `get_model_version`)
- Test: `backend/tests/test_inference_service.py` (or the existing inference test file)

**Interfaces:**
- Consumes: `TrainingRun.adapter` via `ModelVersion.training_run_id`.
- Produces: `InvalidInferenceModel` exception (subclass the module's existing error base if one exists) mapped to HTTP 422 with message `"Model version {id} was trained by {adapter}, which QC inference cannot run"`.

- [ ] **Step 1: Failing test** `test_inference_rejects_version_from_other_adapter`: create a run with `adapter="dinov3_classifier"`, a `ModelVersion` for it, call the inference-run creation → expect `InvalidInferenceModel` (service) and 422 (API).
- [ ] **Step 2: Run; FAIL.**
- [ ] **Step 3: Implement the check.**
- [ ] **Step 4: Run inference tests; PASS.**
- [ ] **Step 5: Regenerate `openapi.json` if the route's responses changed; commit** `fix(inference): refuse model versions the Ultralytics runner cannot load`.

---

### Task 4: ml-worker — adapter registry and dispatch in `model_train`

**Files:**
- Create: `ml-worker/app/adapters.py`
- Modify: `ml-worker/app/tasks.py:806-809`
- Test: `ml-worker/tests/test_adapters.py`, existing `test_tasks_training.py`

**Interfaces:**
- Produces: `get_training_adapter(name: str) -> TrainingAdapter` — imports lazily (torch/transformers only when asked); unknown name raises `ValueError(f"Unknown training adapter {name!r}")`. Names: `"ultralytics_yolo"`, `"dinov3_classifier"` (the latter is registered in Task 8; until then the lookup raises).
- `model_train(job_id, adapter=None)`: when `adapter is None`, uses `get_training_adapter(run.adapter)`.

- [ ] **Step 1: Failing tests** `test_unknown_adapter_name_raises`, `test_yolo_name_returns_ultralytics_adapter` (patch the import), `test_model_train_dispatches_on_run_adapter` (create run with `adapter="stub"`, monkeypatch `adapters.get_training_adapter` to return a stub; assert the stub was used and the run SUCCEEDED).
- [ ] **Step 2: docker cp + exec; FAIL.**
- [ ] **Step 3: Implement; the run's `ValueError` for an unknown adapter is recorded by the existing failure path (FAILED with message).**
- [ ] **Step 4: Run `test_adapters.py` and `test_tasks_training.py` in the container; PASS.**
- [ ] **Step 5: Commit** `feat(ml-worker): choose the training adapter from the run`.

---

### Task 5: ml-worker — crop geometry and sample loading (`dinov3_crops.py`)

**Files:**
- Create: `ml-worker/app/dinov3_crops.py`
- Test: `ml-worker/tests/test_dinov3_crops.py`

**Interfaces:**
- Produces:
  - `@dataclass Sample: image_path: Path, bbox: tuple[float,float,float,float] (x,y,w,h px), polygon: list[tuple[float,float]], class_id: int, split: str`
  - `load_samples(dataset_dir: Path, on_log) -> tuple[list[Sample], list[str]]` — reads `annotations.json`; image path is `dataset_dir/"images"/image["split"]/image["file_name"]`; returns samples plus `class_names` ordered by category id (index == class id after remapping to a dense `0..n-1`; the `Sample.class_id` is the dense id). Regions with missing image file, `w<=0`/`h<=0` or fewer than 3 polygon points when `mask_mode != "none"` are skipped and counted; the count is logged once.
  - `crop_region(image: np.ndarray, sample_bbox, polygon, *, margin: float, mask_mode: str, imgsz: int) -> np.ndarray` → `imgsz×imgsz×3 uint8`. Steps: expand the box by `margin` × box size per side, clamp to the image, make the crop square by padding with the image-mean colour (not stretching), apply mask (`zero` = fill outside the polygon with mean colour, `blur` = Gaussian-blur outside), resize.

- [ ] **Step 1: Failing tests** (synthetic images, no files needed for crop tests):
  - `test_crop_is_square_and_imgsz` — wide box 100×20 → output `(224,224,3)`, no stretching (a vertical bar placed in the box keeps its aspect: bar width/height ratio preserved within 1 px after scaling).
  - `test_crop_clamps_at_image_border` — box touching the corner with `margin=0.5` doesn't raise; output size correct.
  - `test_mask_mode_zero_fills_outside_polygon` — pixels outside a triangle polygon equal the mean colour; inside unchanged.
  - `test_mask_mode_none_ignores_polygon`
  - `test_load_samples_remaps_sparse_category_ids` — categories `{3:"a", 7:"b"}` → `class_names == ["a","b"]`, ids `0/1`.
  - `test_load_samples_skips_degenerate_and_missing_and_logs_count`
  - `test_load_samples_uses_export_split` — sample.split equals the image's `split`.
  - `test_negative_images_yield_no_samples`
- [ ] **Step 2: Run in container; FAIL.**
- [ ] **Step 3: Implement with OpenCV/numpy (both already in the image).**
- [ ] **Step 4: Run; PASS.**
- [ ] **Step 5: Commit** `feat(ml-worker): crop regions out of an exported dataset`.

---

### Task 6: ml-worker — imbalance-aware metrics (`classifier_metrics.py`)

**Files:**
- Create: `ml-worker/app/classifier_metrics.py`
- Test: `ml-worker/tests/test_classifier_metrics.py`

**Interfaces:**
- Produces (numpy only):
  - `class_weights(counts: Sequence[int], cap: float = 10.0) -> np.ndarray` — inverse frequency normalised to mean 1 over classes with `count>0`, clipped to `cap`; zero-count classes get weight 0.
  - `confusion_matrix(y_true, y_pred, n_classes) -> np.ndarray[int]`
  - `summarize(cm: np.ndarray, class_names: list[str]) -> Summary` with `per_class: list[dict]` (`{"class", "precision", "recall", "f1", "support"}`), `macro_f1`, `balanced_accuracy`, `accuracy`, `absent: list[str]` (classes with support 0). Macro values average over classes with `support > 0` only. Empty `cm` (no samples) → all metrics `0.0`.
  - `to_result_confusion(cm, class_names) -> {"labels": [...], "matrix": [[int,...]]}` (no `background`).

- [ ] **Step 1: Failing tests:** `test_class_weights_inverse_frequency_and_cap`, `test_class_weights_zero_count_is_zero`, `test_macro_f1_ignores_absent_classes` (3 classes, one without support: macro over 2), `test_balanced_accuracy_differs_from_accuracy_under_imbalance` (concrete 90/10 example with exact expected values), `test_per_class_precision_recall_hand_computed`, `test_empty_confusion_gives_zeros`, `test_confusion_result_has_no_background_label`.
- [ ] **Step 2: Run; FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; PASS.**
- [ ] **Step 5: Commit** `feat(ml-worker): imbalance-aware classifier metrics`.

---

### Task 7: ml-worker — DINOv3 model wrapper and checkpoint format (`dinov3_model.py`)

**Files:**
- Create: `ml-worker/app/dinov3_model.py`
- Test: `ml-worker/tests/test_dinov3_model.py`

**Interfaces:**
- Consumes: Hub ids and loader class from Task 1 (copy them into a header comment).
- Produces:
  - `load_backbone(hub_id: str) -> torch.nn.Module` — `AutoModel.from_pretrained(hub_id)`; wraps any failure in `RuntimeError(f"Could not load {hub_id}: {exc}. DINOv3 weights are gated: accept the licence on the Hub for this model and check HF_TOKEN.")`.
  - `class CropClassifier(nn.Module)`: `__init__(self, backbone: nn.Module, n_classes: int, hidden_size: int | None = None, dropout: float = 0.0)`; `features(self, x) -> Tensor` returns `cat([cls, patch_mean], -1)` (size `2*hidden`) from `backbone(pixel_values=x).last_hidden_state`; `forward(x)` = head(features); `set_trainable(unfreeze_blocks: int)` — `0` freezes the backbone entirely, `N>0` unfreezes the last N encoder blocks plus the final norm; returns the list of trainable parameter names.
  - `save_checkpoint(path: Path, model: CropClassifier, *, backbone_id: str, class_names: list[str], preprocess: dict) -> None` — saves only parameters with `requires_grad` plus the head, with keys `backbone_id`, `class_names`, `preprocess`, `trained_state`.
  - `load_trained_state(model: CropClassifier, path: Path) -> dict` — loads `trained_state` with `strict=False` on the backbone part, returns the checkpoint metadata.
  - `IMAGENET_MEAN`, `IMAGENET_STD` constants and `to_tensor(crop: np.ndarray) -> Tensor` (normalised CHW float).

- [ ] **Step 1: Failing tests using a tiny stand-in backbone** (a small `nn.Module` with `.last_hidden_state`-returning forward and `encoder.layer` list of 4 blocks + `layernorm`; match the real module's attribute names found in Task 1, so the real model works unchanged):
  - `test_features_concat_cls_and_patch_mean_shape`
  - `test_set_trainable_zero_freezes_backbone_only_head_trains`
  - `test_set_trainable_n_unfreezes_last_n_blocks_and_norm`
  - `test_checkpoint_roundtrip_restores_head_and_unfrozen_blocks` (outputs identical after reload into a fresh model)
  - `test_frozen_checkpoint_contains_no_backbone_tensors` (file much smaller than the backbone)
  - `test_load_backbone_failure_message_mentions_licence` (patch `AutoModel.from_pretrained` to raise)
- [ ] **Step 2: Run in container; FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; PASS.**
- [ ] **Step 5: Commit** `feat(ml-worker): DINOv3 crop classifier model and checkpoint format`.

---

### Task 8: ml-worker — the training adapter (`dinov3_classifier_adapter.py`)

**Files:**
- Create: `ml-worker/app/dinov3_classifier_adapter.py`
- Modify: `ml-worker/app/adapters.py` (register `dinov3_classifier`)
- Test: `ml-worker/tests/test_dinov3_classifier_adapter.py`

**Interfaces:**
- Consumes: Tasks 5–7. `TrainingRequest.config` keys (all produced by Task 9's schema, with these defaults): `backbone: str` (Hub id, set by the backend), `mode: "frozen"|"partial"` = `"frozen"`, `epochs` = 30, `batch` = 32, `imgsz` = 224, `crop_margin` = 0.15, `mask_mode` = `"none"`, `unfreeze_blocks` = 2, `lr` = 1e-3 (head) , `backbone_lr` = 1e-5 (unfrozen blocks, with layer-wise decay `layer_decay` = 0.75), `weight_decay` = 0.05, `class_balance` = `"weighted_loss"` (`none|weighted_loss|balanced_sampler`), `label_smoothing` = 0.0, `patience` = 10, `seed` = 0, `workers` = 4, `amp` = true, `frozen_tta_flips` = false, `dropout` = 0.0.
- `request.base_model`: a Hub id for a pretrained start, or a path to an existing `.pt` (fine-tune from a version → `load_trained_state` after building the model).
- Produces: `class Dinov3ClassifierAdapter` with `name = "dinov3_classifier"` and `train(request, on_log, on_epoch, should_stop) -> TrainingResult` as in `training_adapter.py`.

Behaviour the tests pin:
  - `frozen`: each crop is embedded once (fp16 autocast, `no_grad`), features cached in memory; head trained on the cache for `epochs`; with `frozen_tta_flips` the cache also holds the horizontally flipped view of each *train* crop. `on_epoch(e, total, {"train/loss", "val/loss", "val/macro_f1", "val/balanced_accuracy", "val/accuracy"})` each epoch.
  - `partial`: `set_trainable(unfreeze_blocks)`, gradient checkpointing enabled on the backbone, AMP with `GradScaler`, augmentation = flips, rotation ≤15°, scale 0.9–1.1, brightness/contrast ±10%, no hue/saturation change.
  - Best epoch = highest `val/macro_f1`; `weights_path` is the best checkpoint; `patience` epochs without improvement stop early; `should_stop()` is checked at each epoch end.
  - Classes with no training samples are excluded from the loss weights and logged; absent-in-val classes are logged by name.
  - No usable samples → `RuntimeError("No usable regions in the dataset: ...")`. No validation samples → `RuntimeError` telling the user the dataset has no val split.
  - Result: `metrics = {"val/macro_f1", "val/balanced_accuracy", "val/accuracy", "best_epoch"}`, `per_class`, `confusion` (no `background`), `class_names`, `artifacts = [metrics.json]`.

- [ ] **Step 1: Failing tests** with a stub backbone injected through a module-level `_load_backbone` seam (monkeypatched) and a tiny synthetic dataset directory written by a fixture (`annotations.json`, two splits, 3 classes, solid-colour images whose colour encodes the class so a frozen head can learn it):
  - `test_frozen_run_learns_separable_classes` (val macro-F1 ≥ 0.9 within 15 epochs)
  - `test_on_epoch_called_with_trainer_keys_each_epoch`
  - `test_best_checkpoint_is_the_best_val_macro_f1_epoch`
  - `test_should_stop_ends_run_at_epoch_boundary_with_weights`
  - `test_early_stopping_by_patience`
  - `test_partial_mode_updates_only_unfrozen_parameters` (frozen-block parameters bit-identical before/after)
  - `test_weighted_loss_vs_none_changes_minority_recall` (imbalanced 50/5 data; weighted recall ≥ unweighted)
  - `test_class_without_val_samples_is_logged_and_excluded_from_macro`
  - `test_no_regions_raises_readable_error`, `test_missing_val_split_raises_readable_error`
  - `test_fine_tune_from_checkpoint_path_restores_head`
  - `test_result_class_names_follow_class_id_order`, `test_confusion_has_no_background`
- [ ] **Step 2: Run in container; FAIL.**
- [ ] **Step 3: Implement.** Seed all RNGs from `seed`; AdamW; cosine LR decay over `epochs`; `balanced_sampler` = `WeightedRandomSampler` on class frequency; DataLoader workers = `workers`. Log one line per epoch and the unfrozen parameter count.
- [ ] **Step 4: Run all new ml-worker tests plus `test_training_adapter.py`; PASS.**
- [ ] **Step 5: Commit** `feat(ml-worker): DINOv3 crop-classifier training adapter`.

---

### Task 9: Backend — DINOv3 catalog and settings schema

**Files:**
- Modify: `backend/app/training/catalog.py`, `params.py`, `service.py` (record backbone)
- Test: `backend/tests/test_training_catalog.py`, `test_training_params.py`, `test_training_service.py`

**Interfaces:**
- Consumes: the Hub ids confirmed in Task 1.
- Produces:
  - `catalog.pretrained_models(DINOV3_ADAPTER, task_type)` → ViT-S/16, ViT-B/16 (first, default), ViT-L/16 (`note=VRAM_NOTE`); `PretrainedModel.weights` holds the Hub id, `family="dinov3"`, `size` in `s|b|l`. For DETECTION and SEGMENTATION only; `[]` otherwise.
  - `params` DINOv3 table with groups basic (`mode`, `epochs`, `batch`, `imgsz` step 16, `patience`, `seed`), crop (`crop_margin` 0–1, `mask_mode` only for `TaskType.SEGMENTATION`), optimization (`lr`, `backbone_lr`, `layer_decay`, `weight_decay`, `unfreeze_blocks` 1–12, `class_balance`, `label_smoothing`, `dropout`), augmentation (`frozen_tta_flips`), system (`workers`, `amp`). Add `("crop", "Crop")` to `GROUPS`. Defaults as listed in Task 8. Help text for each field in the style of the YOLO table, including a plain sentence on why accuracy is not the model-selection metric.
  - Presets: `quick_check` (`epochs=3`, `batch=8`), `linear_probe` (`mode="frozen"`), `fine_tune_last_blocks` (`mode="partial"`, `batch=16`, `epochs=20`, `unfreeze_blocks=2`).
  - `create_training_run` for DINOv3 writes `resolved_settings["backbone"]`: the catalog Hub id for a pretrained start, or the parent run's `config["backbone"]` for a fine-tune (`InvalidBaseModel` if the parent has none). `total_epochs` still comes from `epochs`.

- [ ] **Step 1: Failing tests:** `test_dinov3_catalog_lists_s_b_l_with_vram_note_on_l`, `test_dinov3_catalog_empty_for_classification`, `test_dinov3_schema_hides_mask_mode_for_detection`, `test_dinov3_schema_shows_mask_mode_for_segmentation`, `test_dinov3_settings_reject_unknown_and_out_of_range` (e.g. `imgsz=225` → multiple-of-16 error), `test_dinov3_defaults_match_task_8_defaults` (literal dict), `test_presets_only_reference_existing_keys`, `test_dinov3_run_records_backbone_in_config`, `test_dinov3_fine_tune_inherits_parent_backbone`, `test_dinov3_fine_tune_rejects_parent_without_backbone`.
- [ ] **Step 2: Run; FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run backend training tests; PASS.** Also `test_dinov3_defaults_match_task_8_defaults` must be mirrored by a worker test asserting `Dinov3ClassifierAdapter` falls back to the same literals when a key is absent (add to Task 8's test file here, since the backend cannot import the worker).
- [ ] **Step 5: Regenerate `openapi.json`; commit** `feat(training): DINOv3 catalog and settings schema`.

---

### Task 10: Frontend — adapter selector and DINOv3 headline metrics

**Files:**
- Modify: `frontend/src/features/training/TrainPage.tsx` (data loading near lines 88–150, submit near 198), `TrainConfigForm.tsx`, `runLogic.ts`, `compareLogic.ts`, `RunOverview.tsx`
- Test: `TrainPage.test.tsx`, `TrainConfigForm.test.tsx`, `runLogic.test.ts`, `compareLogic.test.ts`, `RunOverview.test.tsx`

**Interfaces:**
- Consumes: `GET /training/adapters`, `adapter` param on `/training/base-models` and `/training/settings-schema`, `adapter` in the POST body (all via `apiClient`).
- Produces: `TrainConfigValues.adapter: string`; `TrainConfigFormProps.adapters?: Array<{id: string; label: string; supported: boolean}>` and `onAdapterChange?: (id: string) => void`.

This deviates from the 2026-08-19 spec's "tabs by family" (the shipped screen has only Runs / New tabs and no family tabs): a **Model family** `<select>` at the top of the form is used instead, inside the approved layout. Unsupported adapters are shown disabled with the reason.

- [ ] **Step 1: Failing tests**
  - `TrainPage`: loads adapters when a dataset is selected; changing the adapter refetches base models and settings schema with that adapter; the selection resets to the first supported adapter when the dataset changes to one that doesn't support it; submit body contains `adapter`.
  - `TrainConfigForm`: select lists adapters, disables unsupported ones; the base-model optgroup label reads "Pretrained (DINOv3)" for the DINOv3 adapter (derive from the first pretrained option's `family`, not a hard-coded string).
  - `runLogic`/`compareLogic`/`RunOverview`: headline falls back to `val/macro_f1` ("macro-F1") when neither `metrics/accuracy_top1` nor `metrics/mAP50(B)` exists.
- [ ] **Step 2: `npm test -- training` ; FAIL** (the `pretest` hook regenerates the API client from `openapi.json`).
- [ ] **Step 3: Implement.** Keep the request-id race guards already used in `TrainPage.tsx` for the new fetch.
- [ ] **Step 4: `npm test -- training` and `npx tsc --noEmit` for touched files; PASS** (the repo's `npm run build` was red before this work — compare against that baseline, don't chase it).
- [ ] **Step 5: Commit** `feat(frontend): choose the model family on the Train form`.

---

### Task 11: Live verification, docs, cleanup

**Files:**
- Modify: `ROADMAP.md`, `CHANGELOG.md` (Unreleased entry only; no version bump), `README.md`/`NOTICE` if Task 1 found changed licence terms

- [ ] **Step 1: Rebuild the ml-worker image; apply no migration (none is needed — `config` JSON holds the settings); run the backend and worker test suites once more.** Do not touch ports 5173/5174 or stop any dev server without asking the user.
- [ ] **Step 2: In a real browser (`manualcheck@example.com`, see memory `reference_manual_check_login_and_taxonomy_reimport`) open Train → New, pick an exported dataset, switch the family to DINOv3, confirm the base-model list, the grouped settings form, the mask-mode field appearing only for a segmentation dataset, and the disabled DINOv3 entry on a classification dataset.**
- [ ] **Step 3: Live run 1 — `frozen`, ViT-S, `quick_check` preset on a small dataset; confirm epochs stream, a `ModelVersion` appears with per-class table and a confusion matrix without a `background` row, and `classes.json` is among the artifacts.**
- [ ] **Step 4: Live run 2 — `frozen`, ViT-B, default settings. Live run 3 — `partial`, ViT-B, `batch=8`, 3 epochs, watching VRAM (the Train screen's GPU gauge / `nvidia-smi`); stop at once if usage nears 7 GB. Never run ViT-L.**
- [ ] **Step 5: Confirm a DINOv3 `ModelVersion` is rejected by QC inference with the readable 422, and that fine-tuning from it works (ViT-S, 1 epoch).**
- [ ] **Step 6: Clean up: back up to the scratchpad, then delete every `training_runs`, `model_versions`, `jobs` row and MinIO prefix (`models/<run_id>/`) these runs created, sweeping every table the project's CLAUDE.md lists; verify nothing else changed.**
- [ ] **Step 7: ROADMAP.md phase entry: what was built, deviations (adapter plumbing was a prerequisite not in the spec; family `<select>` instead of tabs; QC-inference guard), what was and was not verified live. Commit** `docs: record the DINOv3 classifier phase`.

---

## Self-review notes

- **Spec coverage:** adapter + crops (T5, T8); box/mask setting (T5, T9); frozen/partial (T7, T8); imbalance + metrics (T6, T8); weights format + `classes.json` (T7, T11); catalog/settings/presets (T9); fine-tune compatibility (T2, T9); Train screen (T10); licence + gated weights + `transformers` risk (T1); VRAM caution (T8 defaults, T11); tests/verification/ROADMAP (T11). Chained inference, sequence-level aggregation, LoRA are non-goals per the spec.
- **Spec deviations found while planning (to log in ROADMAP):** the platform was not adapter-aware (T2–T4); the Train screen has no family tabs (T10); `ModelVersion` consumers include QC inference, which needed a guard (T3).
- **Config key names** appear in T8 (consumer), T9 (schema) and are pinned by one literal-defaults test on each side because the backend cannot import the worker.
