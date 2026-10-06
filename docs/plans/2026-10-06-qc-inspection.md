# QC Inspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the QC run view, let a person set a confidence threshold and a client-side NMS IoU, see flicker events and a confidence timeline strip with previous/next-event navigation, and read the model's latency, all computed from the stored predictions.

**Architecture:** The ml-worker records per-frame model timings and writes aggregate `timing` into the predictions document (no schema, API or migration change). Everything else is pure client-side TypeScript functions over the loaded document (`buildView`, `findFlickers`, `buildStrip`), plus small presentational components and a canvas strip, composed in `RunViewPage`.

**Tech Stack:** Python, OpenCV, Ultralytics (ml-worker); React 19, TypeScript, Vitest 4, Testing Library, TanStack Query v5 (frontend).

**Spec:** [docs/specs/2026-10-06-qc-inspection-design.md](../specs/2026-10-06-qc-inspection-design.md). Builds on sub-project 1 ([spec](../specs/2026-10-06-qc-inference-runs-design.md), implemented).

Two refinements made while turning the spec into code (Task 3 and Task 4 apply them and Task 7 records them in the spec): `buildStrip` returns `{ level, maxConfidence }` per bucket so the strip tooltip can show the maximum confidence the spec asks for, and the previous/next event buttons are disabled only when there are no events (clicking when no further event exists in that direction does nothing), because the current time is not part of page state.

## Global Constraints

