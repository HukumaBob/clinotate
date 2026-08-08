# SAM2 GPU OOM Host-Crash Prevention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent SAM2 video tracking from exhausting GPU VRAM badly enough
to reboot the host machine, by adding a hard per-process VRAM cap, a
tracking-range limit, and a pre-flight memory estimate.

**Architecture:** Three independent layers, from outermost (cheapest,
least precise) to innermost (last-resort, guaranteed): (1) a request-range
cap in the Pydantic schema and the React tracking controls, (2) a
pre-flight VRAM estimate in the Celery task before `propagate_in_video` is
called, (3) a hard `torch.cuda.set_per_process_memory_fraction` ceiling set
once at `ml-worker` process startup, which converts any VRAM overrun that
slips past layers 1-2 into an ordinary in-process `torch.cuda.OutOfMemoryError`
that the existing `_restart_worker_process_after_track_failure()` recovery
path already handles.

**Tech Stack:** FastAPI + Pydantic v2 (backend), Celery + PyTorch/CUDA
(ml-worker), React + Zustand (frontend). See
`docs/superpowers/specs/2026-08-08-sam2-gpu-oom-host-crash-design.md` for
the full design rationale.

## Global Constraints

- Language: English only in code, comments, docstrings, UI copy — no
  Russian in committed content.
- TDD: every task below writes a failing test before the implementation.
- `taxonomy_version` / storage / API-contract rules from `CLAUDE.md` are
  not touched by this plan — no schema fields beyond the ones listed below
  are added.
- SAM3 tracking (`run_sam3_track`/`Sam3TrackRequest`) is out of scope per
  the design doc — do not add a range cap or pre-flight check there. Only
  Layer 3 (the process-wide VRAM fraction, Task 1) applies to it, and that
  requires no SAM3-specific code.
- The per-process VRAM fraction is **0.8** (of 8192 MiB on the dev GPU),
  leaving ~1.6 GiB for the desktop session (Xorg/gnome-shell/browser) that
  shares this GPU — confirmed with the user, do not change this constant
  without asking.
- The combined tracking-range cap is **20 frames** (`backward + forward <= 20`)
  — confirmed with the user as a starting value.

---

### Task 1: Hard per-process VRAM cap at ml-worker startup

**Files:**
- Modify: `ml-worker/app/celery_app.py`
- Test: `ml-worker/tests/test_celery_app.py` (new)

**Interfaces:**
- Produces: a module-level call to `torch.cuda.set_per_process_memory_fraction(0.8)`
  executed exactly once when `app.celery_app` is imported, guarded so it
  never raises when no CUDA device is present (e.g. running unit tests on
  a host without a GPU).

This must run before any adapter lazily initializes a CUDA context
(`Sam2Adapter`/`Sam3Adapter` construct predictors lazily inside
`app.tasks`, which this same module already imports at the bottom) — so
the fraction call belongs in `celery_app.py`, before the `from app import
tasks` import at the bottom of the file.

- [ ] **Step 1: Write the failing test**

Create `ml-worker/tests/test_celery_app.py`:

```python
from unittest.mock import patch


def test_set_per_process_memory_fraction_called_on_import_when_cuda_available():
    """celery_app.py must cap this process's VRAM usage at import time, so
    that even a first task can never grow past the fraction -- see
    docs/superpowers/specs/2026-08-08-sam2-gpu-oom-host-crash-design.md.
    Reload the module under mocks so the assertion doesn't depend on
    whether it was already imported earlier in the test session."""
    import importlib

    import app.celery_app as celery_app_module

    with (
        patch("torch.cuda.is_available", return_value=True),
        patch("torch.cuda.set_per_process_memory_fraction") as mock_set_fraction,
    ):
        importlib.reload(celery_app_module)

    mock_set_fraction.assert_called_once_with(0.8)

    # Restore the module to its normal (non-mocked) state for later tests.
    importlib.reload(celery_app_module)


def test_set_per_process_memory_fraction_skipped_when_cuda_unavailable():
    """On a host with no GPU (e.g. CI running only the non-GPU unit tests),
    importing celery_app.py must not raise."""
    import importlib

    import app.celery_app as celery_app_module

    with (
        patch("torch.cuda.is_available", return_value=False),
        patch("torch.cuda.set_per_process_memory_fraction") as mock_set_fraction,
    ):
        importlib.reload(celery_app_module)

    mock_set_fraction.assert_not_called()

    importlib.reload(celery_app_module)
```

