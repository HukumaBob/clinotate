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

### Phase 2b: Detection adapters, datasets, training — NOT STARTED, NOT PLANNED

Scope per the design spec: Ultralytics YOLO11/YOLO12/YOLO26 detection
adapters selectable per-job via `Job.payload`, RT-DETRv2 adapter, RF-DETR
adapter (interface-level stub, no working inference yet — human's explicit
call, see the spec correction above), MLflow experiment tracking, dataset
export, model training. No implementation plan written yet; depends on
Phase 2a's `jobs` infrastructure landing first.

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