- English only: code, comments, docstrings, UI copy, commit messages. No Russian in the repo.
- Work directly on `master`; no branches, no worktrees. Never commit `yolo_qc_playground_architecture.pdf` (untracked, the user's).
- Dark theme only; no light-background classes.
- Frontend API access only through `apiClient`; this plan adds none. Do not hand-edit `frontend/src/shared/api/generated/`.
- No schema, route, migration or `openapi.json` change anywhere in this plan.
- Parameter ranges (spec): Confidence 0.05 to 1.00 step 0.01 default 0.25; NMS IoU 0.30 to 0.70 step 0.05 default 0.70 labelled "off" at 0.70; Flicker window N 1 to 10 default 2. Persist in `localStorage` key `qc-view-params`, wrapped in try/catch, clamped on load.
- Keys: `[` previous event, `]` next event. Native arrows and space untouched; the letter `N` is reserved for sub-project 3.
- Strip bucket count equals the container width, capped at 1600; recomputation of view and events is deferred with `useDeferredValue`.
- A missing timing measurement never fails an inference run.
- ml-worker tests run inside the container: `docker compose up -d ml-worker`, `docker compose exec ml-worker rm -rf /app/tests`, `docker cp ml-worker/app/. endoscopy-platform-ml-worker-1:/app/app/` (copy the CONTENTS), `docker cp ml-worker/tests endoscopy-platform-ml-worker-1:/app/tests`, check nothing nested with `docker compose exec ml-worker ls /app/app /app/tests`, then `docker compose exec ml-worker uv run pytest <path> -v`. Those tests hit the dev database by design; every fixture must delete what it creates (verify with psql at the end of Task 1).
- Tests must never write to the real `endoscopy` DB (backend). Frontend tests: `cd frontend && npx vitest run <paths>` and `npx tsc --noEmit`; a red `npm run build` and a few failures elsewhere predate this work, only failures in files you touched are yours.
- Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` as a second `-m`.
- Do not start, stop or restart any dev server or touch ports unless the task says to. The stack may be running (backend :8000, frontend :5173).

## Review Focus

Inputs the spec implies but no happy-path test covers; each has a test in the named task.

1. A run without `timing` (every run made before this change, including #82) must show "Not recorded for this run" and never crash the panel or the page (Task 4).
2. A threshold above 0.7 must not paint a strip bucket green when its best detection is hidden by the threshold (Task 3).
3. A run where every frame is below the threshold, or with no detections at all, must produce an empty strip, no events and zero counts, not an error (Tasks 2 and 3).
4. Out-of-range, non-numeric or throwing `localStorage` values must fall back to valid defaults (Task 2).
5. A stride so coarse that "1-2 frames" means seconds must raise the coarse notice instead of presenting misleading flicker events (Tasks 3 and 4).
6. A model object whose `speed` is missing or malformed must still produce a successful run with no `timing` (Task 1).

## File Structure

Create:
- `ml-worker/app/inference_timing.py`, `ml-worker/tests/test_inference_timing.py`
- `frontend/src/features/qc/analysis/nms.ts`, `view.ts`, `params.ts`, `useViewParams.ts`, `flicker.ts`, `events.ts`, `strip.ts` and a `*.test.ts(x)` beside each
- `frontend/src/features/qc/DisplayPanel.tsx`, `LatencyPanel.tsx`, `EventNav.tsx` and a `*.test.tsx` beside each
- `frontend/src/features/qc/useVideoClock.ts`, `TimelineStrip.tsx`

Modify:
- `ml-worker/app/inference_adapter.py`, `ml-worker/app/ultralytics_inference_adapter.py`, `ml-worker/app/tasks.py`, `ml-worker/tests/test_ultralytics_inference_adapter.py`, `ml-worker/tests/test_tasks_inference.py`
- `frontend/src/features/qc/predictions.ts` (types), `PredictionOverlay.tsx`, `RunViewPage.tsx`
- `docs/specs/2026-10-06-qc-inspection-design.md`, `ROADMAP.md`

---

### Task 1: ml-worker records and writes timing aggregates

**Files:**
- Create: `ml-worker/app/inference_timing.py`
- Modify: `ml-worker/app/inference_adapter.py`, `ml-worker/app/ultralytics_inference_adapter.py`, `ml-worker/app/tasks.py`
- Test: `ml-worker/tests/test_inference_timing.py`, `ml-worker/tests/test_ultralytics_inference_adapter.py`, `ml-worker/tests/test_tasks_inference.py`

**Interfaces:**
- Produces: `summarize_timing(samples: list[dict]) -> dict | None` where each sample is `{"preprocess": ms, "inference": ms, "postprocess": ms}`; `InferenceResult.timing: dict | None = None`; the predictions document gains an optional top-level key `timing` shaped as in the spec (`frames_measured`, `preprocess_ms`, `inference_ms`, `postprocess_ms`, `total_ms` each `{mean, p50, p95, max}`, and `model_fps`). Task 2 mirrors this shape in TypeScript.

- [ ] **Step 1: Write the failing tests**

Create `ml-worker/tests/test_inference_timing.py`:

```python
import pytest

from app.inference_timing import summarize_timing


def _sample(pre, inf, post):
    return {"preprocess": pre, "inference": inf, "postprocess": post}


def test_no_samples_gives_none():
    assert summarize_timing([]) is None


def test_samples_missing_a_stage_are_ignored():
    assert summarize_timing([{"preprocess": 1.0, "inference": 2.0}]) is None
    assert summarize_timing([_sample("1", 2.0, 3.0)]) is None


def test_a_single_frame_is_kept_rather_than_discarded_as_warm_up():
    timing = summarize_timing([_sample(1.0, 2.0, 3.0)])
    assert timing["frames_measured"] == 1
    assert timing["total_ms"]["mean"] == 6.0
    assert timing["model_fps"] == pytest.approx(166.7, abs=0.1)


def test_the_first_frame_is_discarded_as_warm_up():
    timing = summarize_timing(
        [_sample(5.0, 500.0, 5.0), _sample(1.0, 10.0, 1.0), _sample(1.0, 10.0, 1.0)]
    )
    assert timing["frames_measured"] == 2
    assert timing["inference_ms"]["max"] == 10.0
    assert timing["inference_ms"]["mean"] == 10.0


def test_percentiles_use_the_nearest_rank_method():
    # one warm-up frame, then inference times 1..10
    samples = [_sample(0.0, 999.0, 0.0)] + [_sample(0.0, float(i), 0.0) for i in range(1, 11)]
    stats = summarize_timing(samples)["inference_ms"]
    assert stats["mean"] == 5.5
    assert stats["p50"] == 5.0
    assert stats["p95"] == 10.0
    assert stats["max"] == 10.0


def test_total_is_the_per_frame_sum_and_fps_follows_its_mean():
    samples = [_sample(9.0, 9.0, 9.0), _sample(2.0, 6.0, 2.0), _sample(2.0, 6.0, 2.0)]
    timing = summarize_timing(samples)
    assert timing["total_ms"] == {"mean": 10.0, "p50": 10.0, "p95": 10.0, "max": 10.0}
    assert timing["model_fps"] == 100.0
```

Append to `ml-worker/tests/test_ultralytics_inference_adapter.py`:

```python
class _TimedResult(_Result):
    def __init__(self, speed, **kwargs):
        super().__init__(**kwargs)
        self.speed = speed


class _TimedModel(_FakeModel):
    """Returns a result carrying Ultralytics-style `speed` for each call."""

    def __init__(self, speeds):
        super().__init__()
        self.speeds = speeds

    def __call__(self, image, conf, verbose):
        speed = self.speeds[min(self.calls, len(self.speeds) - 1)]
        self.calls += 1
        return [_TimedResult(speed, boxes=_Boxes([], [], []))]


def _speed(inference):
    return {"preprocess": 1.0, "inference": inference, "postprocess": 1.0}


def test_timing_aggregates_the_models_own_speed_and_drops_the_warm_up_frame(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=4)
    model = _TimedModel([_speed(50.0), _speed(10.0), _speed(10.0), _speed(10.0)])
    result = _adapter(model).infer(_request(video, 1), lambda done, total: None)
    assert result.timing["frames_measured"] == 3
    assert result.timing["inference_ms"]["mean"] == 10.0
    assert result.timing["total_ms"]["mean"] == 12.0


def test_a_model_without_speed_yields_no_timing_and_still_succeeds(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=3)
    result = _adapter(_FakeModel()).infer(_request(video, 1), lambda done, total: None)
    assert result.timing is None
    assert list(result.frames) == ["0", "1", "2"]


def test_a_malformed_speed_is_ignored_instead_of_failing_the_run(tmp_path):
    video = _write_video(tmp_path / "v.avi", frames=3)
    model = _TimedModel([{"preprocess": "fast", "inference": None}])
    result = _adapter(model).infer(_request(video, 1), lambda done, total: None)
    assert result.timing is None
    assert len(result.frames) == 3
```

Append to `ml-worker/tests/test_tasks_inference.py`:

```python
def test_timing_is_written_into_the_document_when_the_adapter_measured_it(
    db_session, make_inference_job, fake_storage
):
    from app.tasks import inference_run

    timing = {
        "frames_measured": 2,
        "preprocess_ms": {"mean": 1.0, "p50": 1.0, "p95": 1.0, "max": 1.0},
        "inference_ms": {"mean": 9.0, "p50": 9.0, "p95": 9.0, "max": 9.0},
        "postprocess_ms": {"mean": 1.0, "p50": 1.0, "p95": 1.0, "max": 1.0},
        "total_ms": {"mean": 11.0, "p50": 11.0, "p95": 11.0, "max": 11.0},
        "model_fps": 90.9,
    }

    class _TimedStub(_StubAdapter):
        def infer(self, request, on_progress):
            result = super().infer(request, on_progress)
            result.timing = timing
            return result

    job, run = make_inference_job(frame_stride=2)
    inference_run(job.id, adapter=_TimedStub())
    db_session.refresh(run)

    document = json.loads(fake_storage.uploaded[f"inference/{run.id}/predictions.json"])
    assert document["timing"] == timing


def test_the_document_has_no_timing_key_when_nothing_was_measured(
    db_session, make_inference_job, fake_storage
):
    from app.tasks import inference_run

    job, run = make_inference_job(frame_stride=2)
    inference_run(job.id, adapter=_StubAdapter())
    db_session.refresh(run)

    document = json.loads(fake_storage.uploaded[f"inference/{run.id}/predictions.json"])
    assert "timing" not in document
```

- [ ] **Step 2: Run them to verify they fail**

Copy `app` and `tests` into the container (see Global Constraints), then:
`docker compose exec ml-worker uv run pytest tests/test_inference_timing.py tests/test_ultralytics_inference_adapter.py tests/test_tasks_inference.py -v`
Expected: `test_inference_timing.py` FAILS with `ModuleNotFoundError: No module named 'app.inference_timing'`; the new adapter and task tests FAIL (`AttributeError: ... 'timing'`).

- [ ] **Step 3: Implement**

Create `ml-worker/app/inference_timing.py`:

```python
"""Aggregates of per-frame model timings, stored in the predictions document.

Only aggregates are kept: per-frame timings would grow the document by about
a third for little use beyond the summary. The numbers are model time
(preprocess, inference, postprocess including NMS); video decoding is not in
them.
"""

import math

_STAGES = ("preprocess", "inference", "postprocess")


def _stats(values: list[float]) -> dict:
    ordered = sorted(values)
    count = len(ordered)

    def percentile(p: int) -> float:
        # Nearest-rank method.
        return ordered[max(math.ceil(p / 100 * count), 1) - 1]

    return {
        "mean": round(sum(ordered) / count, 2),
        "p50": round(percentile(50), 2),
        "p95": round(percentile(95), 2),
        "max": round(ordered[-1], 2),
    }


def summarize_timing(samples: list[dict]) -> dict | None:
    """One sample per measured frame: {"preprocess", "inference", "postprocess"} in ms.

    Samples missing a stage (or carrying a non-number) are ignored. The first
    usable frame is discarded as GPU warm-up unless it is the only one.
    Returns None when nothing usable was measured.
    """
    usable = [
        sample
        for sample in samples
        if all(isinstance(sample.get(stage), (int, float)) for stage in _STAGES)
    ]
    if not usable:
        return None
    if len(usable) > 1:
        usable = usable[1:]

    totals = [sum(sample[stage] for stage in _STAGES) for sample in usable]
    mean_total = sum(totals) / len(totals)

    timing: dict = {"frames_measured": len(usable)}
    for stage in _STAGES:
        timing[f"{stage}_ms"] = _stats([sample[stage] for sample in usable])
    timing["total_ms"] = _stats(totals)
    timing["model_fps"] = round(1000 / mean_total, 1) if mean_total > 0 else 0.0
    return timing
```

In `ml-worker/app/inference_adapter.py`, add to `InferenceResult` after `frames`:

```python
    # Aggregates of the model's own per-frame timings (see inference_timing),
    # or None when the model reported none. Optional in the document too.
    timing: dict | None = None
```

In `ml-worker/app/ultralytics_inference_adapter.py`: add `from app.inference_timing import summarize_timing` to the imports; before the `while capture.grab():` loop add `timing_samples: list[dict] = []`; immediately after `results = model(image, conf=request.confidence_floor, verbose=False)` add:

```python
                        speed = getattr(results[0], "speed", None)
                        if isinstance(speed, dict):
                            timing_samples.append(
                                {stage: speed.get(stage) for stage in ("preprocess", "inference", "postprocess")}
                            )
```

and change the final return to:

```python
        return InferenceResult(
            task_type=request.task_type,
            fps=fps,
            classes=classes,
            frames=frames,
            timing=summarize_timing(timing_samples),
        )
```

In `ml-worker/app/tasks.py` `inference_run`, directly after the `document = {...}` literal add:

```python
        if result.timing is not None:
            document["timing"] = result.timing
```

- [ ] **Step 4: Run the tests to verify they pass**

Copy `app` and `tests` again, then:
`docker compose exec ml-worker uv run pytest tests/test_inference_timing.py tests/test_ultralytics_inference_adapter.py tests/test_tasks_inference.py tests/test_tasks_training.py tests/test_tasks_gpu_eviction.py -v -k "not requires_sam3_weights and not requires_sam2_weights"`
Expected: all PASS. Then the leak check. Real runs exist in the dev database (for example #82, which belongs to the user), so do not expect zero: note `select count(*) from inference_runs` and `select count(*) from jobs where job_type = 'INFERENCE_RUN'` BEFORE running the tests, and confirm both counts are unchanged afterwards; also confirm `docker compose exec -T postgres psql -U endoscopy -d endoscopy -tAc "select count(*) from videos where title = 'inference test'"` prints `0`.

- [ ] **Step 5: Commit**

```bash
git add ml-worker/app/inference_timing.py ml-worker/app/inference_adapter.py ml-worker/app/ultralytics_inference_adapter.py ml-worker/app/tasks.py ml-worker/tests/test_inference_timing.py ml-worker/tests/test_ultralytics_inference_adapter.py ml-worker/tests/test_tasks_inference.py
git commit -m "feat: record model timing aggregates in the predictions document" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Client types, parameters, NMS and the view

**Files:**
- Modify: `frontend/src/features/qc/predictions.ts`
- Create: `frontend/src/features/qc/analysis/nms.ts`, `view.ts`, `params.ts`
- Test: `frontend/src/features/qc/analysis/nms.test.ts`, `view.test.ts`, `params.test.ts`

**Interfaces:**
- Consumes: `Detection`, `PredictionsDocument`, `FrameIndex`, `DISPLAY_CONFIDENCE_THRESHOLD` from `predictions.ts`.
- Produces:
  - `predictions.ts`: `TimingStats { mean; p50; p95; max }`, `Timing`, and `PredictionsDocument.timing?: Timing`.
  - `nms.ts`: `iou(a: Detection["bbox"], b: Detection["bbox"]): number`; `nms(detections: Detection[], maxIou: number): Detection[]` (class-aware, greedy, result ordered by confidence descending).
  - `view.ts`: `interface ViewParams { threshold: number; nmsIou: number; flickerN: number }`, `NMS_OFF = 0.7`, `DEFAULT_VIEW_PARAMS: ViewParams`, `buildView(doc: PredictionsDocument, params: Pick<ViewParams, "threshold" | "nmsIou">): FrameIndex`.
  - `params.ts`: `PARAM_LIMITS`, `clampParams(raw: Partial<Record<keyof ViewParams, unknown>>): ViewParams`, `loadParams(storage?: Pick<Storage, "getItem">): ViewParams`, `saveParams(params: ViewParams, storage?: Pick<Storage, "setItem">): void`, `PARAMS_STORAGE_KEY = "qc-view-params"`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/features/qc/analysis/nms.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { Detection } from "../predictions";
import { iou, nms } from "./nms";

const det = (class_id: number, confidence: number, bbox: Detection["bbox"]): Detection => ({
  class_id,
  confidence,
  bbox,
});

describe("iou", () => {
  it("is 1 for identical boxes and 0 for disjoint ones", () => {
    expect(iou([0, 0, 0.5, 0.5], [0, 0, 0.5, 0.5])).toBe(1);
    expect(iou([0, 0, 0.2, 0.2], [0.5, 0.5, 0.2, 0.2])).toBe(0);
  });

  it("is a third for two unit boxes overlapping by half", () => {
    expect(iou([0, 0, 1, 1], [0.5, 0, 1, 1])).toBeCloseTo(1 / 3, 6);
  });

  it("is 0 for boxes that only touch", () => {
    expect(iou([0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5])).toBe(0);
  });
});

describe("nms", () => {
  const a = det(0, 0.9, [0, 0, 1, 1]);
  const half = det(0, 0.6, [0, 0, 0.5, 1]); // IoU with a is exactly 0.5

  it("drops the less confident of two same-class boxes at or above the IoU", () => {
    expect(nms([half, a], 0.5)).toEqual([a]);
    expect(nms([half, a], 0.4)).toEqual([a]);
  });

  it("keeps both when their IoU is below the limit", () => {
    expect(nms([a, half], 0.51)).toEqual([a, half]);
  });

  it("is class aware: overlapping boxes of different classes both survive", () => {
    const other = det(1, 0.6, [0, 0, 0.5, 1]);
    expect(nms([a, other], 0.3)).toEqual([a, other]);
  });

  it("returns boxes ordered by confidence, highest first", () => {
    const far = det(0, 0.7, [0, 0, 0.1, 0.1]);
    expect(nms([far, a], 0.5).map((d) => d.confidence)).toEqual([0.9, 0.7]);
  });

  it("collapses identical boxes to one", () => {
    expect(nms([a, { ...a }, { ...a }], 0.5)).toHaveLength(1);
  });

  it("handles an empty list", () => {
    expect(nms([], 0.5)).toEqual([]);
  });
});
```

Create `frontend/src/features/qc/analysis/view.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { Detection, PredictionsDocument } from "../predictions";
import { DEFAULT_VIEW_PARAMS, NMS_OFF, buildView } from "./view";

const det = (class_id: number, confidence: number, bbox: Detection["bbox"] = [0, 0, 1, 1]): Detection => ({
  class_id,
  confidence,
  bbox,
});

const doc = (frames: Record<string, { timestamp_ms: number; detections: Detection[] }>): PredictionsDocument => ({
  task_type: "detection",
  model: { name: "m", version_id: 1 },
  fps: 10,
  frame_stride: 1,
  classes: ["polyp", "fold"],
  frames,
});

describe("buildView", () => {
  it("defaults match the spec", () => {
    expect(DEFAULT_VIEW_PARAMS).toEqual({ threshold: 0.25, nmsIou: 0.7, flickerN: 2 });
    expect(NMS_OFF).toBe(0.7);
  });

  it("sorts processed frames by time", () => {
    const view = buildView(
      doc({ "5": { timestamp_ms: 500, detections: [] }, "0": { timestamp_ms: 0, detections: [] } }),
      { threshold: 0.25, nmsIou: 0.7 },
    );
    expect(view.timestamps).toEqual([0, 500]);
  });

  it("keeps a detection exactly at the threshold and drops one just below", () => {
    const view = buildView(
      doc({ "0": { timestamp_ms: 0, detections: [det(0, 0.25), det(0, 0.2499)] } }),
      { threshold: 0.25, nmsIou: 0.7 },
    );
    expect(view.detections[0].map((d) => d.confidence)).toEqual([0.25]);
  });

  it("does not run NMS at 0.70, where it is off (identical boxes both stay)", () => {
    const view = buildView(
      doc({ "0": { timestamp_ms: 0, detections: [det(0, 0.9), det(0, 0.8)] } }),
      { threshold: 0.25, nmsIou: 0.7 },
    );
    expect(view.detections[0]).toHaveLength(2);
  });

  it("runs class-aware NMS below 0.70", () => {
    const view = buildView(
      doc({
        "0": {
          timestamp_ms: 0,
          detections: [det(0, 0.9), det(0, 0.8), det(1, 0.8)],
        },
      }),
      { threshold: 0.25, nmsIou: 0.5 },
    );
    expect(view.detections[0].map((d) => [d.class_id, d.confidence])).toEqual([
      [0, 0.9],
      [1, 0.8],
    ]);
  });

  it("applies the threshold before NMS, so a hidden strong box cannot suppress a visible one", () => {
    const view = buildView(
      doc({ "0": { timestamp_ms: 0, detections: [det(0, 0.9), det(0, 0.4)] } }),
      { threshold: 0.5, nmsIou: 0.5 },
    );
    expect(view.detections[0].map((d) => d.confidence)).toEqual([0.9]);
  });

  it("gives empty frames for a document where everything is below the threshold", () => {
    const view = buildView(
      doc({ "0": { timestamp_ms: 0, detections: [det(0, 0.1)] }, "1": { timestamp_ms: 100, detections: [det(0, 0.05)] } }),
      { threshold: 0.25, nmsIou: 0.5 },
    );
    expect(view.detections).toEqual([[], []]);
  });

  it("handles a document with no frames", () => {
    expect(buildView(doc({}), { threshold: 0.25, nmsIou: 0.5 })).toEqual({ timestamps: [], detections: [] });
  });
});
```

Create `frontend/src/features/qc/analysis/params.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { PARAMS_STORAGE_KEY, clampParams, loadParams, saveParams } from "./params";
import { DEFAULT_VIEW_PARAMS } from "./view";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => (key in data ? data[key] : null),
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
}