- [ ] **Step 2: Run test to verify it fails**

Run (inside the ml-worker container/venv):
```bash
docker cp ml-worker/tests/test_celery_app.py <ml-worker-container>:/app/tests/test_celery_app.py
docker compose exec ml-worker pytest tests/test_celery_app.py -v
```
Expected: FAIL — `set_per_process_memory_fraction` was never called (no
such call exists in `celery_app.py` yet).

- [ ] **Step 3: Write minimal implementation**

Edit `ml-worker/app/celery_app.py`:

```python
from celery import Celery
import torch

from app.config import get_worker_settings

settings = get_worker_settings()

celery_app = Celery(
    "endoscopy_platform_worker",
    broker=settings.redis_url,
    backend=settings.redis_url,
)
celery_app.conf.task_serializer = "json"
celery_app.conf.result_serializer = "json"
celery_app.conf.accept_content = ["json"]

# Hard ceiling on this process's own VRAM allocations, independent of any
# request-level or pre-flight heuristic (see
# docs/superpowers/specs/2026-08-08-sam2-gpu-oom-host-crash-design.md):
# this GPU is shared with the desktop session (Xorg/gnome-shell/browser),
# and letting a single tracking job grow unbounded has previously exhausted
# VRAM badly enough to reboot the host. 0.8 leaves ~1.6 GiB of this GPU's
# 8 GiB for the desktop. Once this fraction is hit, PyTorch raises
# torch.cuda.OutOfMemoryError instead of continuing to allocate -- an
# ordinary Python exception the existing track() failure handling in
# app/tasks.py already recovers from via a worker process restart.
if torch.cuda.is_available():
    torch.cuda.set_per_process_memory_fraction(0.8)

# tasks.py defines the @celery_app.task-decorated sam3_predict/sam3_track
# tasks against this same app instance; importing it here is what actually
# registers them with the worker (celery_app.worker_main only imports this
# module by name, never tasks.py on its own).
from app import tasks  # noqa: E402,F401
```

- [ ] **Step 4: Run test to verify it passes**

```bash
docker compose exec ml-worker pytest tests/test_celery_app.py -v
```
Expected: PASS (both tests).

- [ ] **Step 5: Run the full ml-worker test suite to check for regressions**

```bash
docker compose exec ml-worker pytest -v
```
Expected: all tests that were passing before still pass (GPU-weight-gated
tests remain skipped per `conftest.py`, as before).

- [ ] **Step 6: Commit**

```bash
git add ml-worker/app/celery_app.py ml-worker/tests/test_celery_app.py
git commit -m "feat: cap ml-worker process VRAM at 80% of GPU memory

Converts an unbounded VRAM overrun (previously observed to reboot the
host) into an in-process torch.cuda.OutOfMemoryError that the existing
track-failure recovery path already handles."
```

---

### Task 2: Empirically verify the VRAM cap triggers a controlled failure

**Files:**
- None created or modified — this is a manual verification step using a
  temporary local override, run against the real dev stack. No test file,
  because this step is inherently a real-GPU integration check that CI
  cannot run (mirrors this repo's existing "drive the real stack once"
  testing philosophy in `CLAUDE.md`).

**Interfaces:**
- Consumes: Task 1's `torch.cuda.set_per_process_memory_fraction(0.8)` call
  in `ml-worker/app/celery_app.py`.

This task validates, on the real GPU, that lowering the fraction reliably
produces a **controlled** `torch.cuda.OutOfMemoryError` (not a host
crash), and that `_restart_worker_process_after_track_failure()` correctly
brings the container back up afterward — without ever approaching real
VRAM exhaustion. The user explicitly signed off on this approach (lower
the fraction artificially) instead of crashing the host on purpose.

- [ ] **Step 1: Temporarily lower the fraction for a manual test**

Edit `ml-worker/app/celery_app.py` locally (do NOT commit this change):
change `0.8` to `0.02` (roughly 160 MiB on this 8 GiB card — well below
what even a single SAM2 frame requires, so `init_state()`/`propagate_in_video()`
is guaranteed to overflow it).

- [ ] **Step 2: Rebuild and restart the ml-worker container**

```bash
docker compose build ml-worker
docker compose up -d ml-worker
docker compose logs -f ml-worker
```
Leave the log stream open in this terminal to watch what happens next.

- [ ] **Step 3: Trigger a real SAM2 track job from the running frontend/backend**

