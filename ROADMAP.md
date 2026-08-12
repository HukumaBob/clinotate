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
