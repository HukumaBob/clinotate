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

**Final whole-branch review findings (2026-07-24, commit `28993dc`):** one
Critical finding — a suspected normalized-vs-pixel coordinate mismatch in
`Sam2Adapter` — was investigated live against the real installed `sam2` API
and confirmed to be a **false positive**:
`SAM2ImagePredictor.predict()`/`SAM2VideoPredictor.add_new_points_or_box()`
both default to `normalize_coords=True`, which expects and correctly
denormalizes `[0,1]` input — exactly this project's existing shared prompt
convention (already used by SAM-3's `SegmentButton.tsx` and unchanged by
this phase) — so no fix was needed. Two Important findings *were* real and
fixed:
- `PromptIn.mask_png` was unvalidated — a `type="mask"` prompt could omit
  `mask_png` entirely (crashing on `base64.b64decode(None)`) or supply an
  arbitrarily large string decoded/rasterized with no bound. Fixed with a
  Pydantic `model_validator` on `PromptIn` (`backend/app/jobs/schemas.py`):
  required when `type == "mask"`, capped at 10 MiB of base64 text.
- `Sam2Adapter.predict()`/`track()` read `prompts[0]`/built kwargs from an
  empty `prompts=[]` with no guard — `predict()` crashed opaquely inside
  `sam2`; `track()` was worse, starting real GPU video-session
  initialization before failing. Both now raise a clear `ValueError("at
  least one prompt is required")` up front.

All four fixes are TDD-covered (RED confirmed against the real installed
`sam2` package inside the ml-worker container, not hand-traced); full
regression suites re-run clean afterward: 44/44 backend tests, 26/26
ml-worker non-GPU tests (up from 24, +2 new empty-prompt guard tests).

### Phase 2c: Frame editor (SAM 2.1 UI) — DONE (2026-07-24)

Design: [docs/superpowers/specs/2026-07-24-frame-editor-design.md](docs/superpowers/specs/2026-07-24-frame-editor-design.md).
Plan: [docs/superpowers/plans/2026-07-24-frame-editor.md](docs/superpowers/plans/2026-07-24-frame-editor.md).

The platform's first real frame editor, replacing the Phase 2a
`SegmentButton.tsx` placeholder: SAM 2.1 point/box/mask prompts (gesture-
driven, no mode buttons for point/box per the UI spec), a Category →
Classification → Tag cascading label picker, track controls (explicit
Backward/Forward propagation, no unbounded default), a masks list with
click-to-select/highlight/auto-fill, and a minimal sequence grid to reach
it. SAM-3 tab renders but is disabled — current GPU VRAM is insufficient
to run it usefully; re-enabling it once hardware allows is a follow-up,
not a redesign, since the backend endpoints are untouched. 19 tasks,
subagent-driven-development, task-scoped review + one final whole-branch
review (Approved, no Critical/Important findings). Detailed per-task
commit ranges: `.superpowers/sdd/progress.md`.

**Backend additions found necessary during design, not anticipated by
either the design spec or the UI/UX spec (see the design spec's own
"Backend gaps found during design" section for full rationale):**
video-less sequences (`Sequence.video_id` made nullable,
`Sequence.procedure_id` added as an independent grouping root — mirrors a
capability the sibling Django project's `Sequences.video` nullable field
already had, for datasets built from standalone frame sets with no video
source), sequences-by-video/procedure listing endpoints, a cascading
label-tree endpoint (`GET /taxonomy/labels/tree`), and
`AnnotationRead.mask_url` for rendering mask overlays.

**Real bugs found only by real-browser end-to-end verification (real GPU,
real running stack, no mocks) — invisible to every prior unit/integration
test:**
- The ml-worker container's own duplicate `JobType` enum
  (`ml-worker/app/models.py`) was missing `SAM2_PREDICT`/`SAM2_TRACK` —
  a gap dating back to when SAM 2.1 support first landed in Phase 2a.2,
  never caught because no test suite exercises the real ml-worker
  container's own model definitions against a real job. Fixed; requires a
  Docker image rebuild to take effect (`docker compose build ml-worker`),
  not just a restart, since the container has no source volume mount.
- `FrameEditor` never invalidated the annotations query when a polled job
  transitioned to `succeeded` — a newly created mask never appeared in
  the masks list or canvas overlay without a full page reload. Fixed with
  a `useEffect` invalidating `["annotations", frameId]` on that
  transition; verified live with a second real SAM 2.1 job completing and
  the masks list updating with no reload.

**Known, deliberate simplification, not a bug:** the sequence grid route
(`/videos/:videoId/sequences/:sequenceId`) has no in-app navigation entry
point yet — it's reached directly by URL. This matches the UI/UX spec's
"reached directly" framing for this session (no Sequences list/catalog
screen was in scope), not an oversight.