With the full stack up (`docker compose up -d`, backend on :8000, frontend
on :5173 per `CLAUDE.md`), open a sequence in the frame editor, place a
prompt, and click Track with a small range (e.g. backward=2, forward=2).

- [ ] **Step 4: Confirm the expected controlled-failure sequence in the logs**

Expected, in order, in the `docker compose logs -f ml-worker` output:
1. A `torch.cuda.OutOfMemoryError` (or a CUDA OOM message wrapped in
   whatever exception type PyTorch raises for it) logged from inside
   `run_sam2_track`.
2. The job row's `status` becoming `FAILED` with a non-empty `error` field
   (confirm via `GET /jobs/{id}` from the frontend — the job should show
   as failed in the UI, not hang).
3. The `ml-worker` container process exiting (`os._exit(1)` from
   `_restart_worker_process_after_track_failure`) and Docker restarting it
   (`restart: unless-stopped`) — visible as the container's log stream
   restarting from its startup banner.
4. The host machine itself must **not** reboot, hang, or show any signs of
   GPU driver distress (check `nvidia-smi` still responds normally after
   the restart).

If any of these does not happen as expected (e.g. the container doesn't
come back, or a second track attempt right after also fails), treat it as
a genuine finding — do not proceed to Task 3 until this recovery path is
confirmed solid, since this is the safety net every other layer in this
plan relies on.

- [ ] **Step 5: Revert the temporary fraction change**

```bash
git diff ml-worker/app/celery_app.py
```
Confirm the only diff is the `0.02` you introduced in Step 1, then:
```bash
git checkout ml-worker/app/celery_app.py
docker compose build ml-worker
docker compose up -d ml-worker
```
This restores the real `0.8` fraction committed in Task 1.

- [ ] **Step 6: No commit for this task**

This task is a verification exercise; nothing should be committed (the
fraction override was reverted in Step 5). Proceed to Task 3.

---

### Task 3: Backend range cap on `Sam2TrackRequest`

**Files:**
- Modify: `backend/app/jobs/schemas.py`
- Test: `backend/tests/test_jobs.py`

**Interfaces:**
- Produces: `Sam2TrackRequest` raises a Pydantic `ValidationError` when
  `backward < 0`, `forward < 0`, or `backward + forward > 20`.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_jobs.py` (near the existing
`Sam2TrackRequest`-related tests found around line 267):

```python
def test_sam2_track_request_rejects_combined_range_over_twenty():
    from pydantic import ValidationError

    from app.jobs.schemas import PromptIn, Sam2TrackRequest

    with pytest.raises(ValidationError):
        Sam2TrackRequest(
            sequence_id=1,
            label_id=1,
            prompts=[PromptIn(type="point", coords=[0.5, 0.5], label=True)],
            anchor_frame_id=10,
            backward=15,
            forward=6,
        )


def test_sam2_track_request_accepts_combined_range_at_twenty():
    from app.jobs.schemas import PromptIn, Sam2TrackRequest

    request = Sam2TrackRequest(
        sequence_id=1,
        label_id=1,
        prompts=[PromptIn(type="point", coords=[0.5, 0.5], label=True)],
        anchor_frame_id=10,
        backward=10,
        forward=10,
    )
    assert request.backward == 10
    assert request.forward == 10


def test_sam2_track_request_rejects_negative_backward():
    from pydantic import ValidationError

    from app.jobs.schemas import PromptIn, Sam2TrackRequest

    with pytest.raises(ValidationError):
        Sam2TrackRequest(
            sequence_id=1,
            label_id=1,
            prompts=[PromptIn(type="point", coords=[0.5, 0.5], label=True)],
            anchor_frame_id=10,
            backward=-1,
            forward=5,
        )
```

Check the top of `backend/tests/test_jobs.py` for an existing `import
pytest` — add one if it's not already imported.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd backend && uv run pytest tests/test_jobs.py -k "combined_range or negative_backward" -v
```
Expected: FAIL — `test_sam2_track_request_rejects_combined_range_over_twenty`
and `test_sam2_track_request_rejects_negative_backward` fail because no
validation currently rejects these values (the accept-at-20 test passes
trivially since there's no upper bound yet, but keep it — it locks in the
boundary once the validator exists).

- [ ] **Step 3: Write minimal implementation**

Edit `backend/app/jobs/schemas.py`:

