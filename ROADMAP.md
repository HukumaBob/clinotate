# Roadmap

Registry of implementation phases for the Endoscopy Annotation Platform, and
a log of decisions/deviations made while executing them. This file tracks
*status and decisions*, not plan content — each phase's full task-by-task
detail lives in its own plan document (linked below).

The authoritative architectural rationale (why FastAPI/Postgres/MinIO/Celery/
MLflow, domain boundaries, what's explicitly out of scope) is the design spec:
[docs/specs/2026-07-22-new-platform-design.md](docs/specs/2026-07-22-new-platform-design.md)

The spec and phase plans live in this repo under `docs/specs/` and
`docs/plans/` — they were originally drafted in the sibling `segmentation`
project (kept there only as a source of domain knowledge from the older
Django system, not code to port) and moved here on 2026-07-22 since they
describe this codebase, not that one.

## Phases

### Phase 1: Walking skeleton — DONE (2026-07-22)

Plan: [docs/plans/2026-07-22-walking-skeleton.md](docs/plans/2026-07-22-walking-skeleton.md)

Infra, auth, taxonomy, media ingestion, and manual classification annotation
as working, end-to-end, testable software. No ML inference. 12 tasks,
subagent-driven-development, task-scoped review + one final whole-branch
review. Detailed per-task commit ranges: `.superpowers/sdd/progress.md`.

**Deviations from the plan, decided during execution:**
- CORS middleware added to `backend/app/main.py` (not in the plan's literal
  code) — required for the plan's own final e2e test to pass against a real
  browser; no earlier task's tests exercised a real cross-origin request.
- `frontend/src/features/auth/useAuth.ts` fixed to restore `isAuthenticated`
  from a stored token at store-init time — the plan's literal code always
  started unauthenticated, breaking direct navigation to a protected route
  while already logged in.
- `frontend/e2e/annotation-flow.spec.ts` extended beyond the plan's literal
  Step 3 code to cover the full register→login→upload→sequence→frame→annotate
  flow, matching the plan's own prose description of what this test should
  prove (the plan's literal code stopped at "video visible in list").
- `frontend/package.json` gained `prebuild`/`predev`/`pretest`/`pretest:e2e`
  hooks to auto-run `generate-api` — a fresh `git clone` didn't build without
  a manual step; found during the final whole-branch review.
- Two missing Vite scaffold files (`tsconfig.app.json`, `tsconfig.node.json`)
  committed after Task 10 — Task 9 referenced them from `tsconfig.json` but
  never committed them, so every prior "build succeeded" claim up to that
  point was only true in a working tree that still had the untracked files.

**Known gaps carried forward, not fixed (explicit calls, not oversights):**
- `frontend/src/features/media/VideoListPage.tsx` has no UI to create a
  `Sequence` or navigate to a video's frames — reaching `/frames/:id` from
  the UI requires an API call first (`POST /media/videos/{id}/sequences`).
  The plan never specified this UI; the e2e test proves the underlying flow
  works via direct API calls. Revisit if manual annotation workflows need a
  full click-through path.
- `NOTICE`'s third-party attribution (SAM2/YOLO/RT-DETR/DINOv2/DINOv3) says
  these are "used ... in this repository," though none are integrated yet —
  this is the plan's own literal Task 1 text. Left as-is; revisit when
  Phase 2 actually wires in an adapter.
- `playwright.config.ts` has no `webServer` block — running the e2e test
  requires `docker compose up -d` + backend + frontend already running
  manually. Acceptable for a walking skeleton; would need automation for CI.

### Phase 2a: Jobs infrastructure + SAM-3 segmentation (predict/track) — DONE (2026-07-23)

Plan: [docs/plans/2026-07-22-jobs-and-sam3.md](docs/plans/2026-07-22-jobs-and-sam3.md)

`jobs` domain (Celery + Redis, already-provisioned Redis finally gets a
consumer), a separate `ml-worker` GPU-backed project (own `uv` environment,
doesn't import `backend/app` — coupled to the API only by Celery task name),
and a real `Sam3Adapter` covering `predict()` (point/box prompts on one
frame, fully working and GPU-verified) and `track()` (mask propagation
across a sequence, code correct and source-verified against SAM-3's real
API, GPU test conditionally skipped on this hardware — see below). 10
tasks, subagent-driven-development, task-scoped review + final whole-branch
review. Capstone: a real end-to-end Playwright test proving
register→login→upload→sequence→frame→select label→click point→a real
Celery worker running real GPU inference→poll to success→a real mask
`Annotation` exists — no mocks anywhere in that path. Detailed per-task
commit ranges and full investigation narratives: `.superpowers/sdd/progress.md`
(task ledger) and `.superpowers/sdd/task-*-report.md` (per-task deep dives,
gitignored working artifacts, not committed).

**NOTICE correction made ahead of this phase (2026-07-22):** verified
directly against `facebookresearch/sam3`'s `LICENSE` file that SAM-3 is
under Meta's custom **SAM License**, not Apache 2.0 as `NOTICE` previously
(incorrectly) stated for the SAM family. The SAM License prohibits military/
weapons end use, requires export-control/trade-sanctions compliance,
prohibits reverse-engineering, and requires publication attribution; weights
are gated on Hugging Face. `NOTICE` now states this accurately, plus
confirmed RT-DETRv2 (Apache 2.0) and added RF-DETR (Apache 2.0 base package;
a separate Platform Model License covers Roboflow's larger "RF-DETR+"
weights) ahead of Phase 2b integrating them.

**Deviations from the plan, decided during execution:**
- SAM-3's real Python API differs from what the plan's own Task 7 brief
  guessed for the video predictor's request/response shape (the plan's
  guess: `{"box"/"label"}` request, a flat `response["outputs"]` list of
  `{"mask"/"score"}` dicts — entirely wrong on every count). Corrected by
  reading the installed `sam3` source directly: `add_prompt` takes
  `points`/`point_labels`/`obj_id` or `bounding_boxes`/`bounding_box_labels`;
  a separate `handle_stream_request({"type": "propagate_in_video"})`
  generator yields per-frame `out_binary_masks`/`out_probs`/`out_obj_ids`.
- A real, upstream `sam3` bug (not Turing/GPU-generation-specific, contrary
  to the first hypothesis) was found and fixed via a monkeypatch:
  `sam3.perflib.fused.addmm_act` casts to bfloat16 internally but never
  casts the result back to the caller's dtype, crashing any GPU generation.
  Fixed in `ml-worker/app/sam3_adapter.py` (`_apply_sam3_bf16_dtype_patch`,
  mirrors an unmerged upstream PR `facebookresearch/sam3#570`); `sam3`'s
  git install is pinned to the exact commit the patch was verified against
  in `ml-worker/Dockerfile`.
- `track()`'s GPU test (`test_track_propagates_prompt_across_frames`) is
  marked `@pytest.mark.skipif` on this specific dev GPU (RTX 2070, Turing,
  no Flash Attention below Ampere/compute capability 8) — a confirmed
  hardware VRAM ceiling, not a code defect. Six separate mitigation avenues
  were tried and ruled out with live-GPU evidence before accepting this
  (no feature-disabling knob exists on the video builder; fp16 downcasting
  breaks on a different, unpatched decoder dtype bug; `torch.autocast`
  doesn't reduce peak memory without a fused/tiled attention kernel;
  memory-fraction limiting and frame-count reduction don't apply since the
  OOM happens on the very first frame's backbone pass; moving the
  unconditionally-built-but-unused text encoder off-GPU frees enough memory
  but breaks correctness, since `sam3`'s base class invokes it on every
  prompt regardless of type). The skip condition checks compute capability
  at runtime, so it self-resumes on Ampere+ hardware without manual
  intervention. A SAM-2.1 lighter-weight adapter for VRAM-constrained
  hardware is being considered as separate future work, not part of this
  phase.
- A real design gap was found mid-plan (Task 8): `annotations.label_id`/
  `taxonomy_version` are NOT NULL in the real schema, but the original
  Task 1-5 job-enqueue API (`Sam3PredictRequest`/`Sam3TrackRequest`) never
  carried a `label_id` anywhere, so the worker had nothing to attach to a
  SAM-3-generated `Annotation`. Fixed by reopening the already-merged API
  (adding a required `label_id: int`, with fail-fast 404 validation before
  Job creation) — the caller now chooses which `Label` a SAM-3 mask should
  be tagged with; the worker copies `taxonomy_version` from the real `Label`
  row, following this repo's binding provenance rule exactly.
- Task 9's own brief assigned Task 10 to replace a placeholder click-surface
  `<div>` with the real frame `<img>` — this was missed in Task 10's first
  pass (caught by that task's own review) and fixed in a follow-up commit:
  added `GET /media/frames/{frame_id}` + `FrameRead.image_url` (via the
  existing `StorageService.url_for()`), and `object-contain`-aware click
  coordinate math on the frontend. That fix's own review then found two
  frontend unit tests had gone silently uninformative (still "passing," but
  for reasons unrelated to the actual new behavior) — fixed in a second
  follow-up commit, verified via a genuine red/green cycle.
- Real infrastructure bugs found and fixed during Task 10's real-GPU e2e
  run: a CUDA fork crash (Celery's default `prefork` pool forks a
  subprocess per task; CUDA can't be re-initialized in a forked child —
  fixed via `--pool=solo` in the worker's CMD), Celery tasks never being
  registered with the worker (`celery -A app.celery_app worker` only
  imports `celery_app.py` by name, never `tasks.py` — fixed via
  `from app import tasks` at the bottom of `celery_app.py`), and a missing
  `celery[redis]` transport extra in `ml-worker/pyproject.toml`.

**Known gaps carried forward, not fixed (explicit calls, not oversights):**
- `run_sam3_track` (the Celery task, as opposed to `Sam3Adapter.track()`
  itself) has no direct test coverage — Task 8's own brief only wrote tests
  for the predict path. The track path's code is a structurally identical
  mirror of the tested predict path, not novel untested logic, but this is
  a real coverage gap worth closing in a follow-up.
- `ml-worker/app/models.py` duplicates significant parts of the backend's
  schema (`Job`, `Frame`, `Annotation`, `Label`, and three enums) by
  deliberate architectural design (the two projects share no code import,
  only Celery task names and the same Postgres tables) — each duplicate is
  commented with its backend source file and, for enums, an explicit note
  that Postgres stores member *names* not values, but there is no
  automated cross-check keeping the two in sync; a future backend migration
  that renames a column or an enum member would silently break the worker
  with nothing catching it except a runtime failure.
- `Sam3Adapter.track()` only applies the first prompt in a multi-prompt
  list — the real SAM-3 video-predictor API accepts one prompt group per
  `add_prompt` call, and this adapter's only caller ever sends one prompt,
  so this hasn't been a problem in practice, but a future multi-object
  tracking feature would need `track()`'s interface revisited.
- `track()`'s `MaskResult.score` is hardcoded to `1.0` rather than a real
  per-object confidence — `out_probs`'s index alignment with
  `out_binary_masks` after SAM-3's internal object-filtering/reordering
  was not traced during implementation (risk of silently mismatching a
  mask to the wrong confidence value if guessed), so this was left as a
  documented simplification rather than a guess dressed up as done.
- `.env.example`'s `CELERY_BROKER_URL` var is unused — both `backend/app/
  celery_app.py` and `ml-worker/app/celery_app.py` derive the broker from
  `REDIS_URL` instead. Cosmetic; either wire it in or drop it from
  `.env.example`.

### Phase 2a.1: Platform-wide UI/UX design — DONE (2026-07-23)

Design-only phase, no code changed. Triggered by a request to add SAM 2.1 as
a second segmentation adapter alongside SAM-3 (see Phase 2a's own deviation
log above, "A SAM-2.1 lighter-weight adapter... is being considered as
separate future work") — that turned out to require a real annotation
workspace layout to slot the model choice into, and none existed: the
design spec's `## Frontend` section only ever specified a directory layout
(`src/features/annotation/`, etc.), never what a screen looks like or how a
user moves between screens. Rather than bolt a model-switcher onto the
current bare-bones `SegmentButton` (a single button + point-click on one
frame, no navigation, no other section implemented), the whole platform's
navigation and all six top-level screens were designed in one brainstorming
session and written up in
[docs/specs/2026-07-23-platform-ui-ux-design.md](docs/specs/2026-07-23-platform-ui-ux-design.md).

The sibling `/mnt/work-disk/Documents/Dev/segmentation` Django project (see
CLAUDE.md) was used as the domain-knowledge reference for *what workflows a
working platform needs* (its templates were read directly, not from memory)
— but several of its concrete layouts were reworked, not copied, based on
real usability objections raised during the session. Most significant
reversal: an early draft of the new design proposed a separate "Annotation"
nav section distinct from "Sequences"; this was rejected because segmenting
one frame and tracking it projects masks across the whole sequence, so
"annotated" vs "not yet annotated" isn't a stable split two different
screens could own — Sequences ended up being the single place both data
management and the annotation workflow live, same as the old platform's own
Sequences→Annotate flow, but reached independently rather than assumed from
it.

**Key decisions locked in by the spec** (see the spec itself for full
detail on each):
- Navigation: `Media → Sequences → Tags → Dataset → Train → Results`, no
  separate Annotation section.
- Media = raw file storage + "cut into frames"/"batch photos into a
  Sequence" only; it does not do annotation. `Sequence.name` is a required,
  auto-suggested (`Procedure + date + per-day ordinal`), freely-editable
  text field.
- A `Sequence`'s own screen is a full-viewport responsive frame grid (not a
  small in-card preview) with masks rendered as real colored fills plus a
  compact tag-name legend baked into each thumbnail — not an abstract
  "masked/unmasked" status.
- Clicking a frame **replaces the grid in place** with the frame editor
  (not a modal, not a separate routed page) — a deliberate rejection of the
  old platform's `frame_modal.html` pattern (explicitly called out as
  looking bad) and of a separate-page alternative (rejected as unnecessary
  navigation overhead for a very frequent action).
- The frame editor gives the image all remaining space (fixed-width tools
  panel, not a fixed ratio) and uses mouse gestures for point/box (no mode
  toggle buttons — left-click/drag/Ctrl+click, matching what the old
  platform already proved works), with an explicit Mask-mode button only
  where a gesture alone would be ambiguous.
- **SAM-3 and SAM 2.1 share one frame-editor UI**, differing only in that
  SAM 2.1 adds a Mask prompt option; SAM 2.1 is the default tab. Tracking
  is two explicit numeric Backward/Forward fields (never blank/unbounded —
  see Phase 2a's own VRAM-ceiling deviation log entry above for why an
  unbounded propagation request is a real hazard, not a hypothetical one)
  behind one "Track" button.
- Tag hierarchy is fixed at exactly two levels (parent → child via
  `LabelRelation`), matching a three-select Category→Classification→Tag
  picker used identically in both the Tags screen and the frame editor's
  label picker.
- Dataset/Train/Results screens were approved only at a rough/draft
  structural level (user's own words: "правки по ходу") — expect these
  three to be revisited during their own implementation planning, unlike
  the Sequences/frame-editor section, which was iterated to a
  detail-approved state.

**Explicitly not decided by this phase** (left for the next
brainstorming/planning pass): the SAM-3/SAM 2.1 selection mechanism at the
API/backend level (single endpoint with a `model` field vs. parallel
endpoints vs. parallel Celery task names — this was the original question
that triggered the whole detour, still open), the exact GPU-memory cap
enforced on the frame editor's Track inputs, and any backend/API contract
changes at all — this phase is UI/UX only.

### Phase 2a.2: SAM 2.1 adapter — DONE (2026-07-24)

Design: [docs/specs/2026-07-23-sam2.1-adapter-design.md](docs/specs/2026-07-23-sam2.1-adapter-design.md).
Plan: [docs/superpowers/plans/2026-07-23-sam2.1-adapter.md](docs/superpowers/plans/2026-07-23-sam2.1-adapter.md).

Adds SAM 2.1 as a second, parallel segmentation adapter alongside SAM-3
(per Phase 2a.1's UI decision that both share one frame-editor UI, SAM 2.1
adding a Mask prompt option SAM-3 doesn't have). Parallel `/jobs/sam2/predict`/
`/jobs/sam2/track` API endpoints (`JobType.SAM2_PREDICT`/`SAM2_TRACK`,
`Sam2PredictRequest`/`Sam2TrackRequest`, `enqueue_sam2_predict`/
`enqueue_sam2_track`), symmetric to the existing SAM-3 endpoints rather than
a single model-switch endpoint — resolving the open question Phase 2a.1 left
unresolved in favor of the parallel-endpoints option. `Sam2Adapter`
(`ml-worker/app/sam2_adapter.py`) implements `predict()` (point/box/mask
prompts, mask-prompt via a raw PNG the frontend sends, converted to SAM2's
mask-logit format) and `track()` (bidirectional propagation via two
sequential `propagate_in_video()` calls on one `inference_state`, per the
real confirmed sam2 API — a single call only walks one direction). Both
`sam2_predict`/`sam2_track` Celery tasks wired up in `ml-worker/app/tasks.py`,
mirroring `sam3_predict`/`sam3_track`, with cross-adapter GPU eviction: SAM-3
and SAM 2.1 tasks now each evict the *other* family's resident models before
running, since a single worker process can only fit one large model family
in this GPU's ~7.6 GiB VRAM. `NOTICE` updated to add SAM 2.1
(facebook/sam2.1-hiera-large, Apache 2.0) as a new in-use entry alongside the
existing SAM-3 entry, not replacing it.

**Deviations from the plan, decided during execution:**
- The real `sam2` package's git install has a different pip name than
  expected: `sam-2` (hyphen), not `sam2`. `--no-deps` was required on
  install because sam2's unbounded `torch>=2.5.1` constraint made the
  resolver pull an unrelated `torch==2.13.0`/CUDA-13 stack over the
  already-pinned `torch==2.7.1`. `SAM2_BUILD_CUDA=0` was required because
  the base image is `nvidia/cuda:12.6.0-*runtime*` (no `nvcc`), so sam2's
  optional CUDA post-processing extension can't build there. All three
  fixed in `ml-worker/Dockerfile`.
- The plan's own Task 9 test fixture (`test_track_skips_direction_with_zero_count`)
  used a bare `unittest.mock.MagicMock()` where a real tensor was needed
  (`MagicMock` doesn't support `__gt__` by default) — found and fixed
  during Task 9's execution, verified independently by the task reviewer.

**Confirmed during this phase (previously only a prior session's
source-read hypothesis, now verified against the real installed
packages):** the real `sam3` package has no mask-prompt support anywhere
(image or video path). SAM 2.1's real `SAM2ImagePredictor.predict()` does
accept a `mask_input` (a low-res logit array, a refinement input layered on
point/box, not standalone) — confirming the UI spec's "SAM 2.1 adds a Mask
prompt-input SAM-3 doesn't have" was correct as stated.

This was also the first time the full 24-test ml-worker suite ran against
the real `sam2` package rather than a throwaway stub (every task from
Task 6 onward, across both this phase and Phase 2a, had used a stub since
`sam2` wasn't installed yet) — all 24 passed, zero API-assumption
discrepancies found between the adapter code and the real package.

**Manual verification result (completed 2026-07-24, real GPU + real
`facebook/sam2.1-hiera-large` weights):** the plan's micro-jitter stability
check — the same test that caught SAM-3's mask instability in Phase 2a (see
that phase's own deviation log and `.superpowers/sdd/task-6-report.md`) —
was run against `Sam2Adapter.predict()`: 25 point prompts on
`/home/hukuma/Pictures/references/High_Grade_Displasia_Stomach01.jpg`, a 5x5
grid spanning ±2px in each axis around a fixed base point. Result: **all 25
predictions produced byte-identical masks** (mask area 24108px, score
0.7346 in every case; coefficient of variation across mask area = 0.0000).
SAM 2.1's `predict()` is fully stable to 1-2px coordinate jitter on this
hardware — the opposite of SAM-3's confirmed instability, and consistent
with the rationale already recorded in Phase 2a.1's UI spec for making
SAM 2.1 the frame editor's default tab.

### Phase 2b: Detection adapters, datasets, training — NOT STARTED, NOT PLANNED

Scope per the design spec: Ultralytics YOLO11/YOLO12/YOLO26 detection
adapters selectable per-job via `Job.payload`, RT-DETRv2 adapter, RF-DETR
adapter (interface-level stub, no working inference yet — human's explicit
call, see the spec correction above), MLflow experiment tracking, dataset
export, model training. No implementation plan written yet; depends on
Phase 2a's `jobs` infrastructure landing first.

**Rough domain map, checked against Phase 2a.1's now-approved UI (added
2026-07-23, before any Phase 2b code exists — so a domain plan exists
before anyone starts coding into this blind, per an explicit ask following
the SAM 2.1 detour above).** The design spec's own `## Домены` /
`## Модель данных` sections already name most of this — this is not a new
design, just making explicit which UI-spec screen maps to which
already-specified backend domain, and calling out the one real gap:

- **Dataset screen → `datasets` module (already specified, not built).**
  Design spec already has `Dataset(id, name, task_type, taxonomy_version,
  split_config JSONB, balance_metrics JSONB)` and `DatasetItem(dataset_id,
  frame_id, annotation_ids[], split)`. The UI spec's live class-balance
  panel is `balance_metrics` computed on selection, not stored per-request;
  the sequence-picker checkbox list reads from `media`'s existing
  `Sequence`/`Frame` tables, no new media-side model needed.
- **Train screen → `training` module (already specified, not built).**
  Design spec already has `ModelVersion(id, name, task_type, base_model_id,
  dataset_id, mlflow_run_id, storage_key, is_active)`. The UI spec's live
  log stream reuses the `jobs` module's existing progress-reporting pattern
  (a `Job` row a Celery task updates) — training is a `Job.type` like
  `sam3_predict`/`sam3_track` are today, not a parallel status-tracking
  mechanism.
- **Results screen → the one real gap: no "inference run" concept exists
  anywhere yet**, in either spec. Design spec's `jobs` module already
  covers "run inference," but nothing currently models *keeping* a result
  around to show in the UI spec's "previous runs" history table (video
  used, model used, date, re-viewable output) — today's `Job` rows are
  transient work units, not a persisted result log. Needs either a thin
  `InferenceRun` record (references the `Job`, the input video, the
  `ModelVersion`, and the output `storage_key`) added to `training` — or
  folding into `jobs` itself if a completed `Job` row turns out to already
  carry enough (its `result_ref` field may already be sufficient; not
  decided here, left for Phase 2b's own implementation plan).
- **`SegmentationAdapter`/`DetectionAdapter` registry (design spec's
  `## ML-сервис: adapter-паттерн`) already covers per-adapter selection**
  via `Job.payload = {"adapter": "<name>", ...}` — this is the existing
  architectural answer to "how does a caller pick SAM-3 vs. SAM 2.1 vs. a
  future YOLO variant," predating this session. The open question Phase
  2a.1 deliberately left unresolved (see its own entry above) is *whether*
  the SAM-3/SAM 2.1 split reuses this exact `adapter` string mechanism or
  needs something else given `jobs`' current `Sam3PredictRequest`-shaped,
  SAM-3-only schemas — not whether a registry pattern exists, since it
  already does.

**Spec correction logged 2026-07-22 (before Phase 2 work started):** the
design spec originally described SAM-2 (point/box only) and YOLO11/RT-DETRv2
as current, with SAM-3/YOLO26 as future work "when they arrive." Both have
since shipped and become the project's primary targets — the spec's
"ML-сервис: adapter-паттерн" section was rewritten in place (with an inline
actualization note) to reflect: SAM-3 as the primary segmentation adapter
using all four prompt forms; YOLO11/12/26 as three separate `DetectionAdapter`
implementations chosen per-job (not a global service-wide switch); RF-DETR
added to the detection adapter registry as an interface-only stub alongside
RT-DETRv2. No architectural pattern changed — the adapter-registry design
already anticipated exactly this kind of model-version churn — only which
concrete adapters are the near-term target.

---

## How to use this file

- Before starting a new phase, add a `### Phase N: <name> — NOT STARTED`
  section with a link to (or placeholder for) its plan document.
- While executing, log deviations here as they're decided — not the full
  task detail (that's the plan's job), just what changed and why, so a
  later reader doesn't have to diff the plan against the actual code to
  find out.
- Small/routine deviations (a dependency version pin, a disclosed bugfix
  during TDD) don't need an entry here unless they change behavior a
  future phase would need to know about — those live in `.superpowers/sdd/`
  reports and commit messages instead.
- On phase completion, change its heading to `— DONE (YYYY-MM-DD)` and add
  a one-line summary + the deviation log, following the Phase 1 example.