**Minor findings from the final review, left as-is (non-blocking):**
`FrameEditor`'s `activeJobId`/job-polling state isn't reset when
`frameId` changes (a stale job-status line could briefly show when
switching frames, low real-world exposure given the editor's one-frame-
at-a-time lifecycle); `get_label_tree` has no `ORDER BY`, so
Category/Tag dropdown ordering isn't guaranteed stable across requests;
`useSam2Track` sends whatever `pendingPrompts` the store currently holds,
which `handleAddMask` clears on success — a track-after-predict click
sends an empty prompts list (backend accepts this; worth confirming this
is the intended anchor-frame-only track behavior once SAM 2.1 track gets
real hardware testing, deferred since SAM 2.1 track itself is untested on
this GPU per Phase 2a.2's own scope).

### Phase 2b: Detection adapters, datasets, training — `datasets` module and Dataset screen DONE (2026-08-16); detection adapters and training NOT STARTED, NOT PLANNED

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

**Open design question logged 2026-08-15 — RESOLVED and IMPLEMENTED
2026-08-15** per
[docs/superpowers/specs/2026-08-15-label-hierarchy-grouping-design.md](docs/superpowers/specs/2026-08-15-label-hierarchy-grouping-design.md)
and
[docs/superpowers/plans/2026-08-15-label-hierarchy-grouping.md](docs/superpowers/plans/2026-08-15-label-hierarchy-grouping.md).
What actually shipped, executed as 8 tasks via `subagent-driven-development`:

1. **Two new `Label` columns** (`a3c5355`): `parent_label_id` (self-referencing
   FK, nullable) and `is_abstract` (bool, default `false`). `Dataset.
   grouping_overrides` and the Dataset-screen balance panel remain deferred
   to Phase 2b's `datasets` module, unchanged from the original plan.
2. **Three invariants enforced in `backend/app/taxonomy/hierarchy.py`'s
   `validate_parent_assignment`** (`5448b52`), all raising `HierarchyError`
   → HTTP 422, not a DB constraint, because procedure is only reachable
   through `Category` (a composite FK would cost more than it's worth) and
   because "same annotation scope" needed application logic, not SQL:
   - same procedure (a mask label cannot be re-parented onto a label from a
     different procedure's taxonomy — verified live below);
   - no cycles (walks the parent chain from the proposed parent; hitting the
     child again is rejected before it can loop at export time instead of
     failing where the mistake was made);
   - same `annotation_scope` as the child (a mask/`geometric` label cannot
     hang under a whole-frame/`frame_classification` parent or vice versa —
     the same category error `AnnotationScope` already exists to prevent,
     entered from the other side).
3. **`resolve_class`** (`e671188`) in the same module: walks a label's
   parent chain and returns the highest *collapsed* ancestor's id (or the
   label's own id if nothing collapses it), given a `LabelTree` (all labels'
   hierarchy positions, loaded in one query — ~200 labels today, not worth a
   recursive CTE) and `GroupingRules` (a dataset's `collapse`/`expand`
   deltas on top of the taxonomy default, where "has children" = collapsed
   by default). No caller yet, as planned — the Dataset screen and export
   pipeline that will call it are still Phase 2b, not this plan.
4. **Quality-label migration** (`d0965f8`, Alembic revision
   `663b8b5c3cad`): moved `bad_picture`, `close_focus`, `dirty_optic`
   (colono + egds) from `geometric`/region-scoped to `frame_classification`,
   parented under each procedure's `low_quality`. UPDATE-only plus one
   INSERT (egds had no `low_quality` label yet; colono's already existed),
   keyed on label name rather than hardcoded ids so it stays correct if
   another environment's taxonomy layout differs. Verified against the dev
   database both by the migration's own log (181 → 182 labels, 82
   annotations unchanged) and, in this task, directly via `psql`: colono's
   `low_quality` is id 2373 with `dirty_optic` (id 2222) as its only
   migrated child; egds' `low_quality` is id 2476 with `bad_picture` (2171),
   `close_focus` (2166) and `dirty_optic` (2165) as children. Region-scoped
   Quality labels that were never in scope for this move (`foam`, `feces`,
   `mucus`, `bilis`, `liquor`, `bad_preparation`) stayed `geometric`,
   confirmed unchanged in both the Tags screen table and the frame editor's
   mask picker.
5. **Picker filtering** (`6cf1bd9`): both the sequence grid's
   frame-classification "Category…" dropdown and the frame editor's
   `CascadingLabelPicker` (mask/region annotation) now exclude any label
   with `is_abstract = true`, and the sequence grid's dropdown for `Quality`
   now lists the migrated three alongside `low_quality` while the mask
   picker's `Quality` list no longer does.
6. **Tags screen parent/abstract editor** (`92284bb`): the label edit form
   gained a "Parent label" dropdown (scoped to same-procedure labels) and an
   "Abstract (grouping only, not annotatable)" checkbox, both persisted via
   `PATCH /taxonomy/labels/{id}`.

**Real-browser verification (this task, 2026-08-15), against the dev stack
at commit `92284bb`** — done because this repo's frontend unit tests mock
`apiClient` wholesale and cannot observe whether an abstract label still
renders in a real picker against real taxonomy data:
- Sequence grid Select mode → Category "Quality": colono offers
  `dirty_optic`/`low_quality`; egds offers `dirty_optic`/`close_focus`/
  `bad_picture`/`low_quality`. Frame editor's `CascadingLabelPicker` →
  Category "Quality" for the same egds sequence lists only `foam`/`mucus`/
  `liquor`/`bad_preparation`/`bilis` — none of the three migrated labels
  appear there, matching the scope split.
- Tags screen: edited a disposable `test-polyp-label` row (id 2377, one of
  ~15 identically-named dev-debris rows left by earlier test runs, per this
  plan's own "known wrinkle" note below — a real clinical label was
  deliberately avoided), set its parent to `pedunculated_polyp_0_Ip`, saved,
  reloaded the page, and confirmed the parent field still read
  `pedunculated_polyp_0_Ip`. Checked "Abstract," saved, and confirmed the
  frame editor's Findings tag list dropped from 15 `test-polyp-label`
  options to 14; unchecked it, saved, and the count returned to 15. Both
  changes reverted before finishing, per this task's own constraint against
  altering real taxonomy data.
- `PATCH /taxonomy/labels/2166` (egds `close_focus`) with
  `{"parent_label_id": 2373}` (colono `low_quality`, a different procedure)
  returned HTTP 422 with `"Parent label must belong to the same procedure
  as its child"`; a follow-up `psql` check confirmed label 2166's
  `parent_label_id` was untouched (still 2476, egds' own `low_quality`) —
  no silent partial write.
- Both suites: backend `239 passed, 15 failed` (the 15 are the
  pre-existing, unrelated failures tracked separately — `test_jobs.py`,
  `test_mask_postprocess_endpoint.py`, `test_media_service.py`, all failing
  on a `null value in column "annotation_scope"` `NOT NULL` violation
  unrelated to this plan); frontend `415 passed`. Both match the numbers
  expected going into this task.

**Deviation during this task's execution:** the frontend dev server
originally running on port 5173 was serving a stale build from an earlier
session; verification used a second instance on port 5174 built from the
current commit instead, after discovering `backend/app/main.py`'s
`CORSMiddleware` only allow-listed `localhost:5173`. The allow-list was
temporarily extended to include 5174 for the duration of this task's
browser session and reverted immediately afterward — `git diff --stat
backend/app/main.py` shows no changes going into this commit. If a future
task needs a second concurrent frontend port routinely, that allow-list
should gain the second origin permanently rather than being toggled
per-session.

**Known limitation, not fixed here:** `backend/tests/test_quality_migration.py`
cannot pass in this environment as part of `pytest -q`, because `conftest.py`
builds an ephemeral, unseeded test database per run — the migration has no
`low_quality`/`bad_picture`/`close_focus`/`dirty_optic` rows to find by name
there, unlike the dev database this task verified against directly via
`psql`. This is a pre-existing gap in the test-DB fixture (no taxonomy
seed), not a defect in the migration itself; fixing it is out of this
plan's scope.

The original question, kept for context —

1. `frame_classification`'s `Quality` category currently has one label
   (`low_quality`), while `geometric` (region/MASK-BBOX)'s own `Quality`
   category has `bad_picture`/`close_focus`/`dirty_optic` as leftover
   region-scoped labels from the pre-taxonomy platform (which had no
   frame-level classification at all, so "picture is unfocused" had to be
   shoehorned into a bbox). Conclusion: these three describe the whole
   frame (defocus/glare/obstruction aren't spatially bounded the way
   `foam`/`feces`/`mucus` are), so they belong in `frame_classification`
   alongside `low_quality`, not `geometric`. Not yet done — needs a
   migration moving existing annotations, not just a taxonomy edit.
2. Separately: `bulk_mark_no_findings`'s conflict rule (any `Annotation`
   row, `CLASSIFICATION` included, clears `no_findings_reviewed` — see
   [docs/specs/2026-08-14-frame-no-findings-flag-design.md](docs/specs/2026-08-14-frame-no-findings-flag-design.md))
   was re-examined and confirmed correct for training *one* multi-class
   YOLO detector across findings+anatomy+artifacts together (not separate
   per-concept models) — a single YOLO label file already encodes
   per-class absence implicitly via missing lines, so the flag only needs
   to mark frames nobody annotated at all. No code change came out of
   this, just the reasoning is now recorded in the spec.
3. The bigger idea that came out of both: labels need a **parent-class
   grouping mechanism** so fine-grained annotation stays available (e.g.
   `0-Ip`...`LST` polyp subtypes, or `close_focus`/`dirty_optic`/
   `bad_picture` as quality sub-reasons) while dataset export can group
   them into a coarser, balanced class (`polyp`, `low_quality`) for
   actual training — imbalanced fine-grained classes are a known problem
   worth solving once, in the taxonomy (`Label.parent_label_id`, doesn't
   exist yet — today's hierarchy is only `relations` used for tag/category
   resolution at import time, not class-grouping), not per-export as a
   hand-maintained mapping file. The editing *UI* for that grouping should
   live on the not-yet-built Dataset screen next to its live
   `balance_metrics` panel (already in the design spec's `Dataset` model,
   see above) — the whole point is choosing groupings while watching the
   resulting class balance, not editing hierarchy blind on the Tags
   screen. Scoped as part of Phase 2b's `datasets` module, not started.

**Dataset screen: grouping-unit correction, class limits, metrics/
recommendations, and the per-scope picker columns — DONE (2026-08-16)**
per
[docs/superpowers/specs/2026-08-16-dataset-grouping-unit-and-panel-design.md](docs/superpowers/specs/2026-08-16-dataset-grouping-unit-and-panel-design.md)
and
[docs/superpowers/plans/2026-08-16-dataset-grouping-unit-and-panel.md](docs/superpowers/plans/2026-08-16-dataset-grouping-unit-and-panel.md).
Executed via `superpowers:subagent-driven-development` across 8 tasks, each
committed directly to `master` per this repo's single-developer git
workflow (no branches/worktrees). What shipped:

1. **`grouping_key`, the unit of data independence** (`16c5162`): every
   sequence resolves to `("video", video_id)` when it has a parent video,
   or `("sequence", sequence_id)` for a standalone photo batch. This fixed
   a real bug in split assignment (`e9a02ac`) — before this task, `Dataset`
   split assignment operated per-sequence, so a video with two child
   sequences (e.g. video 2113 owning both `caecum01` and `ileum`) could put
   one sequence in `train` and the other in `val`, leaking frames from the
   same source video across the train/val boundary. Verified on live data
   both during the task and again in this task's own browser pass: `GET
   /datasets/{id}` for a dataset built from sequences 2074 (`caecum01`) and
   2075 (`ileum`) — both children of video 2113 — shows every item from
   both sequences landing in the same `val` split; no video spans two
   splits.
2. **Class limits, apportioned across grouping units, not drained from
   one** (`c3cac3b`): a per-class instance cap spreads its cut across the
   contributing videos/photo batches by weight, rather than naively
   keeping the first N instances by id (which would have silently emptied
   whichever unit happened to sort first). A limit below 1 (`0`, negative,
   non-finite) is treated as *clearing* the cap, not as a real limit of
   zero — the exclude checkbox is what removes a class entirely, and a
   stored `0` would have silently dropped the class from the report while
   its "Include" checkbox still showed it as checked, i.e. two controls on
   the same screen disagreeing about the same class. This was caught by
   code review as a real Critical during the task (typing `0` made the
   class vanish end-to-end against the live backend) and fixed in
   `ceae211`; this task's own browser pass re-confirmed the fix holds:
   capping `polyp` from 45 to 10 instances reduced its count in the panel,
   and typing `0` into the same field cleared the cap (`polyp` returned to
   45/43, not zero).
3. **Per-scope annotation counts on the sequence list** (`6b96ed7`):
   `SequenceListItem` gained `region_annotation_count` and
   `frame_annotation_count`, so a task-type-aware caller (`detection` only
   cares about region-scoped annotations; `classification` only about
   frame-scoped) can tell in advance whether selecting a given sequence
   will contribute anything.
4. **Balance recommendations derived from the computed metrics**
   (`9979f3a`, pluralization fix folded into `5ff8853`): under-threshold,
   loss-weighting, cap-largest, and — the piece with no counterpart in the
   older Django reference — single-unit-concentration warnings ("100% of
   'X' comes from one video or photo batch"), computed from the same
   grouping unit introduced in step 1. Advisory only, by design (see
   "Deferred, deliberately" below) — nothing about generating a
   recommendation mutates `excluded_label_ids`, `class_limits`, or dataset
   state.
5. **Key-metrics block and recommendations in the balance panel**
   (`5ff8853`): imbalance ratio, Gini index, normalized entropy, min/max
   per class, and severity render below the class bars; recommendations
   render below that. The below-threshold summary deliberately stays the
   headline above both — severity is not lead-worthy because collapsing a
   label group *raises* `imbalance_ratio` while being the correct thing to
   do, so optimizing for severity in the UI would mislead.
6. **Saved-dataset Metrics dialog** (`35dac54`/`ceae211`): a `Datasets`
   table row's "Metrics" action opens a dialog showing the `Dataset`'s
   stored `balance_metrics` snapshot (not a live recompute), with a Close
   button and Escape-to-close.
7. **Sequence-picker Region/Frame/Video columns** (this task, `1536dd5`): the
   Dataset screen's sequence picker gained three columns reading
   `region_annotation_count`, `frame_annotation_count`, and `video_id`
   (rendered `—` for a photo batch with no owning video) — the same fields
   from step 3, now visible where a user actually picks sequences instead
   of only reachable via the API.

**Real-browser verification (this task, 2026-08-16), against the dev stack
at commit `1536dd5`** — done because this repo's frontend unit tests mock
`apiClient` wholesale and cannot observe whether the panel really
recomputes against live data or whether a limit really reduces a class:
- Picker columns matched a DB ground-truth table exactly: `caecum01` (id
  2074) showed region 0 / frame 29 / video 2113; `ileum` (id 2075) showed
  region 3 / frame 0 / video 2113; the two `colono 2026-08-16` polyp
  sequences (ids 2322/2323, video 2178) showed region 0 / frame 9 and
  region 0 / frame 87; `colono 2026-08-06 #2` (id 2094, a photo batch)
  showed region 52 / frame 0 / video `—`.
- With `task_type=detection`, selecting only `caecum01` (0 region
  annotations) produced 0 classes and severity `no_data`; adding `colono
  2026-08-06 #2` (52 region annotations) produced 7 classes headed by
  `polyp` at 45/43. A direct `POST /datasets/balance` call with the
  identical `sequence_ids`/`task_type` returned the same class list,
  `total_frames`, and all five metrics fields (imbalance ratio 45.0, Gini
  0.74, normalized entropy 0.32, severity `severe_imbalance`) — confirmed
  byte-for-byte against the panel.
- Recommendations named real classes, including an
  `under_threshold` warning (6 classes below 10 instances) and two
  `single_unit_concentration` warnings ("100% of 'polyp' comes from one
  video or photo batch...", same for `lst_g_homogeneous`).
- Setting a limit of 10 on `polyp` dropped its panel count from 45 to 10;
  typing `0` afterward cleared the cap (the input went blank) and `polyp`
  returned to 45/43 rather than disappearing — the `ceae211` fix confirmed
  live, not just in unit tests.
- Saved a dataset (`task8-verification-dataset`, detection, sequences
  2074/2075/2094/2322/2323) — appeared in the table with the correct
  frame count and severity; its Metrics action opened a dialog matching
  the panel's live numbers; Escape closed it.
- **The split check, the point of this whole plan:** `GET
  /datasets/{id}` on the saved dataset showed every item from sequence
  2074 and every item from sequence 2075 in the same `val` split (both
  children of video 2113); items from sequence 2094 (no owning video, a
  photo batch) landed in `train`. No video spanned two splits.
- Deleted the dataset via the UI; `GET /datasets` confirmed the table
  ended empty.
- Both suites: backend `309 passed, 16 failed` (pre-existing and
  unrelated — `test_jobs.py`, `test_mask_postprocess_endpoint.py`,
  `test_media_service.py`, `test_quality_migration.py`, tracked in this
  file's teardown-defect and quality-migration notes above); frontend
  `457 passed`.

**Deferred, deliberately:** the pie chart — at 26 classes its sectors are
indistinguishable and its legend outgrows the chart, while the existing
bars answer the same question at any scale. YOLO export, `data.yaml`, the
class-map fingerprint, and archive download remain the next separate
piece of work. Auto-applying a recommendation with one click (present in
the older Django reference) was deliberately not built — the
recommendations here stay advisory-only, because silently applying an
exclusion or cap on the user's behalf is exactly the kind of invisible
data decision this screen exists to make visible.

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

### Phase 2b's `datasets` module and Dataset screen — DONE (2026-08-16)

Plan: [docs/superpowers/plans/2026-08-15-dataset-screen.md](docs/superpowers/plans/2026-08-15-dataset-screen.md),
spec: [docs/superpowers/specs/2026-08-15-dataset-screen-design.md](docs/superpowers/specs/2026-08-15-dataset-screen-design.md).

The `datasets` module (`Dataset`, `DatasetItem`) plus the Dataset screen,
the first thing to actually consume `Label.parent_label_id`/`resolve_class`
(shipped in the label-hierarchy phase above but unused until now) and
`no_findings_reviewed` (shipped in the no-findings-flag phase, likewise
unused until now). Executed via `superpowers:subagent-driven-development`
across 8 tasks, each independently committed to `master` (no branches/
worktrees, per this repo's single-developer workflow), task-scoped review
after each, capped by this task's real-browser verification.

**Composition rules:** a frame from the selected sequences enters a
dataset when either (1) it carries at least one annotation whose
`annotation_scope` matches the dataset's `task_type` (`classification` →
FRAME only, `detection`/`segmentation` → REGION only) and not excluded via
`excluded_label_ids`, or (2) `no_findings_reviewed` is set — a negative
example, exported later with an empty label file. A frame whose only
annotations are all excluded drops out entirely rather than becoming a
negative — "we chose not to train this class" is not the same claim as
"this frame contains nothing," and conflating the two would manufacture
false negatives. `task_type` therefore filters composition, not just
labels it: classification and detection/segmentation datasets are always
disjoint frame sets by construction, not by convention.

**`compute_balance` shares `resolve_class`** with the annotation/export
path (`backend/app/taxonomy/hierarchy.py`, from the label-hierarchy
phase) rather than reimplementing grouping logic for the panel — a class
shown in the live balance panel is guaranteed to be the same class a
future export would actually write, by construction rather than by
convention kept in sync by hand.

**Splits are assigned per sequence, never per frame.** Frame-level random
splitting was considered and rejected: consecutive frames of one video are
near-duplicates, so a frame landing in train and its neighbour in val is
effectively the same image on both sides of the split, inflating
validation metrics into meaninglessness. `split_config` holds requested
train/val percentages (test is the remainder); at save time whole
sequences are assigned to a split and every frame inherits its sequence's
assignment, so the realized per-split frame counts can (and with few
sequences, will) diverge from the requested percentages — the panel
reports realized counts alongside the request rather than hiding the gap.
`DatasetItem` rows are materialized at save time, not recomputed live:
composition freezes so a later annotation pass never silently changes
what a previously-saved dataset means, keeping training-run comparisons
meaningful.

**The screen:** `/datasets` (nav label deliberately kept singular
"Dataset" after a mid-plan revert), a sequence picker with frame/labeled
counts, a live class-balance panel (`BalancePanel.tsx`) that recomputes
on every selection/grouping/exclusion change (debounced 300ms), a
collapse toggle per class that has taxonomy children (leaf classes render
as plain text, no disclosure control), a per-class Include checkbox, and
a name/split/Save form with reachable (aria-described) disabled-reasons
for the three save guards: no sequences selected, empty name, and
train%+val% exceeding 100.

**`polyp` seeding created TWO abstract parent labels, one per procedure**
(id 2523 under `egds`, id 2524 under `colono`), not one — egds has its own
polyp subtype vocabulary, distinct from colono's `0-Ip`/`0-Is`/`IIa`/LST
ladder, and a label's parent must stay within its own procedure's taxonomy
(enforced by the label-hierarchy phase's `validate_parent_assignment`).
Both collapse to the same display name `polyp` but are different label
rows with different children.

**Deliberately deferred, not overlooked:** YOLO export (`data.yaml`,
image/label files, class-map fingerprint, archive download,
`Dataset.storage_key`), the Train screen and `ModelVersion`, and
auto-applied balance recommendations (trusting a heuristic blindly at the
current ~75 annotated frames is premature; manual exclusion covers the
same need honestly). `Dataset` is create/delete only — no edit endpoint,
since editing one would reopen the frozen-composition question this plan
deliberately settled.

**Real-browser verification (this task, 2026-08-16),** against the dev
stack, `manualcheck@example.com` login, live dev database — done because
this repo's frontend unit tests mock `apiClient` wholesale and cannot
observe whether the panel recomputes against real data or whether a
flagged frame really becomes a negative:
- Nav shows `Dataset` (singular); `/datasets` route confirmed.
- Selected the 8 sequences carrying detection annotations
  (`colono 2026-08-15 #1`, `colono 2026-08-06 #2`, `caecum01`, `ileum`,
  `colono 2026-08-04 #1`, `colono 2026-08-01 #3`, `colono 2026-07-31 #2`,
  `colono 2026-07-31 #1`) under `task_type = detection`: panel showed
  66 frames, 23 negatives, `polyp` as **one** class of 35 instances / 33
  frames (not five subtypes), `colon_adenoma` 8/6, `foam` 2/2, five
  singletons at 1/1, severity `severe_imbalance`, 7 classes below the
  default threshold of 10 — matching a direct `psql` query against the
  same sequence set exactly.
- Collapse toggle on `polyp` expanded it into `pedunculated_polyp_0_Ip`
  16, `sessile_polyp_0_Is` 14, `flat_lesion_0_IIa` 3,
  `lst_g_nodular_mixed` 1, `lst_ng_flat_elevated` 1 (instances); toggling
  back recollapsed to 35/33. Leaf rows (`colon_adenoma`, `foam`, every
  singleton, every polyp subtype) rendered with no collapse toggle —
  confirmed by full a11y-tree snapshot, not just visual inspection.
- Excluding `transparent_cap` removed it from both the chart and the
  below-threshold list (7 → 6) and dropped total frames 66 → 65.
- With all 8 sequences selected the panel reported `Negatives: 23` as a
  visible row, not hidden.
- Save guards: Train=70/Val=50 disabled Save with a screen-reader-visible
  alert ("Train % and Val % must not exceed 100 combined."); deselecting
  all sequences disabled Save with "Select at least one sequence to save
  a dataset."; both match the two dedicated `aria-describedby` messages
  added in `de573e1`.
- Saved `browser-check` (detection, 8 sequences, Train 70/Val 20/Test 10,
  `transparent_cap` excluded): appeared in the table with 66 frames,
  `severe_imbalance`. `GET /datasets/{id}` confirmed `item_count: 66`,
  `split_counts: {train: 40, val: 20, test: 6}` (all three non-empty),
  and a full per-item check (66 `DatasetItem` rows) confirmed zero
  sequences span more than one split.
- Deleted `browser-check` via the table's two-click Delete/Confirm button;
  `psql` confirmed zero rows in `datasets` afterward.
- Both suites: backend `280 passed, 15 failed` (the same 15 pre-existing,
  unrelated failures tracked in the label-hierarchy phase's entry above —
  `test_jobs.py`, `test_mask_postprocess_endpoint.py`,
  `test_media_service.py` — count risen from the 239/244 baseline as
  expected, the 15 unchanged); frontend `431 passed`.

**Two real UI bugs found during this verification, left unfixed per this
task's scope (verification + ROADMAP entry only — no code changes
authorized):**
- **Excluding a class has no undo in the UI.** `BalancePanel.tsx` renders
  one row per entry in the *server's* `report.classes`, and the backend
  (`backend/app/datasets/service.py`) omits any `excluded_label_ids`
  member from that list entirely — so once a class's Include checkbox is
  unchecked, its row (checkbox included) disappears from the DOM. Nothing
  else on the page offers to re-include it; the only way back is to
  discard the whole `excluded` selection (e.g. a page reload), which also
  undoes every other exclusion made in the session. Confirmed via a full
  a11y-tree snapshot after exclusion — no hidden control, no separate
  "excluded classes" list.
- **Save is not actually guarded against an empty name.** `canSave` reads
  `name.trim().length > 0`, and the Name field's live DOM value, React
  `value` prop, and fiber `memoizedProps.value` were all confirmed empty
  (via `evaluate_script`, not just the a11y snapshot) after clearing it
  with a real keyboard `Ctrl+A`/`Backspace` — yet the Save button's
  `disabled` prop, read the same way, was `false`. Root cause not
  investigated (out of this task's scope); flagging for a follow-up fix
  before this screen is treated as production-ready for the empty-name
  case specifically. The other two guards (split > 100%, no sequences
  selected) were verified working correctly.
- Also observed, not a defect: after deleting the saved dataset, the
  datasets table briefly still showed a leftover row from an unrelated
  earlier session's data until a full page reload — a stale
  `useDatasets()` cache not invalidated after delete, separate from the
  Save-guard bug above. A reload confirmed "No datasets yet." and `psql`
  confirmed zero `datasets` rows, so this is a cache-invalidation
  cosmetic issue, not a data-integrity one.

### Phase 2b: Balance-panel limit and exclusion controls — DONE (2026-08-18)

Plan: [.superpowers/sdd/2026-08-16-balance-panel-limit-controls](.superpowers/sdd/2026-08-16-balance-panel-limit-controls).

Fixes the per-class limit and exclusion controls in `BalancePanel.tsx`
that the previous phase's real-browser verification flagged as broken:
typing a value into a class's limit field could collapse it to `1` after
the first keystroke instead of settling at the typed number, and
excluding a class made its row vanish from the DOM entirely (no way back
short of discarding every other exclusion made in the session, per the
prior phase's "no undo" finding).

**The per-keystroke bug's actual cause:** the limit `<input>` was bound
directly to local `classLimits` state, and the change handler applied
that value as the real cap on every keystroke — so typing `10` applied a
cap of `1` the instant the first digit landed, then `10` a moment later,
with the intermediate `1` already having taken effect (e.g. re-triggering
a recompute against a limit the user never intended to set). There was no
server round-trip or race involved. Fixed by giving each limit field its
own local input state, only reconciled from the server once the debounced
request settles and the user isn't actively typing — the field now
free-types to any digit sequence and reconciles after the user stops,
rather than committing a cap on every key.

**Excluded classes now stay visible, greyed, not hidden.** `compute_balance`
(`backend/app/datasets/service.py`) was changed to report every class in
the requested scope regardless of `excluded_label_ids` membership, each
carrying its own uncapped `max_instances`/`max_frames` — the panel always
has a fixed 9-row (or however many classes exist) shape to render, and
`BalancePanel.tsx` greys a row via its `included` flag instead of
filtering it out of the list. This replaces the "0 clears the cap"
behavior from the class-limit-controls phase two commits prior
(`ceae211`): that fix's own Critical finding was that the checkbox and
the numeric field could disagree about whether a class was capped versus
excluded, not that zero's *meaning* was wrong. The real fix synchronizes
the two controls both ways — unchecking Include zeroes the limit field
and greys the row (confirmed: unchecking `foam` left its row in place,
text reading `0 / 0 (max 2)`); typing `0` into the limit field clears the
Include checkbox and greys the row the same way (confirmed for
`lst_g_homogeneous`); re-checking Include restores the field to the
class's stored maximum and un-greys the row (confirmed: re-checking
`foam` returned it to `2 / 2`).

**Limit fields are prefilled to each class's maximum, not empty or
zero**, so the field always starts at "everything this class has" and a
user only has to type to *reduce* it — confirmed `polyp`'s field opened
at `45` (`valuemax="45"`) before any typing, matching the sequence
selection's true count.

**Metrics are computed from the non-excluded subset specifically to keep
`imbalance_ratio` finite.** Excluding all six 1/1 singleton classes while
leaving `polyp` (45) and `foam` (2) included dropped `min_count` to 2 and
produced `imbalance_ratio: 22.50` — a real number, matching a direct
backend query — instead of dividing by a zero-count excluded class.
Excluding every class, including `polyp` and `foam`, still rendered all 9
rows (each `0 / 0 (max N)`, greyed) rather than an empty panel, with
`severity: no_data` and metric fields showing `-`; this "all-excluded"
path was a real bug found and fixed mid-plan (`756fea2`), not a
speculative edge case.

**The counts column got a visible `instances / frames` heading**, so a
raw `18 / 17` pair reads as self-explanatory rather than requiring the
viewer to infer which number is which.

**Real-browser verification (this task, 2026-08-18),** against the dev
stack, `manualcheck@example.com` login, live dev database — this repo's
frontend unit tests mock `apiClient` wholesale and cannot observe a
per-keystroke race condition or a debounced server round-trip, which is
exactly the class of bug this plan exists to fix:
- Selected all 10 sequences under `task_type = detection`: panel reported
  the ground-truth 9 classes exactly — `polyp` 45/43, `foam` 2/2,
  `lst_g_homogeneous` 2/2, and six singletons (`colono_sheath`,
  `colono_ssl`, `diverticulum`, `ileum`, `transparent_cap`,
  `valvula_ileocaecalis`) at 1/1 each.
- Typed `10` into `polyp`'s limit field (select-all + type, simulating a
  real keystroke sequence): settled at `10 / 10` with no intermediate
  collapse to `1`; `Imbalance ratio` recomputed to `10.00`. This is the
  headline bug the plan exists to fix, and it did not reproduce.
  Select-all + retype `20` afterward settled cleanly at `20 / 20`
  (confirmed the earlier bug was specific to reproducing the original
  human report, not select-and-replace editing).
- Before typing, `polyp`'s field showed `45` (its true max) and the
  spinbutton's `valuemax` stayed `45` throughout — it never accepted or
  displayed a larger value.
- Unchecked `foam`: row stayed with `0 / 0 (max 2)`, checkbox cleared,
  `Classes` count stayed `9`. Typed `0` into `lst_g_homogeneous`: its
  checkbox cleared and its row greyed the same way, no manual checkbox
  click needed. Re-checked `foam`: field snapped back to `2` (its
  maximum) and the row un-greyed.
- Excluded all six singleton classes one at a time (leaving `polyp` at
  its reset max of 45 and `foam` included): `Imbalance ratio` read
  `22.50`, `Min / max per class` read `2 / 45`, `Classes` stayed `9` —
  exactly matching ground truth, never `Infinity` or `∞`.
- Excluded every remaining class (`polyp`, then `foam`): all 9 rows
  persisted, each `0 / 0 (max N)` and greyed; `Severity` read `no_data`;
  every metric field showed `-` instead of crashing or blanking the
  panel.
- `instances / frames` heading confirmed present above the counts column
  throughout.
- Both suites: backend `318 passed, 16 failed` (the pre-existing,
  unrelated failures tracked in earlier phases' entries — `test_jobs.py`,
  `test_mask_postprocess_endpoint.py`, `test_media_service.py`,
  `test_quality_migration.py` — count risen by one from the 15-failure
  baseline logged in the dataset-screen phase above, still none of them
  balance-panel-related); frontend `464 passed` (68 test files).

Executed via `superpowers:subagent-driven-development` across 3 tasks
(2 implementation + this task's real-browser verification), committed
directly to `master` per this repo's single-developer workflow — no
branches or worktrees.

### Phase 2b: Dataset export to YOLO and COCO — DONE (2026-08-18)

Plan: [.superpowers/sdd/2026-08-18-dataset-export](.superpowers/sdd/2026-08-18-dataset-export).
Design: `docs/superpowers/specs/2026-08-18-dataset-export-design.md`.

Turns a saved `Dataset` into a downloadable archive: both a YOLO layout
(`data.yaml` + `images/<split>/` + `labels/<split>/`) and a COCO document
(`annotations.json`) from one extraction pass, zipped together and stored
via `StorageService` like every other binary artifact in this codebase.
Runs as a `Job` (`job_type=dataset_export`) on the CPU-only transcode
worker's `video_transcode` queue — not the GPU `ml-worker` — since export
is pure I/O and geometry math, no inference. 6 tasks, subagent-driven
development, task-scoped review + this final real-archive verification.

**Geometry is derived from the stored raster mask at export time, not read
from the database.** `Annotation` rows carry a `storage_key` pointing at a
PNG mask; bounding boxes, polygon contours, and pixel area (for the
mask-area threshold below) don't exist as columns anywhere; they're always
a function of that raster. `app/datasets/geometry.py`'s `decode_mask`/
`extract_geometry` do this once per annotation and the result feeds both
serializers, so YOLO's box and COCO's polygon are guaranteed to agree
they're both looking at the same pixels.

**The `<sequence_id>_<index>` archive naming (`archive_name()` in
`app/datasets/export.py`) is load-bearing, not cosmetic.** Frames are
stored as `frames/<sequence_id>/<index>.png`; across the real corpus, 1109
frames share only 488 distinct basenames — naming archive entries by
basename alone would silently overwrite more than half the dataset and
leave label files pointing at the wrong pixels. Verified against real data
this task (below), not just asserted by the docstring.

**A configurable mask-area threshold (`PlatformSettings.min_mask_area_fraction`,
default `0.0005`) drops noise-sized masks from an entry without dropping
the frame** — unless the frame was explicitly marked `no_findings_reviewed`,
filtering a tiny mask is not the same claim as "this frame is confirmed
empty," so a frame that loses its only entry to the threshold leaves the
dataset entirely rather than becoming a silent negative.

**Findings collect across the whole walk instead of raising on first
defect.** A missing mask, an invalid/degenerate mask, a multi-label
classification frame, or a mask below threshold each becomes a `Finding`
(kind, frame_id, annotation_id, detail) appended to a list that keeps
walking every remaining `DatasetItem` — so a multi-gigabyte export surfaces
every defect in one pass instead of one re-run per defect. Findings ride
along in the finished `Job.payload`, not a separate table.

**COCO's `info` block carries the provenance a downstream consumer needs to
answer "was this export computed with the settings I think it was":**
`taxonomy_version`, `class_map` (class name → source `label_id`s it was
derived from — a class can merge more than one label), `class_limits`,
`excluded_label_ids`, `split_config`, `exported_at`. This project had never
written COCO before this plan; getting `info` right mattered because there
was no prior implementation to copy from.

**The archive is assembled by streaming into a `zipfile.ZipFile` opened
against a real file, never building the payload in memory first** — the
whole reason Task 6 (this one) exists is that the project's own tests use
a fake in-memory storage class and had never produced a real zip, so this
property was previously unverified.

**Real-archive verification (this task, 2026-08-18), against the dev
stack, `manualcheck@example.com` login, live dev database — the project's
own tests cannot produce a real zip or validate COCO against anything but
its own assumptions, which is exactly what this task exists to check:**
- **Scale guard test** (`backend/tests/test_dataset_export_scale.py`,
  new): a thousand 64 KB `writestr` entries (~64 MB of payload) streamed to
  a real `zipfile.ZipFile` on disk. Measured peak RSS growth: **0.625 MB**
  (compressed archive size 205,802 bytes), against a 32 MB threshold —
  confirms streaming, not in-memory assembly. Passed.
- **Real export via the API**, dataset 106 (`33333`, `task_type=detection`,
  sequence 2094): `POST /datasets/106/export` created `Job` 1518, which sat
  `pending` forever — the already-running transcode worker process turned
  out to be stale, registered with `video_transcode` only and no
  `dataset_export` task (`celery inspect registered` confirmed it), so its
  message was silently swallowed exactly the way CLAUDE.md's queue warning
  describes for the *other* worker. Restarted it with the documented
  `-Q video_transcode` flags; the new process registered both tasks. A
  fresh export (`Job` 1520) then ran end to end in real time: `pending` →
  `succeeded`, **progress 100**, `result_ref =
  datasets/106/export-20260818T184032050563.zip`, `findings: []`.
- **Archive contents** (34 images/labels, all landed in `train` — small
  corpus, 70/20/10 split rounds that way): `data.yaml` (`nc: 2`, `names:
  {0: pedunculated_polyp_0_Ip, 1: sessile_polyp_0_Is}`), `annotations.json`
  (34 images, 36 annotations, 2 categories, `info.taxonomy_version` and
  `info.class_map` both present and truthy). Image and label stems matched
  1:1 (34/34, `diff` clean). Every one of the 36 label lines' first integer
  indexed correctly into `data.yaml`'s `names` (checked programmatically,
  0 bad).
- **COCO validated against a real consumer, `pycocotools`** (not installed
  in the project — pulled transiently via `uv run --with pycocotools`,
  nothing added to `pyproject.toml`): `COCO(annotations.json)` loaded
  without error, built its image/annotation index, and correctly resolved
  a sample image's annotations (bbox, segmentation polygon, area) by
  `image_id`. This is the first real external-library validation COCO
  output from this codebase has ever had.
- **Collision case**, checked on real data: the corpus actually has **10**
  sequences sharing `frame_index = 0` (the brief's plan document estimated
  9; querying `frames` directly found 10). Dataset 106 alone only spanned
  one of them, so a second, throwaway dataset (id 211, deleted after the
  check, sequences 2074/2094/2323/2957) was created to force the collision
  into one archive. Result: `images/val/2074_0.png` (id 12820, caecum,
  244×236) and `images/test/2957_0.png` (id 18736, caecum, 720×576) both
  appear as distinct entries in the same zip and as distinct `image_id`s
  in `annotations.json` — confirming `archive_name()`'s
  `<sequence_id>_<index>` scheme prevents the basename collision it exists
  to prevent, on the real corpus, not a synthetic one.
- **Real-browser click-through**: logged in as `manualcheck@example.com`,
  opened `/datasets`, clicked **Export** on dataset 105 (`22222`); the
  button became a **Download** link pointing at
  `datasets/105/export-20260818T184406937713.zip` once the job finished —
  confirming the UI's poll-to-completion wiring, not just the API.
- Both suites: backend **353 passed, 16 failed** (all 16 pre-existing and
  unrelated — `test_jobs.py`, `test_mask_postprocess_endpoint.py`,
  `test_media_service.py`, `test_quality_migration.py`, same set tracked in
  the balance-panel phase above); frontend **472 passed** (69 test files).
- The three pre-existing datasets (104 `11111`, 105 `22222`, 106 `33333`)
  were used read-only or exported-from; the only dataset created during
  this verification (211) was deleted afterward.

**Deferred, deliberately (per the plan's own scope note):** training (the
Train screen, with its own `ModelVersion` model already sketched in the
design spec); incremental export (every export rebuilds from scratch —
fine at this corpus size, would need versioned archives/deltas at
gigabyte scale, not worth guessing at before the pain is real); archive
cleanup (old exports accumulate in object storage with no retention
policy — nobody has needed one yet); repairing annotations during export
(the findings report achieves the same practical outcome — fix everything
in one batch — while keeping the decision with the user, since a silent
correction during export would produce a dataset diverging from what the
annotation UI shows).

### Phase 2a.3: Media screen — DONE (2026-07-29)

Real "Media" top-level screen (video upload → extract-sequence with crop
box and configurable fps, batch photo upload, raw media library table
with delete) per [docs/superpowers/specs/2026-07-28-media-screen-design.md](docs/superpowers/specs/2026-07-28-media-screen-design.md)
and [docs/superpowers/plans/2026-07-28-media-screen.md](docs/superpowers/plans/2026-07-28-media-screen.md),
replacing the old single-title video-upload placeholder. Routes renamed
`/videos` → `/media`, `/videos/:videoId/sequences/:sequenceId` →
`/sequences/:sequenceId`. Executed via `superpowers:subagent-driven-development`
across all 12 plan tasks, each independently task-reviewed, plus a final
whole-branch review and one fix wave for its findings. Manually verified
end-to-end against a real browser (login → upload → extraction → sequence
grid with real frames, for both the video and photo-batch flows; delete
with 409-on-conflict).

**Deviations from the plan, decided during execution:**

- **Out-of-band test-isolation fix, not part of the plan's own tasks:**
  `backend/tests/conftest.py` gained a session-scoped autouse fixture that
  patches `app.db`'s module-level `engine`/`SessionLocal` to point at
  `endoscopy_test` for the whole pytest session (commit `e1ad521`). Before
  this, `test_media.py`/`test_taxonomy.py`/`test_auth.py`'s `TestClient(app)`
  calls went through `app/db.py`'s real engine (pointed at the real
  `endoscopy` dev DB per `.env`), not the `endoscopy_test`-scoped fixture —
  every full suite run silently wrote real rows into the real dev DB, and
  a second run collided with `UniqueViolation`/409s against the first
  run's leftovers. Verified fixed with two consecutive full `pytest -q`
  runs (both green, no collisions) and confirmed the real `endoscopy`
  database's row counts didn't change across either run.
- **`MediaLibraryTable.tsx` was built one task early (Task 10 instead of
  Task 11)** because `MediaPage.tsx` (Task 10's own deliverable) imports
  it and the task's own quality bar required a clean `tsc`/`vitest` build.
  The Task 10 placeholder used `window.confirm()` for delete instead of
  Task 11's planned two-click inline Confirm button; Task 11 replaced it
  wholesale per its own brief, confirmed zero `window.confirm` remnants
  anywhere in `frontend/src`.
- **Final whole-branch review (Opus) found 2 Critical + 5 Important + 5
  Minor issues invisible to every per-task review** because they lived at
  task boundaries or in files no single task's brief listed:
  - Critical: an out-of-range crop box (`left+right>=100` or
    `top+bottom>=100`) crashed with an uncaught `cv2.error` → HTTP 500
    instead of the spec-mandated 422, leaving an orphaned `Sequence` row
    already committed before the crash. Fixed with Pydantic-level
    validation on `CropBox` (commit `b7be883`).
  - Critical: `MediaLibraryTable`'s delete-confirm state was keyed on bare
    numeric `item.id`, which collides between independent video-id and
    sequence-id spaces — confirming delete on one row could affect the
    wrong same-id row of the other kind. Fixed by keying on the same
    composite `${kind}-${id}` the row `key` already used (commit `b7be883`).
  - Important: the procedure selected during video upload
    (`VideoUploadFlow`) was silently discarded when `ExtractSequenceForm`
    mounted, which then auto-selected the query-first procedure instead —
    confirmed user-visible via the manual browser walkthrough. Fixed by
    threading a `procedureId` prop through, and by actually persisting it
    as `Sequence.procedure_id` on video-derived sequences (previously
    never sent to the backend at all) (commit `b7be883`).
  - Important: `PhotosUploadFlow`'s name input had lost its `required`
    attribute as a test-workaround. Fixed by restoring `required` and
    extending the existing submit guard to also reject a blank/
    whitespace-only name (commit `b7be883`).
  - All 5 blocking findings re-reviewed clean (ADDRESSED, no new breakage)
    before merge.
- **Deferred to a follow-up ticket, not blocking this merge** (per the
  final reviewer's own "Ready to merge: With fixes" verdict, which named
  only the items above as blocking):
  - `suggest_sequence_name` (backend/app/media/service.py) has unescaped
    LIKE metacharacters in the procedure-name prefix match, and doesn't
    filter on `procedure_id` — a procedure literally named `100% egds`,
    or two procedures sharing a name prefix (`egds` / `egds 2`), can
    produce a wrong ordinal in the auto-suggested sequence name. Cosmetic
    (user-editable suggestion only), not data corruption.
  - Two spec-mandated backend tests for `suggest_sequence_name` were never
    written (different-day reset, cross-procedure independence) — the
    second would have caught the collision above.
  - Photo-batch upload has no file-count/size limit and reads every file
    fully into memory before writing any — fine for this internal tool's
    current scale, worth a cap before wider use.
  - `MediaLibraryTable` shows a raw `procedure_id` instead of a resolved
    name — this is a plan/brief defect, not an execution one: the design
    spec doesn't call for a Procedure column on this table at all, so the
    brief added an extra column and under-specified how to resolve it.
  - `MediaPage.tsx`'s `min-h-screen` reintroduces the double-scroll bug
    commit `d6b36f4` already fixed once for `AppLayout` — should be
    `min-h-full`.
  - `PhotosUploadFlow` shows one page-level error instead of the
    spec-mandated per-file inline error next to each thumbnail; the
    backend already returns the failing filename, currently discarded.
  - Storage objects (MinIO) are never cleaned up when a video or sequence
    is deleted, despite `StorageService.delete` already existing — the
    design spec's original hedge on this gap assumed no delete method
    existed, which turned out not to hold.

### Phase 2d: Mask post-processing — DONE (2026-08-12)

Plan: [docs/superpowers/plans/2026-08-11-mask-postprocessing.md](docs/superpowers/plans/2026-08-11-mask-postprocessing.md),
spec: [docs/superpowers/specs/2026-08-11-mask-postprocessing-design.md](docs/superpowers/specs/2026-08-11-mask-postprocessing-design.md).

OpenCV-based cleanup (opening, closing, largest-connected-component,
Gaussian contour smoothing) for SAM2 mask output, with a per-mask
adjustable strength slider that re-applies instantly on the CPU without
re-running SAM2. `ml-worker` still writes only the raw SAM2 mask, now
alongside a new `Annotation.raw_mask_storage_key`; `backend` owns the one
canonical `postprocess_mask()` and applies it automatically once on job
success (default strength from `PlatformSettings.mask_postprocess_strength`,
admin-editable on the Settings page) and on demand via
`PATCH /annotation/annotations/{id}/mask-postprocess`. A `ToolsPanel`
slider lets a user override the default before running Predict/Track for
the current session. Executed via `superpowers:subagent-driven-development`
across 9 tasks (8 implementation + Task 9 real-browser E2E verification),
each independently committed to a dedicated worktree, fast-forward merged
into master once verification passed.

### Phase 2e: Sequence grid Rank Quality / Find Similar — DONE (2026-08-12)

Plan: [docs/superpowers/plans/2026-08-12-sequence-grid-quality-similarity-suggestions.md](docs/superpowers/plans/2026-08-12-sequence-grid-quality-similarity-suggestions.md),
spec: [docs/superpowers/specs/2026-08-12-sequence-grid-quality-similarity-suggestions-design.md](docs/superpowers/specs/2026-08-12-sequence-grid-quality-similarity-suggestions-design.md).

Two new `ml-worker` adapters — `QualityAdapter` (TOPIQ no-reference quality
score, OpenCV Laplacian-variance fallback) and `SimilarityAdapter` (DINOv2
ViT-B/14 embeddings) — power two new sequence-grid toolbar actions. Rank
Quality auto-checks the worst N% of frames by quality score. Find Similar
clusters near-duplicate frames via Union-Find over embedding distance,
keeps the best-quality frame per cluster unchecked, and auto-marks the
rest for deletion; both re-runs are idempotent and non-destructive of a
pre-existing manual selection. Both jobs evict every model family they
don't own at task start (a discipline that predates this phase, driven by
this GPU's history of VRAM-related host crashes) — the final-review pass
caught `run_find_similar` missing `_evict_quality_models()`, fixed in
`d94a693`. Executed via `superpowers:subagent-driven-development` across
11 tasks, each independently committed to a dedicated worktree, fast-
forward merged into master once verification passed.

**Deviation from the plan, decided during execution:** the pause between
sessions (host shutdown) surfaced an unrelated, pre-existing problem: the
real `ml-worker` Docker container was crash-looping in production
(`ModuleNotFoundError: pkg_resources`), caused by an earlier unpinned
rebuild picking up `setuptools>=81`, which dropped the `pkg_resources`
compatibility shim that `sam3`'s `model_builder.py` imports at module load
time. Fixed by pinning `setuptools<81` in `ml-worker/pyproject.toml`
(`fb16238`) and confirmed via a full, real image rebuild after the pause:
`setuptools==78.1.0`, `torch==2.7.1+cu126`, `torchvision==0.22.1+cu126` —
pin holds, no version drift on the CUDA pair, container reaches Celery
`ready` state and stays up.

**Deviations from the plan, decided during execution:**

- The implementation session doing Task 9's manual E2E verification was
  interrupted by a hard system crash (~21:50/21:58 on 2026-08-11) — likely
  the still-open [[project_sam2_vram_crash_open_issue]] VRAM issue,
  triggered by Track. No work was lost: all 8 implementation tasks were
  already committed to the `worktree-mask-postprocessing` git worktree
  (chat history is not the source of truth for committed code). Task 9 was
  resumed and completed across two sessions (2026-08-11 and 2026-08-12).
- Track was deliberately exercised during Task 9 with `backward=0,
  forward=2` (summing to 2 frames) instead of the platform's default cap
  of 10, specifically to avoid re-triggering the VRAM crash while
  confirming Track still works with post-processing wired in — not a
  permanent change to `max_track_range_frames`. Completed in ~3.6s with
  VRAM staying at ~2.3-2.4 GiB / 7.6 GiB, no crash.
- Task 9 Step 6 (confirm SAM3 unaffected) could not be executed — SAM-3 is
  unreachable on this GPU (RTX 2070/Turing, insufficient VRAM), consistent
  with Phase 2a.2's own scope note. All other Task 9 steps (default
  post-processing on Predict, live per-mask slider re-apply confirmed via
  DB read-back, ToolsPanel default affecting only the next Predict and not
  existing masks, Settings page round-trip for both admin and non-admin)
  passed against the real running stack per `CLAUDE.md`'s testing
  philosophy.

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