```python
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.jobs.models import JobStatus, JobType

# ... (MAX_MASK_PNG_BASE64_LENGTH and JobRead/PromptIn unchanged) ...

# See docs/superpowers/specs/2026-08-08-sam2-gpu-oom-host-crash-design.md:
# this GPU (8 GiB, shared with the desktop session) has reliably run out of
# VRAM and rebooted the host at tracking ranges as small as 20-30 frames.
# 20 is a deliberately conservative starting cap, not a measured safe
# maximum -- it may be revisited once the per-process VRAM fraction cap
# (ml-worker/app/celery_app.py) and the pre-flight estimate have more
# real-world data behind them.
MAX_TRACK_RANGE_FRAMES = 20


class Sam2TrackRequest(BaseModel):
    sequence_id: int
    label_id: int
    prompts: list[PromptIn]
    anchor_frame_id: int
    backward: int = Field(ge=0)
    forward: int = Field(ge=0)

    @model_validator(mode="after")
    def _validate_combined_range(self) -> "Sam2TrackRequest":
        if self.backward + self.forward > MAX_TRACK_RANGE_FRAMES:
            raise ValueError(
                f"backward + forward must not exceed {MAX_TRACK_RANGE_FRAMES} frames "
                f"(got {self.backward + self.forward}) -- see "
                "docs/superpowers/specs/2026-08-08-sam2-gpu-oom-host-crash-design.md"
            )
        return self
```

Note: `Field(ge=0)` replaces the bare `backward: int`/`forward: int`
declarations — keep every other field in the file unchanged.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd backend && uv run pytest tests/test_jobs.py -k "combined_range or negative_backward" -v
```
Expected: PASS (all three tests).

- [ ] **Step 5: Run the full backend job test suite to check for regressions**

```bash
cd backend && uv run pytest tests/test_jobs.py -v
```
Expected: all tests pass, including the pre-existing
`Sam2TrackRequest(sequence_id=1, label_id=1, prompts=[])` missing-fields
test around line 270 (that test omits `backward`/`forward` entirely and
expects a `ValidationError` for the missing `prompts` content — confirm
it still fails for that reason, not a new one).

- [ ] **Step 6: Regenerate the OpenAPI schema**

Per `CLAUDE.md`, any backend schema change requires regenerating
`openapi.json`:
```bash
cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py
git diff --stat openapi.json
```
Confirm `openapi.json` shows a diff (the new `minimum: 0` constraints and
range validator should appear in the schema).

- [ ] **Step 7: Commit**

```bash
git add backend/app/jobs/schemas.py backend/tests/test_jobs.py openapi.json
git commit -m "feat: cap SAM2 tracking range at 20 combined frames

backward + forward > 20 is rejected with a 422 before the job is even
enqueued, as the first (cheapest, least precise) layer of defense
against the GPU VRAM exhaustion documented in
docs/superpowers/specs/2026-08-08-sam2-gpu-oom-host-crash-design.md."
```

---

### Task 4: Frontend range cap in TrackControls and FrameEditor

**Files:**
- Modify: `frontend/src/features/annotation/TrackControls.tsx`
- Modify: `frontend/src/features/annotation/FrameEditor.tsx:81-101`
- Test: `frontend/src/features/annotation/TrackControls.test.tsx` (new, or
  extend an existing test file if one already covers this component —
  check `frontend/src/features/annotation/` for a matching `*.test.tsx`
  before creating a new file)

**Interfaces:**
- Consumes: no new props beyond what `TrackControls` already receives
  (`store`, `onTrack`, `maxBackward`, `maxForward`).
- Produces: `TrackControls` never lets `backward + forward` exceed 20 —
  the "Max backward"/"Max forward" buttons clamp to the remaining budget
  (`20 - forward`/`20 - backward`) rather than the full sequence-relative
  `maxBackward`/`maxForward`, and manual number-input edits are clamped
  the same way via each `onChange` handler.

- [ ] **Step 1: Check for an existing test file**

```bash
ls frontend/src/features/annotation/ | grep -i trackcontrols
```
If `TrackControls.test.tsx` already exists, add the new tests there
instead of creating a duplicate file; otherwise create it fresh in Step 2.

- [ ] **Step 2: Write the failing test**

Create (or extend) `frontend/src/features/annotation/TrackControls.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createFrameEditorStore } from "./frameEditorStore";
import { TrackControls } from "./TrackControls";