describe("clampParams", () => {
  it("returns the defaults for an empty object", () => {
    expect(clampParams({})).toEqual(DEFAULT_VIEW_PARAMS);
  });

  it("clamps out-of-range numbers to the limits", () => {
    expect(clampParams({ threshold: 5, nmsIou: 0.01, flickerN: 99 })).toEqual({
      threshold: 1,
      nmsIou: 0.3,
      flickerN: 10,
    });
    expect(clampParams({ threshold: -1, nmsIou: 9, flickerN: 0 })).toEqual({
      threshold: 0.05,
      nmsIou: 0.7,
      flickerN: 1,
    });
  });

  it("falls back to the default for non-numeric values", () => {
    expect(clampParams({ threshold: "abc", nmsIou: null, flickerN: NaN })).toEqual(DEFAULT_VIEW_PARAMS);
  });

  it("rounds to the step grid so values compare cleanly", () => {
    expect(clampParams({ threshold: 0.333333, nmsIou: 0.4166, flickerN: 2.6 })).toEqual({
      threshold: 0.33,
      nmsIou: 0.42,
      flickerN: 3,
    });
  });
});

describe("loadParams / saveParams", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    saveParams({ threshold: 0.5, nmsIou: 0.4, flickerN: 3 }, storage);
    expect(storage.data[PARAMS_STORAGE_KEY]).toBeDefined();
    expect(loadParams(storage)).toEqual({ threshold: 0.5, nmsIou: 0.4, flickerN: 3 });
  });

  it("returns the defaults when nothing is stored", () => {
    expect(loadParams(memoryStorage())).toEqual(DEFAULT_VIEW_PARAMS);
  });

  it("returns the defaults for corrupt JSON", () => {
    expect(loadParams(memoryStorage({ [PARAMS_STORAGE_KEY]: "{not json" }))).toEqual(DEFAULT_VIEW_PARAMS);
  });

  it("clamps stored values that are out of range", () => {
    const stored = JSON.stringify({ threshold: 7, nmsIou: 0.5, flickerN: 2 });
    expect(loadParams(memoryStorage({ [PARAMS_STORAGE_KEY]: stored })).threshold).toBe(1);
  });

  it("returns the defaults when storage throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadParams(throwing)).toEqual(DEFAULT_VIEW_PARAMS);
    expect(() => saveParams(DEFAULT_VIEW_PARAMS, throwing)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/features/qc/analysis`
Expected: FAIL with "Failed to resolve import" for `./nms`, `./view`, `./params`.

- [ ] **Step 3: Implement**

In `frontend/src/features/qc/predictions.ts`, add after `PredictionsDocument`'s `frames` field (inside the interface): `timing?: Timing;`, and add above the interface:

```ts
export interface TimingStats {
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

/** Aggregates of the model's per-frame timings, in milliseconds. Absent on
 * runs made before timing was recorded. Model time only: video decoding is
 * not included. */
export interface Timing {
  frames_measured: number;
  preprocess_ms: TimingStats;
  inference_ms: TimingStats;
  postprocess_ms: TimingStats;
  total_ms: TimingStats;
  model_fps: number;
}
```

Create `frontend/src/features/qc/analysis/nms.ts`:

```ts
import type { Detection } from "../predictions";

/** Intersection over union of two [x, y, w, h] boxes. */
export function iou(a: Detection["bbox"], b: Detection["bbox"]): number {
  const width = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const height = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (width <= 0 || height <= 0) return 0;
  const intersection = width * height;
  const union = a[2] * a[3] + b[2] * b[3] - intersection;
  return union > 0 ? intersection / union : 0;
}

/** Greedy class-aware non-maximum suppression: boxes are visited from the
 * most to the least confident, and one is dropped when its IoU with an
 * already kept box of the same class is at or above `maxIou`. The result
 * is ordered by confidence, highest first. Boxes only: segmentation
 * polygons are not intersected. */
export function nms(detections: Detection[], maxIou: number): Detection[] {
  const order = detections
    .map((_, i) => i)
    .sort((i, j) => detections[j].confidence - detections[i].confidence);
  const kept: Detection[] = [];
  for (const i of order) {
    const candidate = detections[i];
    const suppressed = kept.some(
      (other) => other.class_id === candidate.class_id && iou(other.bbox, candidate.bbox) >= maxIou,
    );
    if (!suppressed) kept.push(candidate);
  }
  return kept;
}
```

Create `frontend/src/features/qc/analysis/view.ts`:

```ts
import { DISPLAY_CONFIDENCE_THRESHOLD, type FrameIndex, type PredictionsDocument } from "../predictions";
import { nms } from "./nms";

export interface ViewParams {
  /** Detections below this confidence are hidden. */
  threshold: number;
  /** Class-aware NMS IoU limit; NMS_OFF means the model's own result is kept. */
  nmsIou: number;
  /** Flicker window: the longest run, in processed frames, that counts as a flicker. */
  flickerN: number;
}

/** The model already applied NMS at about this IoU, so the slider's top
 * position means "leave it alone". */
export const NMS_OFF = 0.7;

export const DEFAULT_VIEW_PARAMS: ViewParams = {
  threshold: DISPLAY_CONFIDENCE_THRESHOLD,
  nmsIou: NMS_OFF,
  flickerN: 2,
};

/** The stored predictions with the display parameters applied, in the same
 * shape the overlay already reads. The threshold is applied first so a
 * hidden strong box can never suppress a visible weaker one. */
export function buildView(
  doc: PredictionsDocument,
  params: Pick<ViewParams, "threshold" | "nmsIou">,
): FrameIndex {
  const entries = Object.values(doc.frames).sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  return {
    timestamps: entries.map((entry) => entry.timestamp_ms),
    detections: entries.map((entry) => {
      const visible = entry.detections.filter((d) => d.confidence >= params.threshold);
      return params.nmsIou >= NMS_OFF ? visible : nms(visible, params.nmsIou);
    }),
  };
}
```

Create `frontend/src/features/qc/analysis/params.ts`:

```ts
import { DEFAULT_VIEW_PARAMS, type ViewParams } from "./view";

export const PARAM_LIMITS = {
  threshold: { min: 0.05, max: 1, step: 0.01 },
  nmsIou: { min: 0.3, max: 0.7, step: 0.05 },
  flickerN: { min: 1, max: 10, step: 1 },
} as const;

export const PARAMS_STORAGE_KEY = "qc-view-params";

function clampOne(key: keyof ViewParams, value: unknown): number {
  const limits = PARAM_LIMITS[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_VIEW_PARAMS[key];
  const clamped = Math.min(Math.max(value, limits.min), limits.max);
  // Two decimals keep slider values comparable (0.35, not 0.35000000000000003);
  // the flicker window is a whole number of frames.
  return key === "flickerN" ? Math.round(clamped) : Math.round(clamped * 100) / 100;
}

/** Turns anything (stored JSON, a stray slider event) into valid parameters. */
export function clampParams(raw: Partial<Record<keyof ViewParams, unknown>>): ViewParams {
  return {
    threshold: clampOne("threshold", raw.threshold),
    nmsIou: clampOne("nmsIou", raw.nmsIou),
    flickerN: clampOne("flickerN", raw.flickerN),
  };
}

/** Storage can be blocked, empty or corrupt (private windows, cleared site
 * data); the screen must render with the defaults in every case. */
export function loadParams(
  storage: Pick<Storage, "getItem"> = window.localStorage,
): ViewParams {
  try {
    const raw = storage.getItem(PARAMS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_VIEW_PARAMS };
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? clampParams(parsed as Partial<Record<keyof ViewParams, unknown>>)
      : { ...DEFAULT_VIEW_PARAMS };
  } catch {
    return { ...DEFAULT_VIEW_PARAMS };
  }
}

export function saveParams(
  params: ViewParams,
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  try {
    storage.setItem(PARAMS_STORAGE_KEY, JSON.stringify(params));
  } catch {
    // A convenience only; losing it is fine.
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/qc && npx tsc --noEmit`
Expected: PASS, no type errors in the touched files (the new optional `timing` field must not break existing tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/qc/predictions.ts frontend/src/features/qc/analysis
git commit -m "feat: add the QC view parameters, NMS and the filtered view" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Flicker events, event navigation and the strip levels

**Files:**
- Create: `frontend/src/features/qc/analysis/flicker.ts`, `events.ts`, `strip.ts`
- Test: `frontend/src/features/qc/analysis/flicker.test.ts`, `events.test.ts`, `strip.test.ts`

**Interfaces:**
- Consumes: `FrameIndex`, `PredictionsDocument` from `predictions.ts`.
- Produces:
  - `flicker.ts`: `FlickerKind = "blink" | "dropout"`, `FlickerEvent { classId; kind; startMs; endMs; frames }`, `COARSE_WINDOW_MS = 1000`, `FlickerResult { events: FlickerEvent[]; isCoarse: boolean }`, `findFlickers(view: FrameIndex, classCount: number, n: number): FlickerResult`.
  - `events.ts`: `nextEvent(events: FlickerEvent[], timeMs: number): FlickerEvent | null`, `prevEvent(events: FlickerEvent[], timeMs: number): FlickerEvent | null` (events sorted by `startMs`).
  - `strip.ts`: `StripLevel = "strong" | "moderate" | "weak" | "none"`, `StripBucket { level: StripLevel; maxConfidence: number }`, `STRONG_CONFIDENCE = 0.7`, `LEVEL_COLORS: Record<StripLevel, string>`, `buildStrip(doc, durationMs, buckets, threshold): StripBucket[]`, `formatClock(ms: number): string` (`m:ss`).

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/features/qc/analysis/flicker.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { Detection, FrameIndex } from "../predictions";
import { COARSE_WINDOW_MS, findFlickers } from "./flicker";

const d = (class_id: number): Detection => ({ class_id, confidence: 0.9, bbox: [0, 0, 0.1, 0.1] });

/** One processed frame per entry; each entry lists the class ids present. */
function view(frames: number[][], stepMs = 40): FrameIndex {
  return {
    timestamps: frames.map((_, i) => i * stepMs),
    detections: frames.map((ids) => ids.map(d)),
  };
}

describe("findFlickers", () => {
  it("finds a blink: presence of at most N frames between two absences", () => {
    const result = findFlickers(view([[], [], [0], [0], [], []]), 1, 2);
    expect(result.events).toEqual([
      { classId: 0, kind: "blink", startMs: 80, endMs: 120, frames: 2 },
    ]);
  });

  it("finds a dropout: absence of at most N frames between two presences", () => {
    const result = findFlickers(view([[0], [0], [], [0], [0]]), 1, 2);
    expect(result.events).toEqual([
      { classId: 0, kind: "dropout", startMs: 80, endMs: 80, frames: 1 },
    ]);
  });

  it("ignores a run longer than N", () => {
    expect(findFlickers(view([[], [0], [0], [0], []]), 1, 2).events).toEqual([]);
  });

  it("does not count a run that touches the start or the end of the video", () => {
    expect(findFlickers(view([[0], [], [], []]), 1, 2).events).toEqual([]);
    expect(findFlickers(view([[], [], [], [0]]), 1, 2).events).toEqual([]);
    expect(findFlickers(view([[], [0], [0]]), 1, 2).events).toEqual([]);
  });

  it("treats classes independently and sorts events by time", () => {
    const result = findFlickers(view([[1], [0, 1], [1], [1], [0, 1], [1]]), 2, 1);
    // class 0 blinks at frame 1 and again at frame 4; class 1 is always present.
    expect(result.events.map((e) => [e.classId, e.kind, e.startMs])).toEqual([
      [0, "blink", 40],
      [0, "blink", 160],
    ]);
  });

  it("a larger N admits longer runs", () => {
    const frames = [[], [0], [0], [0], []];
    expect(findFlickers(view(frames), 1, 2).events).toHaveLength(0);
    expect(findFlickers(view(frames), 1, 3).events).toHaveLength(1);
  });

  it("ignores detections whose class id is outside the class list", () => {
    expect(findFlickers(view([[], [5], []]), 1, 2).events).toEqual([]);
  });

  it("handles an empty view and a single frame", () => {
    expect(findFlickers({ timestamps: [], detections: [] }, 1, 2)).toEqual({ events: [], isCoarse: false });
    expect(findFlickers(view([[0]]), 1, 2).events).toEqual([]);
  });

  it("is coarse when the median step times N exceeds the coarse window", () => {
    const frames = [[], [0], []];
    expect(findFlickers(view(frames, 1000), 1, 2).isCoarse).toBe(true);
    expect(findFlickers(view(frames, 40), 1, 2).isCoarse).toBe(false);
    expect(COARSE_WINDOW_MS).toBe(1000);
  });
});
```

Create `frontend/src/features/qc/analysis/events.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { FlickerEvent } from "./flicker";
import { nextEvent, prevEvent } from "./events";

const event = (startMs: number): FlickerEvent => ({
  classId: 0,
  kind: "blink",
  startMs,
  endMs: startMs + 40,
  frames: 1,
});
const events = [event(1000), event(2000), event(3000)];

describe("nextEvent", () => {
  it("returns the first event strictly after the time", () => {
    expect(nextEvent(events, 0)?.startMs).toBe(1000);
    expect(nextEvent(events, 1500)?.startMs).toBe(2000);
  });

  it("skips the event the playhead is already on", () => {
    expect(nextEvent(events, 1000)?.startMs).toBe(2000);
    expect(nextEvent(events, 1000.5)?.startMs).toBe(2000);
  });

  it("returns null past the last event", () => {
    expect(nextEvent(events, 3000)).toBeNull();
    expect(nextEvent([], 0)).toBeNull();
  });
});

describe("prevEvent", () => {
  it("returns the last event strictly before the time", () => {
    expect(prevEvent(events, 3500)?.startMs).toBe(3000);
    expect(prevEvent(events, 2500)?.startMs).toBe(2000);
  });

  it("skips the event the playhead is already on", () => {
    expect(prevEvent(events, 3000)?.startMs).toBe(2000);
  });

  it("returns null before the first event", () => {
    expect(prevEvent(events, 1000)).toBeNull();
    expect(prevEvent([], 5000)).toBeNull();
  });
});
```

Create `frontend/src/features/qc/analysis/strip.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { Detection, PredictionsDocument } from "../predictions";
import { LEVEL_COLORS, STRONG_CONFIDENCE, buildStrip, formatClock } from "./strip";

const det = (confidence: number): Detection => ({ class_id: 0, confidence, bbox: [0, 0, 0.1, 0.1] });

const doc = (frames: Record<string, { timestamp_ms: number; detections: Detection[] }>): PredictionsDocument => ({
  task_type: "detection",
  model: { name: "m", version_id: 1 },
  fps: 10,
  frame_stride: 1,
  classes: ["polyp"],
  frames,
});

const levels = (buckets: ReturnType<typeof buildStrip>) => buckets.map((b) => b.level);

describe("buildStrip", () => {
  it("classifies buckets by the best confidence in them", () => {
    const strip = buildStrip(
      doc({
        a: { timestamp_ms: 0, detections: [det(0.9)] },
        b: { timestamp_ms: 250, detections: [det(0.4)] },
        c: { timestamp_ms: 500, detections: [det(0.1)] },
        d: { timestamp_ms: 750, detections: [] },
      }),
      1000,
      4,
      0.25,
    );
    expect(levels(strip)).toEqual(["strong", "moderate", "weak", "none"]);
    expect(strip[0].maxConfidence).toBe(0.9);
    expect(strip[3].maxConfidence).toBe(0);
    expect(STRONG_CONFIDENCE).toBe(0.7);
  });

  it("takes the maximum across several frames in one bucket", () => {
    const strip = buildStrip(
      doc({
        a: { timestamp_ms: 0, detections: [det(0.3)] },
        b: { timestamp_ms: 100, detections: [det(0.8)] },
      }),
      1000,
      1,
      0.25,
    );
    expect(strip[0]).toEqual({ level: "strong", maxConfidence: 0.8 });
  });

  it("an empty bucket inherits the previous one, like the overlay holds a frame", () => {
    const strip = buildStrip(
      doc({ a: { timestamp_ms: 0, detections: [det(0.9)] } }),
      1000,
      4,
      0.25,
    );
    expect(levels(strip)).toEqual(["strong", "strong", "strong", "strong"]);
  });

  it("buckets before the first processed frame are none", () => {
    const strip = buildStrip(
      doc({ a: { timestamp_ms: 600, detections: [det(0.9)] } }),
      1000,
      4,
      0.25,
    );
    expect(levels(strip)).toEqual(["none", "none", "strong", "strong"]);
  });

  it("a threshold above 0.7 turns a 0.75 bucket weak, never green", () => {
    const strip = buildStrip(doc({ a: { timestamp_ms: 0, detections: [det(0.75)] } }), 1000, 1, 0.9);
    expect(strip[0].level).toBe("weak");
  });

  it("a frame exactly at the duration lands in the last bucket", () => {
    const strip = buildStrip(doc({ a: { timestamp_ms: 1000, detections: [det(0.9)] } }), 1000, 4, 0.25);
    expect(strip[3].level).toBe("strong");
  });

  it("is all none for a document with no detections or no frames", () => {
    expect(levels(buildStrip(doc({ a: { timestamp_ms: 0, detections: [] } }), 1000, 3, 0.25))).toEqual([
      "none",
      "none",
      "none",
    ]);
    expect(levels(buildStrip(doc({}), 1000, 3, 0.25))).toEqual(["none", "none", "none"]);
  });

  it("returns nothing for zero buckets or a zero duration", () => {
    expect(buildStrip(doc({}), 1000, 0, 0.25)).toEqual([]);
    expect(buildStrip(doc({}), 0, 5, 0.25)).toEqual([]);
  });
});

describe("LEVEL_COLORS and formatClock", () => {
  it("has a colour for every level", () => {
    expect(Object.keys(LEVEL_COLORS).sort()).toEqual(["moderate", "none", "strong", "weak"]);
  });

  it("formats milliseconds as m:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(202000)).toBe("3:22");
    expect(formatClock(59999)).toBe("0:59");
    expect(formatClock(3600000)).toBe("60:00");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/features/qc/analysis`
Expected: FAIL with "Failed to resolve import" for `./flicker`, `./events`, `./strip`.

- [ ] **Step 3: Implement**

Create `frontend/src/features/qc/analysis/flicker.ts`:

```ts
import type { FrameIndex } from "../predictions";

export type FlickerKind = "blink" | "dropout";

export interface FlickerEvent {
  classId: number;
  kind: FlickerKind;
  /** Timestamp of the first processed frame in the run. */
  startMs: number;
  /** Timestamp of the last processed frame in the run. */
  endMs: number;
  /** Number of processed frames in the run. */
  frames: number;
}

/** When the median step between processed frames times the flicker window
 * exceeds this, "a blink of 1-2 frames" means seconds and the events
 * would mislead, so the screen warns instead. */
export const COARSE_WINDOW_MS = 1000;

export interface FlickerResult {
  events: FlickerEvent[];
  isCoarse: boolean;
}

function medianStep(timestamps: number[]): number {
  if (timestamps.length < 2) return 0;
  const steps = timestamps.slice(1).map((t, i) => t - timestamps[i]).sort((a, b) => a - b);
  const middle = Math.floor(steps.length / 2);
  return steps.length % 2 ? steps[middle] : (steps[middle - 1] + steps[middle]) / 2;
}

/** Flicker by class presence over processed frames, without tracking boxes.
 * A blink is a run of presence of at most `n` frames with absence on both
 * sides; a dropout is a run of absence of at most `n` frames with presence
 * on both sides. A run that touches the start or end of the video is not an
 * event: its far boundary is unknown. */
export function findFlickers(view: FrameIndex, classCount: number, n: number): FlickerResult {
  const { timestamps, detections } = view;
  const events: FlickerEvent[] = [];

  for (let classId = 0; classId < classCount; classId++) {
    const present = detections.map((frame) => frame.some((d) => d.class_id === classId));
    let start = 0;
    while (start < present.length) {
      let end = start;
      while (end + 1 < present.length && present[end + 1] === present[start]) end++;
      const length = end - start + 1;
      const touchesEdge = start === 0 || end === present.length - 1;
      if (!touchesEdge && length <= n) {
        events.push({
          classId,
          kind: present[start] ? "blink" : "dropout",
          startMs: timestamps[start],
          endMs: timestamps[end],
          frames: length,
        });
      }
      start = end + 1;
    }
  }

  events.sort((a, b) => a.startMs - b.startMs || a.classId - b.classId);
  return { events, isCoarse: medianStep(timestamps) * n > COARSE_WINDOW_MS };
}
```

Create `frontend/src/features/qc/analysis/events.ts`:

```ts
import type { FlickerEvent } from "./flicker";

/** Tolerance so the event the playhead already sits on is not picked again. */
const TOLERANCE_MS = 1;

/** `events` must be sorted by startMs (findFlickers returns them that way). */
export function nextEvent(events: FlickerEvent[], timeMs: number): FlickerEvent | null {
  return events.find((event) => event.startMs > timeMs + TOLERANCE_MS) ?? null;
}

export function prevEvent(events: FlickerEvent[], timeMs: number): FlickerEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].startMs < timeMs - TOLERANCE_MS) return events[i];
  }
  return null;
}
```

Create `frontend/src/features/qc/analysis/strip.ts`:

```ts
import type { PredictionsDocument } from "../predictions";

export type StripLevel = "strong" | "moderate" | "weak" | "none";

export interface StripBucket {
  level: StripLevel;
  /** Best raw confidence of the processed frames in the bucket; 0 when none. */
  maxConfidence: number;
}

export const STRONG_CONFIDENCE = 0.7;

export const LEVEL_COLORS: Record<StripLevel, string> = {
  strong: "#22c55e",
  moderate: "#f59e0b",
  weak: "#475569",
  none: "#111827",
};

function levelFor(maxConfidence: number, threshold: number): StripLevel {
  if (maxConfidence <= 0) return "none";
  if (maxConfidence < threshold) return "weak";
  return maxConfidence >= STRONG_CONFIDENCE ? "strong" : "moderate";
}

/** One bucket per horizontal pixel of the strip. Uses the raw document, not
 * the NMS-filtered view: NMS never changes a maximum, and "weak" (the model
 * saw something below the threshold) must stay visible when the threshold
 * is high. A bucket with no processed frame inherits the previous bucket,
 * matching how the overlay holds the previous frame between stride steps. */
export function buildStrip(
  doc: PredictionsDocument,
  durationMs: number,
  buckets: number,
  threshold: number,
): StripBucket[] {
  if (buckets <= 0 || durationMs <= 0) return [];

  const maxima: (number | null)[] = new Array(buckets).fill(null);
  for (const frame of Object.values(doc.frames)) {
    const bucket = Math.min(buckets - 1, Math.floor((frame.timestamp_ms / durationMs) * buckets));
    if (bucket < 0) continue;
    let best = 0;
    for (const detection of frame.detections) {
      if (detection.confidence > best) best = detection.confidence;
    }
    maxima[bucket] = Math.max(maxima[bucket] ?? 0, best);
  }

  const result: StripBucket[] = [];
  let previous = 0;
  for (const value of maxima) {
    const maxConfidence = value ?? previous;
    previous = maxConfidence;
    result.push({ level: levelFor(maxConfidence, threshold), maxConfidence });
  }
  return result;
}

/** m:ss, for the strip tooltip. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/qc && npx tsc --noEmit`
Expected: PASS, no type errors in the touched files.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/qc/analysis
git commit -m "feat: add flicker events, event navigation and strip levels" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Display, Latency and event-navigation components

**Files:**
- Create: `frontend/src/features/qc/DisplayPanel.tsx`, `LatencyPanel.tsx`, `EventNav.tsx`
- Test: `frontend/src/features/qc/DisplayPanel.test.tsx`, `LatencyPanel.test.tsx`, `EventNav.test.tsx`

**Interfaces:**
- Consumes: `ViewParams`, `NMS_OFF` from `analysis/view.ts`; `PARAM_LIMITS` from `analysis/params.ts`; `Timing` from `predictions.ts`.
- Produces: `DisplayPanel` props `{ params: ViewParams; onChange(next: ViewParams): void; onReset(): void; blinkCount: number; dropoutCount: number; isCoarse: boolean }`; `LatencyPanel` props `{ timing: Timing | undefined }`; `EventNav` props `{ count: number; onPrev(): void; onNext(): void }`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/features/qc/DisplayPanel.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_VIEW_PARAMS } from "./analysis/view";
import { DisplayPanel } from "./DisplayPanel";

function setup(overrides = {}) {
  const props = {
    params: { ...DEFAULT_VIEW_PARAMS },
    onChange: vi.fn(),
    onReset: vi.fn(),
    blinkCount: 0,
    dropoutCount: 0,
    isCoarse: false,
    ...overrides,
  };
  render(<DisplayPanel {...props} />);
  return props;
}

describe("DisplayPanel", () => {
  it("emits the new threshold as a number", () => {
    const props = setup();
    fireEvent.change(screen.getByLabelText("Confidence"), { target: { value: "0.5" } });
    expect(props.onChange).toHaveBeenCalledWith({ ...DEFAULT_VIEW_PARAMS, threshold: 0.5 });
  });

  it("emits the new NMS IoU and the new flicker window", () => {
    const props = setup();
    fireEvent.change(screen.getByLabelText("NMS IoU"), { target: { value: "0.4" } });
    expect(props.onChange).toHaveBeenLastCalledWith({ ...DEFAULT_VIEW_PARAMS, nmsIou: 0.4 });
    fireEvent.change(screen.getByLabelText("Flicker window"), { target: { value: "4" } });
    expect(props.onChange).toHaveBeenLastCalledWith({ ...DEFAULT_VIEW_PARAMS, flickerN: 4 });
  });

  it("shows the sliders' ranges", () => {
    setup();
    expect(screen.getByLabelText("Confidence")).toHaveAttribute("min", "0.05");
    expect(screen.getByLabelText("Confidence")).toHaveAttribute("max", "1");
    expect(screen.getByLabelText("NMS IoU")).toHaveAttribute("min", "0.3");
    expect(screen.getByLabelText("NMS IoU")).toHaveAttribute("max", "0.7");
  });

  it("labels the NMS slider 'off' at 0.70 and shows the number otherwise", () => {
    setup();
    expect(screen.getByText("off")).toBeInTheDocument();
  });

  it("shows the NMS value when it is on", () => {
    setup({ params: { ...DEFAULT_VIEW_PARAMS, nmsIou: 0.5 } });
    expect(screen.queryByText("off")).not.toBeInTheDocument();
    expect(screen.getByText("0.50")).toBeInTheDocument();
  });

  it("calls onReset", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(props.onReset).toHaveBeenCalled();
  });

  it("summarises the flicker events with correct pluralisation", () => {
    setup({ blinkCount: 1, dropoutCount: 2 });
    expect(screen.getByText("3 flicker events (1 blink, 2 dropout)")).toBeInTheDocument();
  });

  it("says 'event' for exactly one and 'No flicker events' for none", () => {
    const { unmount } = render(
      <DisplayPanel
        params={DEFAULT_VIEW_PARAMS}
        onChange={vi.fn()}
        onReset={vi.fn()}
        blinkCount={1}
        dropoutCount={0}
        isCoarse={false}
      />,
    );
    expect(screen.getByText("1 flicker event (1 blink, 0 dropout)")).toBeInTheDocument();
    unmount();
    setup();
    expect(screen.getByText("No flicker events")).toBeInTheDocument();
  });

  it("warns when the stride is too coarse for flicker detection", () => {
    setup({ isCoarse: true });
    expect(screen.getByText(/stride is too coarse for flicker detection/i)).toBeInTheDocument();
  });

  it("shows no warning when the stride is fine", () => {
    setup();
    expect(screen.queryByText(/too coarse/i)).not.toBeInTheDocument();
  });
});
```

Create `frontend/src/features/qc/LatencyPanel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LatencyPanel } from "./LatencyPanel";
import type { Timing } from "./predictions";

const stats = (mean: number) => ({ mean, p50: mean, p95: mean + 3, max: mean + 10 });
const timing: Timing = {
  frames_measured: 659,
  preprocess_ms: stats(1.9),
  inference_ms: stats(9.4),
  postprocess_ms: stats(1.2),
  total_ms: stats(12.5),
  model_fps: 80,
};

describe("LatencyPanel", () => {
  it("says so when the run has no timing (every run made before it was recorded)", () => {
    render(<LatencyPanel timing={undefined} />);
    expect(screen.getByText("Not recorded for this run")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows one row per stage with mean, p50, p95 and max", () => {
    render(<LatencyPanel timing={timing} />);
    expect(screen.getByRole("columnheader", { name: "p95" })).toBeInTheDocument();
    const inference = screen.getByRole("row", { name: /Inference/ });
    expect(inference).toHaveTextContent("9.4");
    expect(inference).toHaveTextContent("12.4");
    expect(inference).toHaveTextContent("19.4");
    expect(screen.getAllByRole("row")).toHaveLength(5); // header + 4 stages
  });

  it("shows the model speed and how many frames were measured", () => {
    render(<LatencyPanel timing={timing} />);
    expect(screen.getByText("Model speed: 80 fps (659 frames measured)")).toBeInTheDocument();
  });
});
```

Create `frontend/src/features/qc/EventNav.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EventNav } from "./EventNav";

describe("EventNav", () => {
  it("disables both buttons and explains when there are no events", () => {
    render(<EventNav count={0} onPrev={vi.fn()} onNext={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Previous event" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next event" })).toBeDisabled();
    expect(screen.getByText("No flicker events at these settings")).toBeInTheDocument();
  });

  it("calls the matching handler when there are events", async () => {
    const user = userEvent.setup();
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(<EventNav count={3} onPrev={onPrev} onNext={onNext} />);
    await user.click(screen.getByRole("button", { name: "Previous event" }));
    await user.click(screen.getByRole("button", { name: "Next event" }));
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/No flicker events/)).not.toBeInTheDocument();
  });

  it("mentions the keys", () => {
    render(<EventNav count={3} onPrev={vi.fn()} onNext={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Previous event" })).toHaveAttribute("title", "Previous event ([)");
    expect(screen.getByRole("button", { name: "Next event" })).toHaveAttribute("title", "Next event (])");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/features/qc/DisplayPanel.test.tsx src/features/qc/LatencyPanel.test.tsx src/features/qc/EventNav.test.tsx`
Expected: FAIL with "Failed to resolve import" for the three components.

- [ ] **Step 3: Implement**

Create `frontend/src/features/qc/DisplayPanel.tsx`:

```tsx
import { PARAM_LIMITS } from "./analysis/params";
import { NMS_OFF, type ViewParams } from "./analysis/view";

interface DisplayPanelProps {
  params: ViewParams;
  onChange: (next: ViewParams) => void;
  onReset: () => void;
  blinkCount: number;
  dropoutCount: number;
  isCoarse: boolean;
}

const SLIDER = "w-full accent-blue-500";

export function DisplayPanel({
  params,
  onChange,
  onReset,
  blinkCount,
  dropoutCount,
  isCoarse,
}: DisplayPanelProps) {
  const set = (patch: Partial<ViewParams>) => onChange({ ...params, ...patch });
  const total = blinkCount + dropoutCount;
  const nmsText = params.nmsIou >= NMS_OFF ? "off" : params.nmsIou.toFixed(2);

  return (
    <section aria-label="Display" className="flex flex-col gap-3 text-sm text-gray-300">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-200">Display</h2>
        <button
          type="button"
          onClick={onReset}
          className="rounded border border-gray-700 px-2 py-0.5 text-xs text-gray-300 hover:text-gray-100"
        >
          Reset
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <label htmlFor="qc-threshold">Confidence</label>
          <span className="text-gray-400">{params.threshold.toFixed(2)}</span>
        </div>
        <input
          id="qc-threshold"
          type="range"
          className={SLIDER}
          min={PARAM_LIMITS.threshold.min}
          max={PARAM_LIMITS.threshold.max}
          step={PARAM_LIMITS.threshold.step}
          value={params.threshold}
          aria-valuetext={params.threshold.toFixed(2)}
          onChange={(e) => set({ threshold: Number(e.target.value) })}
        />
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <label htmlFor="qc-nms">NMS IoU</label>
          <span className="text-gray-400">{nmsText}</span>
        </div>
        <input
          id="qc-nms"
          type="range"
          className={SLIDER}
          min={PARAM_LIMITS.nmsIou.min}
          max={PARAM_LIMITS.nmsIou.max}
          step={PARAM_LIMITS.nmsIou.step}
          value={params.nmsIou}
          aria-valuetext={nmsText}
          onChange={(e) => set({ nmsIou: Number(e.target.value) })}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <label htmlFor="qc-flicker-n">Flicker window</label>
        <input
          id="qc-flicker-n"
          type="number"
          className="w-16 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-right text-sm text-gray-100"
          min={PARAM_LIMITS.flickerN.min}
          max={PARAM_LIMITS.flickerN.max}
          step={PARAM_LIMITS.flickerN.step}
          value={params.flickerN}
          onChange={(e) => set({ flickerN: Number(e.target.value) })}
        />
      </div>

      <p className="text-xs text-gray-400">
        {total === 0
          ? "No flicker events"
          : `${total} flicker ${total === 1 ? "event" : "events"} (${blinkCount} blink, ${dropoutCount} dropout)`}
      </p>

      {isCoarse && (
        <p role="note" className="rounded border border-yellow-700 bg-yellow-950 px-2 py-1 text-xs text-yellow-200">
          Stride is too coarse for flicker detection: one step is long, so these events span seconds.
        </p>
      )}
    </section>
  );
}
```

Create `frontend/src/features/qc/LatencyPanel.tsx`:

```tsx
import type { Timing, TimingStats } from "./predictions";

const STAGES: { key: "preprocess_ms" | "inference_ms" | "postprocess_ms" | "total_ms"; label: string }[] = [
  { key: "preprocess_ms", label: "Preprocess" },
  { key: "inference_ms", label: "Inference" },
  { key: "postprocess_ms", label: "Postprocess" },
  { key: "total_ms", label: "Total" },
];

const fmt = (value: number) => value.toFixed(1);

export function LatencyPanel({ timing }: { timing: Timing | undefined }) {
  return (
    <section aria-label="Latency" className="flex flex-col gap-2 text-sm text-gray-300">
      <h2 className="text-sm font-semibold text-gray-200">Latency</h2>
      {timing === undefined ? (
        <p className="text-xs text-gray-500">Not recorded for this run</p>
      ) : (
        <>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-gray-500">
                <th className="font-normal">Stage (ms)</th>
                <th className="text-right font-normal">mean</th>
                <th className="text-right font-normal">p50</th>
                <th className="text-right font-normal">p95</th>
                <th className="text-right font-normal">max</th>
              </tr>
            </thead>
            <tbody>
              {STAGES.map(({ key, label }) => {
                const stats: TimingStats = timing[key];
                return (
                  <tr key={key}>
                    <td>{label}</td>
                    <td className="text-right">{fmt(stats.mean)}</td>
                    <td className="text-right">{fmt(stats.p50)}</td>
                    <td className="text-right">{fmt(stats.p95)}</td>
                    <td className="text-right">{fmt(stats.max)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-xs text-gray-400">
            Model speed: {timing.model_fps} fps ({timing.frames_measured} frames measured)
          </p>
        </>
      )}
    </section>
  );
}
```

Create `frontend/src/features/qc/EventNav.tsx`:

```tsx
interface EventNavProps {
  count: number;
  onPrev: () => void;
  onNext: () => void;
}

const BUTTON =
  "rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:text-gray-100 disabled:opacity-50";

export function EventNav({ count, onPrev, onNext }: EventNavProps) {
  const none = count === 0;
  return (
    <div className="flex items-center gap-2">
      <button type="button" className={BUTTON} disabled={none} onClick={onPrev} title="Previous event ([)">
        Previous event
      </button>
      <button type="button" className={BUTTON} disabled={none} onClick={onNext} title="Next event (])">
        Next event
      </button>
      {none && <span className="text-xs text-gray-500">No flicker events at these settings</span>}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/qc && npx tsc --noEmit`
Expected: PASS, no type errors in the touched files.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/qc/DisplayPanel.tsx frontend/src/features/qc/DisplayPanel.test.tsx frontend/src/features/qc/LatencyPanel.tsx frontend/src/features/qc/LatencyPanel.test.tsx frontend/src/features/qc/EventNav.tsx frontend/src/features/qc/EventNav.test.tsx
git commit -m "feat: add the QC display, latency and event navigation panels" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Timeline strip and the video clock

**Files:**
- Create: `frontend/src/features/qc/useVideoClock.ts`, `frontend/src/features/qc/TimelineStrip.tsx`

**Interfaces:**
- Consumes: `buildStrip`, `LEVEL_COLORS`, `formatClock`, `StripBucket` from `analysis/strip.ts`; `FlickerEvent` from `analysis/flicker.ts`; `colorForClass`, `PredictionsDocument` from `predictions.ts`.
- Produces: `useVideoClock(videoRef: React.RefObject<HTMLVideoElement | null>): number` (current time in ms, updated from a rAF loop only when it changes); `TimelineStrip` props `{ videoRef: React.RefObject<HTMLVideoElement | null>; doc: PredictionsDocument; threshold: number; events: FlickerEvent[]; durationMs: number; onSeek(ms: number): void }`.

These two files are browser glue (canvas, `ResizeObserver`, a rAF loop): jsdom has no canvas or video clock, so a unit test would only assert mocks. The pure logic they use is already tested in Task 3. They are verified in a real browser in Task 7.

- [ ] **Step 1: Implement the clock hook**

Create `frontend/src/features/qc/useVideoClock.ts`:

```ts
import { useEffect, useState } from "react";

/** The video's current time in milliseconds, for the strip's playhead. A
 * rAF loop reads it and sets state only when it changed, which covers
 * playback, pausing and scrubbing with one mechanism (the same approach as
 * PredictionOverlay). Used inside the strip only, so only the strip
 * re-renders while the video plays. */
export function useVideoClock(videoRef: React.RefObject<HTMLVideoElement | null>): number {
  const [timeMs, setTimeMs] = useState(0);

  useEffect(() => {
    let handle = 0;
    let last = -1;

    function tick() {
      const video = videoRef.current;
      if (video) {
        const now = Math.round(video.currentTime * 1000);
        if (now !== last) {
          last = now;
          setTimeMs(now);
        }
      }
      handle = requestAnimationFrame(tick);
    }

    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [videoRef]);

  return timeMs;
}
```

- [ ] **Step 2: Implement the strip**

Create `frontend/src/features/qc/TimelineStrip.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";

import type { FlickerEvent } from "./analysis/flicker";
import { LEVEL_COLORS, buildStrip, formatClock, type StripLevel } from "./analysis/strip";
import { colorForClass, type PredictionsDocument } from "./predictions";
import { useVideoClock } from "./useVideoClock";

interface TimelineStripProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  doc: PredictionsDocument;
  threshold: number;
  events: FlickerEvent[];
  durationMs: number;
  onSeek: (ms: number) => void;
}

const MAX_BUCKETS = 1600;

const LEGEND: { level: StripLevel; label: string }[] = [
  { level: "strong", label: "≥ 0.7" },
  { level: "moderate", label: "above threshold" },
  { level: "weak", label: "below threshold" },
  { level: "none", label: "nothing" },
];

/** A full-width timeline under the player: coloured by the best confidence
 * in each slice of time, flicker marks on top, a playhead, click to seek.
 * The native controls cannot be decorated, hence a strip of our own. */
export function TimelineStrip({ videoRef, doc, threshold, events, durationMs, onSeek }: TimelineStripProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ ms: number; x: number } | null>(null);
  const timeMs = useVideoClock(videoRef);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setWidth(Math.floor(el.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const buckets = useMemo(
    () => buildStrip(doc, durationMs, Math.min(width, MAX_BUCKETS), threshold),
    [doc, durationMs, width, threshold],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || buckets.length === 0) return;
    canvas.width = buckets.length;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    buckets.forEach((bucket, i) => {
      ctx.fillStyle = LEVEL_COLORS[bucket.level];
      ctx.fillRect(i, 0, 1, 1);
    });
  }, [buckets]);

  function msAt(clientX: number): { ms: number; x: number } {
    const rect = containerRef.current!.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
    return { ms: (x / rect.width) * durationMs, x };
  }

  const hoveredBucket = hover
    ? buckets[Math.min(buckets.length - 1, Math.floor((hover.ms / durationMs) * buckets.length))]
    : undefined;
  const percent = (ms: number) => `${Math.min(Math.max(ms / durationMs, 0), 1) * 100}%`;

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={containerRef}
        role="img"
        aria-label="Detection timeline. Colour shows the best confidence over time; marks show flicker events. Click to seek."
        className="relative h-5 w-full cursor-pointer overflow-visible rounded bg-gray-900"
        onClick={(e) => onSeek(msAt(e.clientX).ms)}
        onMouseMove={(e) => setHover(msAt(e.clientX))}
        onMouseLeave={() => setHover(null)}
      >
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full rounded" />

        {events.map((event, i) => (
          <span
            key={`${event.classId}-${event.kind}-${event.startMs}-${i}`}
            aria-hidden="true"
            title={`${event.kind} · ${formatClock(event.startMs)}`}
            className="pointer-events-none absolute top-0 h-2 w-2 -translate-x-1/2 rounded-full border-2"
            style={{
              left: percent(event.startMs),
              borderColor: colorForClass(event.classId),
              backgroundColor: event.kind === "blink" ? colorForClass(event.classId) : "transparent",
            }}
          />
        ))}

        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 w-0.5 bg-white"
          style={{ left: percent(timeMs) }}
        />

        {hover && (
          <div
            className="pointer-events-none absolute -top-7 -translate-x-1/2 whitespace-nowrap rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-100"
            style={{ left: hover.x }}
          >
            {formatClock(hover.ms)}
            {hoveredBucket ? ` · max ${hoveredBucket.maxConfidence.toFixed(2)}` : ""}
          </div>
        )}
      </div>

      <ul className="flex flex-wrap items-center gap-3 text-xs text-gray-400">
        {LEGEND.map(({ level, label }) => (
          <li key={level} className="flex items-center gap-1">
            <span className="inline-block h-2 w-3 rounded-sm" style={{ backgroundColor: LEVEL_COLORS[level] }} />
            {label}
          </li>
        ))}
        <li className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-gray-300" /> blink
        </li>
        <li className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full border-2 border-gray-300" /> dropout
        </li>
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit && npx vitest run src/features/qc`
Expected: no type errors in the two new files; the existing suite still passes. (No new unit test: see the note above.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/features/qc/useVideoClock.ts frontend/src/features/qc/TimelineStrip.tsx
git commit -m "feat: add the QC timeline strip and video clock" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Wire the run view

**Files:**
- Create: `frontend/src/features/qc/analysis/useViewParams.ts`
- Test: `frontend/src/features/qc/analysis/useViewParams.test.tsx`
- Modify: `frontend/src/features/qc/RunViewPage.tsx`, `frontend/src/features/qc/PredictionOverlay.tsx`

**Interfaces:**
- Consumes: everything from Tasks 2 to 5.
- Produces: `useViewParams(): [ViewParams, (next: ViewParams) => void, () => void]` (state initialised from `loadParams`, every set is passed through `clampParams` and persisted with `saveParams`, the third element resets to the defaults and persists them). `PredictionOverlay` keeps its props (`videoRef`, `index`, `classes`) but `index` is now the filtered view and it no longer applies the old constant threshold.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/qc/analysis/useViewParams.test.tsx`:

```tsx
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PARAMS_STORAGE_KEY } from "./params";
import { useViewParams } from "./useViewParams";
import { DEFAULT_VIEW_PARAMS } from "./view";

describe("useViewParams", () => {
  beforeEach(() => window.localStorage.removeItem(PARAMS_STORAGE_KEY));
  afterEach(() => window.localStorage.removeItem(PARAMS_STORAGE_KEY));

  it("starts from the defaults when nothing is stored", () => {
    const { result } = renderHook(() => useViewParams());
    expect(result.current[0]).toEqual(DEFAULT_VIEW_PARAMS);
  });

  it("starts from stored values", () => {
    window.localStorage.setItem(
      PARAMS_STORAGE_KEY,
      JSON.stringify({ threshold: 0.5, nmsIou: 0.4, flickerN: 3 }),
    );
    const { result } = renderHook(() => useViewParams());
    expect(result.current[0]).toEqual({ threshold: 0.5, nmsIou: 0.4, flickerN: 3 });
  });

  it("clamps what is set and persists it", () => {
    const { result } = renderHook(() => useViewParams());
    act(() => result.current[1]({ threshold: 5, nmsIou: 0.4, flickerN: 3 }));
    expect(result.current[0]).toEqual({ threshold: 1, nmsIou: 0.4, flickerN: 3 });
    expect(JSON.parse(window.localStorage.getItem(PARAMS_STORAGE_KEY)!)).toEqual({
      threshold: 1,
      nmsIou: 0.4,
      flickerN: 3,
    });
  });

  it("reset returns to the defaults and persists them", () => {
    const { result } = renderHook(() => useViewParams());
    act(() => result.current[1]({ threshold: 0.6, nmsIou: 0.4, flickerN: 5 }));
    act(() => result.current[2]());
    expect(result.current[0]).toEqual(DEFAULT_VIEW_PARAMS);
    expect(JSON.parse(window.localStorage.getItem(PARAMS_STORAGE_KEY)!)).toEqual(DEFAULT_VIEW_PARAMS);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/features/qc/analysis/useViewParams.test.tsx`
Expected: FAIL with "Failed to resolve import ./useViewParams".

- [ ] **Step 3: Implement the hook**

Create `frontend/src/features/qc/analysis/useViewParams.ts`:

```ts
import { useCallback, useState } from "react";

import { clampParams, loadParams, saveParams } from "./params";
import { DEFAULT_VIEW_PARAMS, type ViewParams } from "./view";

/** The display parameters, remembered per browser (not per run) as a
 * convenience. Every value is clamped before it is kept. */
export function useViewParams(): [ViewParams, (next: ViewParams) => void, () => void] {
  const [params, setParams] = useState<ViewParams>(() => loadParams());

  const update = useCallback((next: ViewParams) => {
    const clamped = clampParams(next);
    setParams(clamped);
    saveParams(clamped);
  }, []);

  const reset = useCallback(() => {
    const defaults = { ...DEFAULT_VIEW_PARAMS };
    setParams(defaults);
    saveParams(defaults);
  }, []);

  return [params, update, reset];
}
```

- [ ] **Step 4: Switch the overlay to the filtered view**

In `frontend/src/features/qc/PredictionOverlay.tsx`: remove `DISPLAY_CONFIDENCE_THRESHOLD` from the import (keep `detectionsAt` and `type FrameIndex`) and change the `drawDetections(...)` call's last argument from `DISPLAY_CONFIDENCE_THRESHOLD` to `0`, with this comment above the call: `// The index is already filtered by the display threshold and NMS.` Update the docstring sentence accordingly ("`index` is the filtered view").

- [ ] **Step 5: Rewrite `RunViewPage.tsx`**

Replace the whole file with:

```tsx
import { useCallback, useDeferredValue, useEffect, useMemo, useRef } from "react";
import { Link, useParams } from "react-router-dom";

import { useInferenceRun, usePredictions } from "../../entities/useInferenceRuns";
import { useVideo } from "../../entities/useVideo";
import { TranscodePrompt } from "../media/TranscodePrompt";
import { nextEvent, prevEvent } from "./analysis/events";
import { findFlickers, type FlickerEvent } from "./analysis/flicker";
import { useViewParams } from "./analysis/useViewParams";
import { buildView } from "./analysis/view";
import { DisplayPanel } from "./DisplayPanel";
import { EventNav } from "./EventNav";
import { LatencyPanel } from "./LatencyPanel";
import { PredictionOverlay } from "./PredictionOverlay";
import { colorForClass, countByClass } from "./predictions";
import { RunStatus } from "./RunStatus";
import { TimelineStrip } from "./TimelineStrip";

// A stable empty list, so callbacks that depend on `events` keep their identity.
const NO_EVENTS: FlickerEvent[] = [];

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable);
}

export function RunViewPage() {
  const params = useParams();
  const runId = params.runId ? Number(params.runId) : null;
  const runQuery = useInferenceRun(runId);
  const run = runQuery.data ?? null;
  const videoQuery = useVideo(run?.video_id ?? null);
  const predictionsQuery = usePredictions(runId, run?.status === "succeeded");
  const videoRef = useRef<HTMLVideoElement>(null);

  const [viewParams, setViewParams, resetViewParams] = useViewParams();
  // The sliders stay responsive: the heavy recomputation follows a deferred copy.
  const deferred = useDeferredValue(viewParams);

  const document = predictionsQuery.data;
  const view = useMemo(
    () => (document ? buildView(document, deferred) : null),
    // Only these two change the view; the flicker window must not rebuild it.
    [document, deferred.threshold, deferred.nmsIou],
  );
  const flicker = useMemo(
    () => (document && view ? findFlickers(view, document.classes.length, deferred.flickerN) : null),
    [document, view, deferred.flickerN],
  );
  const counts = useMemo(
    () => (document && view ? countByClass(view, document.classes.length, 0) : []),
    [document, view],
  );

  const video = videoQuery.data;
  const { refetch: refetchVideo } = videoQuery;
  const handleTranscodeComplete = useCallback(() => {
    void refetchVideo();
  }, [refetchVideo]);

  const durationMs = useMemo(() => {
    const lastFrameMs = view ? (view.timestamps[view.timestamps.length - 1] ?? 0) : 0;
    return Math.max((video?.duration_seconds ?? 0) * 1000, lastFrameMs);
  }, [video, view]);

  const seekTo = useCallback((ms: number) => {
    const el = videoRef.current;
    if (el) el.currentTime = ms / 1000;
  }, []);

  const events = flicker?.events ?? NO_EVENTS;
  const jump = useCallback(
    (direction: "prev" | "next") => {
      const el = videoRef.current;
      if (!el || events.length === 0) return;
      const now = el.currentTime * 1000;
      const target = direction === "next" ? nextEvent(events, now) : prevEvent(events, now);
      if (target) seekTo(target.startMs);
    },
    [events, seekTo],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;
      if (event.key === "[") jump("prev");
      else if (event.key === "]") jump("next");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jump]);

  const blinkCount = events.filter((e) => e.kind === "blink").length;
  const dropoutCount = events.length - blinkCount;

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-100">
          {video?.title ?? "Run"} · {run?.model_name}
        </h1>
        <Link to="/qc" className="text-sm text-blue-400 hover:underline">
          ← Back to QC
        </Link>
      </div>

      {runQuery.isError && <p className="text-sm text-red-400">This run could not be loaded.</p>}

      {run && run.status !== "succeeded" && <RunStatus run={run} />}

      {run?.status === "succeeded" && video?.browser_playable === false && (
        <TranscodePrompt videoId={video.id} onTranscodeComplete={handleTranscodeComplete} />
      )}

      {run?.status === "succeeded" && video && video.browser_playable !== false && (
        <div className="flex flex-col gap-4 lg:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="relative bg-black">
              <video
                ref={videoRef}
                src={video.stream_url}
                controls
                className="block max-h-[70vh] w-full"
              />
              {view && document && (
                <PredictionOverlay videoRef={videoRef} index={view} classes={document.classes} />
              )}
              {predictionsQuery.isPending && (
                <p className="absolute left-2 top-2 rounded bg-gray-900/80 px-2 py-1 text-xs text-gray-300">
                  Loading predictions…
                </p>
              )}
              {predictionsQuery.isError && (
                <p className="absolute left-2 top-2 rounded bg-red-900/80 px-2 py-1 text-xs text-red-100">
                  Could not load predictions.
                </p>
              )}
            </div>

            {document && view ? (
              <>
                <TimelineStrip
                  videoRef={videoRef}
                  doc={document}
                  threshold={deferred.threshold}
                  events={events}
                  durationMs={durationMs}
                  onSeek={seekTo}
                />
                <EventNav count={events.length} onPrev={() => jump("prev")} onNext={() => jump("next")} />
              </>
            ) : (
              <div aria-hidden="true" className="h-5 rounded bg-gray-800/50" />
            )}
          </div>

          <aside className="flex w-full shrink-0 flex-col gap-5 rounded border border-gray-800 bg-gray-900 p-4 lg:w-72">
            {document && view ? (
              <DisplayPanel
                params={viewParams}
                onChange={setViewParams}
                onReset={resetViewParams}
                blinkCount={blinkCount}
                dropoutCount={dropoutCount}
                isCoarse={flicker?.isCoarse ?? false}
              />
            ) : (
              <p className="text-xs text-gray-500">Display controls appear when predictions load.</p>
            )}

            <section aria-label="Classes">
              <h2 className="mb-2 text-sm font-semibold text-gray-200">Classes</h2>
              {document && document.classes.length > 0 ? (
                <ul className="flex flex-col gap-1 text-sm text-gray-300">
                  {document.classes.map((name, id) => (
                    <li key={id} className="flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <span
                          className="inline-block h-3 w-3 rounded-sm"
                          style={{ backgroundColor: colorForClass(id) }}
                        />
                        {name}
                      </span>
                      <span className="text-gray-500">{counts[id] ?? 0}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-gray-500">No classes.</p>
              )}
            </section>

            {document && <LatencyPanel timing={document.timing} />}
          </aside>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run the tests and the full frontend suite**

Run: `cd frontend && npx vitest run src/features/qc && npx tsc --noEmit && npx vitest run`
Expected: the new hook test and every existing test PASS; no type errors in the touched files. Any failure elsewhere must also fail without your changes (name the file) or be fixed.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/qc/analysis/useViewParams.ts frontend/src/features/qc/analysis/useViewParams.test.tsx frontend/src/features/qc/RunViewPage.tsx frontend/src/features/qc/PredictionOverlay.tsx
git commit -m "feat: show thresholds, flicker events, the strip and latency on the QC run view" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Real-stack verification, spec and roadmap

This task is manual on purpose. The strip, the clock hook and the page composition are browser glue no unit test can exercise, and CLAUDE.md records bugs that only a real browser against the real stack caught. The stack should be running (backend :8000, ml-worker restarted with the new code, frontend on :5173); if it is not, bring it up per CLAUDE.md. Do not stop or start anything on another project's ports.

**Files:**
- Modify: `docs/specs/2026-10-06-qc-inspection-design.md`, `ROADMAP.md`

- [ ] **Step 1: Refresh the worker and make a run that has timing**

`docker cp ml-worker/app/. endoscopy-platform-ml-worker-1:/app/app/`, `docker compose restart ml-worker`, confirm the log shows `inference_run` registered. In the browser at `http://localhost:5173/qc` (login `manualcheck@example.com`, password in the project memory note `reference_manual_check_login_and_taxonomy_reimport.md`), run the detect model on video `stek_polyps` with stride 5. Confirm it succeeds, then fetch the predictions JSON and check the `timing` block exists and is plausible (`frames_measured` close to the processed frame count minus one, `inference_ms.mean` of a few to a few tens of milliseconds, `model_fps` equal to `1000 / total_ms.mean`).

- [ ] **Step 2: Drive the run view and record what you observe**

Open the new run and, for each item, report PASS or FAIL with what you saw:

1. The strip renders full width under the player with coloured segments; hovering shows `m:ss · max 0.xx`; clicking seeks the video; the playhead follows playback and scrubbing.
2. Moving the Confidence slider changes the overlay and the class counts and recolours the strip; at a high threshold (above 0.7) no segment is green unless a detection at or above the threshold exists.
3. Moving NMS IoU below 0.70 removes overlapping same-class boxes on a frame that has them; at 0.70 it reads "off" and nothing changes.
4. Flicker events: change the window N and watch the count and the marks change; the "Previous event" and "Next event" buttons and the `[` and `]` keys move the playhead to the right marks; typing in the Flicker window field does not trigger the keys.
5. A stride-30 run (or the existing stride-1 run #82 versus a stride-30 one) shows the coarse notice at the right point and not on the fine run.
6. The Latency panel shows the table and the model speed for the new run, and "Not recorded for this run" for run #82 (made before timing existed) without any error.
7. Reload the page: slider values persist. Block storage (or clear the key) and confirm the defaults return without an error.
8. Console: no errors or warnings from the app.
9. Performance: in the browser console on run #82 (19,800 frames) time `buildView`, `findFlickers` and `buildStrip` once with `performance.now()` after loading predictions, and move the sliders to feel the smoothness. Record the milliseconds; the spec's target is tens of milliseconds, not hundreds. If it is slower, say so with numbers; do not optimise without them.
10. Resize the window and confirm the strip rebuilds and stays aligned.

A failure is fixed in the owning task's files with a new failing test where one can exist, and noted in the roadmap.

- [ ] **Step 3: Sweep what the verification created**

Run #82 belongs to the user: never delete it. Delete only the runs this task created, through the QC screen's Delete, then confirm with `docker compose exec -T postgres psql -U endoscopy -d endoscopy -c "select id,status,frame_stride from inference_runs order by id;"` that only runs that existed before remain, and that the `inference/` prefix in MinIO holds only their objects.

- [ ] **Step 4: Update the spec and the roadmap**

In `docs/specs/2026-10-06-qc-inspection-design.md`: change the status line to "implemented", and under a new `## Deviations from the first draft` list record: `buildStrip` returns `{ level, maxConfidence }` per bucket (for the tooltip); the previous/next event buttons are disabled only when there are no events; aggregates keep two decimals; plus anything the browser check changed. In `ROADMAP.md` change the heading of "Phase 3: QC screen, sub-project 2 (inspection)" to `DONE (<date>)`, link this plan, replace "Implementation plan: not written yet.", and add the Step 2 results (what passed, what failed and how it was fixed, the measured recompute times) and any new open items.

- [ ] **Step 5: Commit**

```bash
git add docs/specs/2026-10-06-qc-inspection-design.md ROADMAP.md
git commit -m "docs: record the QC inspection verification in the roadmap" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
