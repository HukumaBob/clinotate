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

### Phase 2a: Jobs infrastructure + SAM-3 segmentation (predict/track) — PLANNED, NOT STARTED

Plan: [docs/plans/2026-07-22-jobs-and-sam3.md](docs/plans/2026-07-22-jobs-and-sam3.md)

Scope, decided during planning on 2026-07-22: `jobs` domain (Celery + Redis,
already-provisioned Redis finally gets a consumer), a separate `ml-worker`
GPU-backed project (own `uv` environment, doesn't import `backend/app` —
tasks are coupled to the API only by Celery task name, not code import),
and a real `Sam3Adapter` covering `predict()` (point/box prompts on one
frame) and `track()` (mask propagation across a sequence). SAM-3's actual
Python API was verified directly against `facebookresearch/sam3`'s source
during planning (`add_geometric_prompt`, not a documented "point" method —
the public README only shows text prompts). Progress surfaces via TanStack
Query polling, not SSE (SSE deferred, human's explicit choice). SAM-3
text/exemplar prompts, all detection adapters (YOLO/RT-DETRv2/RF-DETR),
MLflow, datasets, and training are explicitly out of scope for this
sub-phase — see Phase 2b below.

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