function renderControls(overrides: Partial<{ maxBackward: number; maxForward: number }> = {}) {
  const store = createFrameEditorStore();
  const onTrack = vi.fn();
  render(
    <TrackControls
      store={store}
      onTrack={onTrack}
      maxBackward={overrides.maxBackward ?? 50}
      maxForward={overrides.maxForward ?? 50}
    />,
  );
  return { store };
}

describe("TrackControls combined-range cap", () => {
  it("clamps 'Max backward' to leave room under the 20-frame combined cap", () => {
    const { store } = renderControls();
    store.getState().setForward(15);

    fireEvent.click(screen.getByLabelText("Max backward"));

    // 20 - forward(15) = 5, even though maxBackward (sequence-relative) is 50.
    expect(store.getState().backward).toBe(5);
  });

  it("clamps 'Max forward' to leave room under the 20-frame combined cap", () => {
    const { store } = renderControls();
    store.getState().setBackward(18);

    fireEvent.click(screen.getByLabelText("Max forward"));

    expect(store.getState().forward).toBe(2);
  });

  it("clamps manual backward input so backward + forward never exceeds 20", () => {
    const { store } = renderControls();
    store.getState().setForward(12);

    const backwardInput = screen.getByLabelText(/backward/i, { selector: "input" });
    fireEvent.change(backwardInput, { target: { value: "30" } });

    expect(store.getState().backward).toBe(8);
  });

  it("clamps manual forward input so backward + forward never exceeds 20", () => {
    const { store } = renderControls();
    store.getState().setBackward(19);

    const forwardInput = screen.getByLabelText(/forward/i, { selector: "input" });
    fireEvent.change(forwardInput, { target: { value: "30" } });

    expect(store.getState().forward).toBe(1);
  });
});
```

If `createFrameEditorStore` is not the actual factory export name, check
`frontend/src/features/annotation/frameEditorStore.ts` for the real export
used to construct a fresh store instance for tests, and use that name
instead — do not guess if it differs from what other test files in this
directory already use (grep for `frameEditorStore` imports in existing
`*.test.tsx` files in the same directory for the established pattern).

- [ ] **Step 3: Run test to verify it fails**

```bash
cd frontend && npm run test -- TrackControls.test.tsx
```
Expected: FAIL — all four new tests fail because `TrackControls` currently
clamps to `maxBackward`/`maxForward` only, not the 20-frame combined cap.

- [ ] **Step 4: Write minimal implementation**

Edit `frontend/src/features/annotation/TrackControls.tsx`:

```tsx
import { useStore } from "zustand/react";

import type { FrameEditorStore } from "./frameEditorStore";

interface TrackControlsProps {
  store: FrameEditorStore;
  onTrack: () => void;
  // Number of frames available in each direction from the current frame
  // within its sequence -- backing the "Max" shortcut buttons below.
  maxBackward: number;
  maxForward: number;
}

// See docs/superpowers/specs/2026-08-08-sam2-gpu-oom-host-crash-design.md:
// backward + forward must never exceed this, independent of how many
// frames are actually available in the sequence, to keep SAM2 tracking
// jobs within the GPU VRAM budget this GPU can safely handle. Mirrors
// MAX_TRACK_RANGE_FRAMES in backend/app/jobs/schemas.py -- keep both in
// sync if this value ever changes.
const MAX_COMBINED_TRACK_RANGE = 20;

export function TrackControls({ store, onTrack, maxBackward, maxForward }: TrackControlsProps) {
  const backward = useStore(store, (state) => state.backward);
  const forward = useStore(store, (state) => state.forward);
  const setBackward = useStore(store, (state) => state.setBackward);
  const setForward = useStore(store, (state) => state.setForward);
  const labelTagId = useStore(store, (state) => state.labelTagId);
  const pendingPrompts = useStore(store, (state) => state.pendingPrompts);
  const trackDisabled = labelTagId === null || pendingPrompts.length === 0;

  const backwardBudget = Math.max(0, MAX_COMBINED_TRACK_RANGE - forward);
  const forwardBudget = Math.max(0, MAX_COMBINED_TRACK_RANGE - backward);

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <label className="flex-1 text-xs text-gray-400">
          Backward
          <div className="mt-1 flex gap-1">
            <input
              type="number"
              min={0}
              max={backwardBudget}
              value={backward}
              onChange={(event) => setBackward(Math.min(Number(event.target.value), backwardBudget))}
              className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100"
            />
            <button
              type="button"
              aria-label="Max backward"
              onClick={() => setBackward(Math.min(maxBackward, backwardBudget))}
              className="shrink-0 rounded border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            >
              Max
            </button>
          </div>
        </label>
        <label className="flex-1 text-xs text-gray-400">
          Forward
          <div className="mt-1 flex gap-1">
            <input
              type="number"
              min={0}
              max={forwardBudget}
              value={forward}
              onChange={(event) => setForward(Math.min(Number(event.target.value), forwardBudget))}
              className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100"
            />
            <button
              type="button"
              aria-label="Max forward"
              onClick={() => setForward(Math.min(maxForward, forwardBudget))}
              className="shrink-0 rounded border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200"
            >
              Max
            </button>
          </div>
        </label>
      </div>
      <p className="text-xs text-gray-500">
        Combined backward + forward is capped at {MAX_COMBINED_TRACK_RANGE} frames to protect GPU memory.
      </p>
      <button
        type="button"
        disabled={trackDisabled}
        onClick={onTrack}
        className="w-full rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Track
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd frontend && npm run test -- TrackControls.test.tsx
```
Expected: PASS (all four new tests, plus any pre-existing tests in the
same file).

- [ ] **Step 6: Fix FrameEditor's forward default so it respects the cap too**

`FrameEditor.tsx:96` currently does `store.getState().setForward(maxForward)`
on every frame change — on a sequence with more than 20 frames ahead, this
sets `forward` above the cap before the user touches anything, and
`TrackControls`'s clamped `onChange` won't fix a value set directly via
`setForward`. Edit `frontend/src/features/annotation/FrameEditor.tsx`
around line 96:

```tsx
  useEffect(() => {
    store.getState().resetForNewFrame();
    // Capped at the same combined-range limit TrackControls enforces (see
    // docs/superpowers/specs/2026-08-08-sam2-gpu-oom-host-crash-design.md)
    // -- otherwise a sequence with >20 frames ahead would default forward
    // above the cap before the user touches either input.
    store.getState().setForward(Math.min(maxForward, 20));
    // maxForward intentionally excluded: it's a pure function of frameId
    // (via currentIndex) here, so including it would double-fire this
    // effect on every render where it's recomputed as the same value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameId, store]);
```

- [ ] **Step 7: Run the full frontend test suite to check for regressions**

```bash
cd frontend && npm run test
```
Expected: all tests pass, including any existing `FrameEditor.test.tsx`
coverage of the forward-default behavior (if such a test asserts
`forward === maxForward` on a short sequence, it should still pass since
`Math.min(maxForward, 20) === maxForward` whenever the sequence has 20 or
fewer frames ahead).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/features/annotation/TrackControls.tsx \
        frontend/src/features/annotation/TrackControls.test.tsx \
        frontend/src/features/annotation/FrameEditor.tsx
git commit -m "feat: clamp SAM2 tracking range to 20 combined frames in the UI

Mirrors the backend's Sam2TrackRequest validator so users get instant
feedback instead of a 422 after clicking Track."
```

---

### Task 5: Pre-flight VRAM estimate in `run_sam2_track`

**Files:**
- Modify: `ml-worker/app/tasks.py`
- Test: `ml-worker/tests/test_tasks_sam2.py`

**Interfaces:**
- Consumes: `torch.cuda.mem_get_info()` (already used by
  `_record_vram_usage`, same module).
- Produces: a new module-level function
  `_estimate_track_vram_bytes(frame_count: int, width: int, height: int) -> int`
  in `ml-worker/app/tasks.py`, and a pre-flight check inside
  `run_sam2_track` that marks the job `FAILED` (with a clear `job.error`
  message) and returns *before* calling `resolved_adapter.track(...)` when
  the estimate plus a safety margin exceeds free VRAM.

The calibration constant inside `_estimate_track_vram_bytes` is a rough
heuristic, not a precise physical model — its only job is to catch
obviously-oversized requests before spending time on them; Task 1's
process-wide fraction cap is what actually guarantees safety. Use a
generous, clearly-labeled placeholder constant derived from the numbers
already in this codebase: `docs/superpowers/specs/2026-08-05-gpu-vram-gauge-design.md`
and this task's own docstring should note the constant needs recalibration
once real `vram_used_bytes` data exists for a range of frame
counts/resolutions — but a concrete starting value is still required (see
below), not a TODO.

- [ ] **Step 1: Write the failing test**

Add to `ml-worker/tests/test_tasks_sam2.py`:

```python
def test_estimate_track_vram_bytes_scales_with_frame_count_and_resolution():
    from app.tasks import _estimate_track_vram_bytes

    small = _estimate_track_vram_bytes(frame_count=5, width=800, height=640)
    large = _estimate_track_vram_bytes(frame_count=20, width=1920, height=1080)

    assert small > 0
    assert large > small


def test_run_sam2_track_fails_fast_without_calling_adapter_when_vram_insufficient():
    """When the pre-flight estimate exceeds free VRAM (with margin), the
    job must fail immediately and resolved_adapter.track() must never be
    called -- the whole point of this check is to avoid spending GPU time
    on a request already known to be too big."""
    fake_adapter = MagicMock()

    mock_session = MagicMock()
    mock_job = MagicMock(
        payload={
            "sequence_id": 10, "label_id": 2, "prompts": [],
            "anchor_frame_id": 101, "backward": 5, "forward": 5,
        },
        created_by_id=1,
    )
    mock_label = MagicMock(id=2, taxonomy_version=3)

    all_frames = [
        MagicMock(id=100 + i, frame_index=i, storage_key=f"frames/{100+i}.png")
        for i in range(11)
    ]

    def get_side_effect(model, pk):
        from app.models import Job
        if model is Job:
            return mock_job
        return None

    mock_session.get.side_effect = get_side_effect
    mock_session.query.return_value.filter.return_value.order_by.return_value.all.return_value = all_frames

    # A tiny 1x1 PNG so Image.open(...).size works without a real frame download.
    import io as _io

    from PIL import Image as _Image

    tiny_png = _io.BytesIO()
    _Image.new("RGB", (1920, 1080)).save(tiny_png, format="PNG")
    tiny_png_bytes = tiny_png.getvalue()

    with (
        patch.object(tasks_module, "_get_default_sam2_adapter", return_value=fake_adapter),
        patch.object(tasks_module, "_evict_sam3_models"),
        patch.object(tasks_module, "_load_label", return_value=mock_label),
        patch("app.tasks.SessionLocal", return_value=mock_session),
        patch("app.tasks.get_storage_service") as mock_get_storage,
        # Almost no free VRAM: 1 MiB free out of 8 GiB total.
        patch("torch.cuda.mem_get_info", return_value=(1_048_576, 8_589_934_592)),
    ):
        mock_get_storage.return_value.download.return_value = tiny_png_bytes
        tasks_module.run_sam2_track(job_id=1)

    fake_adapter.track.assert_not_called()
    assert mock_job.status == "failed"
    assert mock_job.error
```

- [ ] **Step 2: Run test to verify it fails**

```bash
docker compose exec ml-worker pytest tests/test_tasks_sam2.py -k "estimate_track_vram or fails_fast" -v
```
Expected: FAIL — `_estimate_track_vram_bytes` doesn't exist yet, and
`run_sam2_track` currently always calls `resolved_adapter.track(...)`
regardless of free VRAM.

- [ ] **Step 3: Write minimal implementation**

Edit `ml-worker/app/tasks.py`. Add the estimate function near
`_record_vram_usage` (both are VRAM-bookkeeping helpers):

```python
# Rough calibration: SAM2's video predictor keeps a resized copy of every
# tracked frame (plus internal feature maps) resident in VRAM for the
# duration of propagate_in_video(). This constant is a conservative
# starting estimate, not a measured physical model -- see
# docs/superpowers/specs/2026-08-08-sam2-gpu-oom-host-crash-design.md's
# "Open items" section. Recalibrate by comparing this estimate against the
# actual vram_used_bytes _record_vram_usage() reports for a real tracking
# job of known frame_count/width/height, then update this constant.
_TRACK_VRAM_BYTES_PER_PIXEL_PER_FRAME = 40


def _estimate_track_vram_bytes(frame_count: int, width: int, height: int) -> int:
    """Rough upper-bound estimate of the VRAM a run_sam2_track() call will
    need, used only as a cheap pre-flight check to reject obviously
    oversized requests before spending time loading frames and starting a
    SAM2 video session. Not a substitute for the hard per-process VRAM
    cap set in celery_app.py, which is what actually guarantees safety if
    this estimate is wrong."""
    return frame_count * width * height * _TRACK_VRAM_BYTES_PER_PIXEL_PER_FRAME


# Fraction of currently-free VRAM the estimate must fit under, leaving
# headroom for the safety margin discussed in the design doc.
_TRACK_VRAM_SAFETY_MARGIN = 0.7
```

Then edit `run_sam2_track` to add the pre-flight check right after frames
are loaded and before `resolved_adapter.track(...)` is called:

```python
    try:
        sequence_id = job.payload["sequence_id"]
        label_id = job.payload["label_id"]
        prompts = job.payload["prompts"]
        anchor_frame_id = job.payload["anchor_frame_id"]
        backward = job.payload["backward"]
        forward = job.payload["forward"]
        frames = session.query(Frame).filter(Frame.sequence_id == sequence_id).order_by(Frame.frame_index).all()
        label = _load_label(session, label_id)

        anchor_index = next(i for i, f in enumerate(frames) if f.id == anchor_frame_id)
        frame_bytes_list = [storage.download(f.storage_key) for f in frames]

        tracked_frame_count = min(len(frames), backward + forward + 1)
        first_frame_image = Image.open(io.BytesIO(frame_bytes_list[0]))
        estimated_bytes = _estimate_track_vram_bytes(
            frame_count=tracked_frame_count,
            width=first_frame_image.width,
            height=first_frame_image.height,
        )
        free_bytes, _total_bytes = torch.cuda.mem_get_info()
        if estimated_bytes > free_bytes * _TRACK_VRAM_SAFETY_MARGIN:
            raise RuntimeError(
                f"Estimated GPU memory required ({estimated_bytes} bytes) exceeds the "
                f"safe available budget ({int(free_bytes * _TRACK_VRAM_SAFETY_MARGIN)} bytes "
                f"of {free_bytes} free) -- try a smaller tracking range."
            )

        results = resolved_adapter.track(frame_bytes_list, prompts, anchor_index, backward, forward)
```

This requires adding `import io` and `from PIL import Image` to the top of
`ml-worker/app/tasks.py` (check they aren't already imported before
adding — they currently are not, per the file read earlier in this plan).
Raising `RuntimeError` here means it's caught by the existing `except
Exception as exc:` block below, which already sets `job.status =
JobStatus.FAILED` and `job.error = str(exc)` — no changes needed to the
except block itself. Note this failure path does **not** call
`_restart_worker_process_after_track_failure()`, because no GPU work was
attempted — restarting the worker here would be pure overhead for a
failure that has nothing to do with corrupted CUDA allocator state.

- [ ] **Step 4: Run test to verify it passes**

```bash
docker compose exec ml-worker pytest tests/test_tasks_sam2.py -k "estimate_track_vram or fails_fast" -v
```
Expected: PASS (both new tests).

- [ ] **Step 5: Run the full ml-worker test suite to check for regressions**

```bash
docker compose exec ml-worker pytest -v
```
Expected: all previously-passing tests (including
`test_run_sam2_track_maps_results_to_correct_frame_window` and the VRAM
recording tests in the same file) still pass — those tests mock
`torch.cuda.mem_get_info` with plenty of free memory (2-4 GiB), which
comfortably clears the new pre-flight check for their small (2-3 frame)
fixtures.

- [ ] **Step 6: Commit**

```bash
git add ml-worker/app/tasks.py ml-worker/tests/test_tasks_sam2.py
git commit -m "feat: pre-flight VRAM estimate before SAM2 tracking starts

Rejects obviously oversized tracking requests before calling into SAM2
at all, as the second (best-effort) layer of defense described in
docs/superpowers/specs/2026-08-08-sam2-gpu-oom-host-crash-design.md."
```

---

## Post-plan manual verification (not a task — do this after all tasks land)

Per `CLAUDE.md`'s testing philosophy, exercise the real feature once
end-to-end before considering this done:

1. `docker compose up -d`, backend (`uv run uvicorn app.main:app --reload`),
   frontend (`npm run dev`), and the transcode worker if relevant.
2. Open a sequence with more than 20 frames ahead of some frame (e.g.
   `http://localhost:5173/sequences/1975` if it still has that many) in the
   frame editor.
3. Confirm the "Max forward"/"Max backward" buttons and manual input no
   longer allow a combined range over 20, and the UI shows the new
   explanatory note.
4. Attempt a track with a small, valid range (e.g. 5+5) and confirm it
   still succeeds normally — this plan must not have broken the working
   case.
5. Confirm `nvidia-smi` shows this GPU's usage staying under ~6.5 GiB
   (80% of 8 GiB) for `ml-worker`'s process throughout a track job.
