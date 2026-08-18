# Balance Panel Limit Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the balance panel's exclusions visible and its limit controls honest — excluded classes stay on the chart greyed with their real sizes, limit fields start at each class's maximum, and a limit applies after the user stops typing instead of on every keystroke.

**Architecture:** `compute_balance` computes a second, unfiltered composition to learn each class's uncapped size, returns a row for *every* class (excluded ones with `instances = 0` and real `max_instances`), and derives metrics from the filtered subset so a zero-instance row cannot poison them. The panel renders excluded rows greyed, pre-fills each limit input with `max_instances`, and routes limit edits through the page's existing debounce.

**Tech Stack:** FastAPI, SQLAlchemy 2.0, Pydantic v2, pytest, React + TypeScript, TanStack Query, Vitest, Tailwind (dark-only).

**Spec:** [docs/superpowers/specs/2026-08-16-balance-panel-limit-controls-design.md](../specs/2026-08-16-balance-panel-limit-controls-design.md)

## Global Constraints

- **Language:** English only in all committed content — code, comments, docstrings, UI copy. No Russian.
- **UI theme:** dark only. Never introduce light-background Tailwind classes.
- **JSON, not JSONB** for any new column (none in this plan).
- **API contract:** after any schema change run `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py` (the `PYTHONPATH=.` is required) and verify with `git diff --stat openapi.json`. Never hand-edit `frontend/src/shared/api/generated/`.
- **TDD:** every task gets a failing test, actually run and observed failing, before the implementation.
- **Git:** commit directly to `master`. No branch, no worktree, no merge, no push.
- **Never TRUNCATE/DELETE/DROP anything in the `endoscopy` database** — it holds 180 real annotations and 155 clinical labels. This plan adds no migration.

### Environment facts — verified, do not re-derive

- **Backend baseline: 309 passed / 16 pre-existing failures**, stable (`test_jobs.py`, `test_media_service.py`, `test_mask_postprocess_endpoint.py`, `test_quality_migration.py` and others). Do not fix those 16.
- **Frontend baseline: 459 passed.**
- **`npm run build` (tsc over the whole repo) is RED and predates this work** (~235 errors from a broken jest-dom matcher type setup). NOT a gate. New tests using `toBeInTheDocument()` add more instances of the same pre-existing gap — expected.
- **Frontend gate:** `npm test` green, plus no new product-code tsc errors. Check with:
  `npx tsc -b --noEmit 2>&1 | grep -E "features/datasets|entities/useDatasets" | grep -v "\.test\."`
  EXACTLY ONE line is expected and accepted: `useDatasets.ts(26,38): Property 'error' does not exist on type 'never'` — a repo-wide parameterless-GET typing defect that also affects `useSettings.ts`.
- Backend tests run against an ephemeral `endoscopy_test` database that `conftest.py` builds and resets. Use uniquely-named throwaway fixtures that roll back.

### The trap this plan exists to avoid

`compute_imbalance_metrics` divides by the smallest class. Feeding it a zero-instance row makes `min_count` zero and `imbalance_ratio` literally `inf` — verified by calling it with `{"polyp": 45, "foam": 0}`. Since this plan makes excluded classes appear in `classes` with `instances = 0`, the metrics **must** be computed from a filtered collection. Task 1's tests pin this.

### Real data to sanity-check against

Selecting all sequences with `task_type=detection` yields `polyp` 45 instances / 43 frames, `foam` 2/2, `lst_g_homogeneous` 2/2, and singletons `colono_sheath`, `colono_ssl`, `diverticulum`, `ileum`, `transparent_cap`, `valvula_ileocaecalis` at 1/1. `sessile_polyp_0_Is` has 18 instances across 17 frames (one frame carries two objects) — the case that makes the instances/frames distinction visible.

---

### Task 1: Backend — report every class, with uncapped maxima

**Files:**
- Modify: `backend/app/datasets/service.py` (`ClassCount`, `compute_balance`)
- Modify: `backend/app/datasets/schemas.py` (`ClassCountRead`)
- Modify: `openapi.json` (regenerated)
- Test: `backend/tests/test_dataset_class_maxima.py`

**Interfaces:**
- Consumes: `collect_frames`, `resolve_class`, `build_label_tree`, `GroupingRules`, `compute_imbalance_metrics` — all existing.
- Produces:
  - `ClassCount(label_id, name, instances, frames, max_instances, max_frames)` — two new fields, both defaulting to `0` so existing construction sites keep working.
  - `ClassCountRead` gains `max_instances: int` and `max_frames: int`.
  - `compute_balance` returns a `ClassCount` for every class in the selection, including excluded ones (`instances = 0`, `frames = 0`, real `max_*`).

**How to get the maxima:** call `collect_frames` a second time with **no exclusions and no limits** (`excluded_label_ids=set()`, `class_limits=None`), reusing the same `tree`/`rules`, and count instances and distinct frames per resolved class from that. Do not write a new query path — the machinery already exists and reusing it guarantees the two counts are resolved identically.

**The metrics must come from a filtered collection.** Build the full `classes` list for the return value, but compute `below_threshold`, `metrics` and the recommendations from `[c for c in classes if c.instances > 0]`. Two collections, one derived from the other.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_dataset_class_maxima.py`:

```python
import app.main  # noqa: F401 -- registers every model on Base.metadata for create_all
import math

import sqlalchemy as sa

from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
from app.datasets.models import TaskType
from app.datasets.service import compute_balance
from app.db import SessionLocal
from app.media.models import Frame, Sequence
from app.taxonomy.hierarchy import GroupingRules
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure


def _island(session, tag, frames_per_sequence=6):
    procedure = Procedure(name=f"mx-{tag}-proc")
    session.add(procedure)
    session.flush()
    category = Category(name=f"mx-{tag}-cat", procedure_id=procedure.id)
    session.add(category)
    session.flush()
    region = EvaluationType(name=f"mx-{tag}-region", annotation_scope=AnnotationScope.REGION)
    session.add(region)
    session.flush()
    sequence = Sequence(name=f"mx-{tag}-seq", start_time=0, duration=1, procedure_id=procedure.id)
    session.add(sequence)
    session.flush()
    frames = [
        Frame(sequence_id=sequence.id, storage_key=f"mx/{tag}/{i}", frame_index=i,
              width=64, height=64)
        for i in range(frames_per_sequence)
    ]
    session.add_all(frames)
    session.flush()
    user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
    return category, region, sequence, frames, user_id


def _label(session, category, evaluation_type, name):
    label = Label(name=name, category_id=category.id, evaluation_type_id=evaluation_type.id)
    session.add(label)
    session.flush()
    return label


def _annotate(session, frame, label, user_id):
    annotation = Annotation(
        frame_id=frame.id, label_id=label.id, taxonomy_version=label.taxonomy_version,
        annotation_type=AnnotationType.MASK, payload={},
        status=AnnotationStatus.DRAFT, created_by_id=user_id,
    )
    session.add(annotation)
    session.flush()
    return annotation


def test_an_unrestricted_class_reports_max_equal_to_its_actual_counts():
    session = SessionLocal()
    try:
        category, region, sequence, frames, user_id = _island(session, "plain")
        polyp = _label(session, category, region, "mx-plain-polyp")
        for frame in frames[:4]:
            _annotate(session, frame, polyp, user_id)

        report = compute_balance(session, [sequence.id], TaskType.DETECTION, GroupingRules(), set())

        entry = next(c for c in report.classes if c.name == "mx-plain-polyp")
        assert entry.instances == 4
        assert entry.max_instances == 4
        assert entry.frames == 4
        assert entry.max_frames == 4
    finally:
        session.rollback()
        session.close()


def test_an_excluded_class_still_appears_with_zero_instances_and_its_real_max():
    session = SessionLocal()
    try:
        category, region, sequence, frames, user_id = _island(session, "excl")
        polyp = _label(session, category, region, "mx-excl-polyp")
        rare = _label(session, category, region, "mx-excl-rare")
        for frame in frames[:4]:
            _annotate(session, frame, polyp, user_id)
        _annotate(session, frames[4], rare, user_id)
        _annotate(session, frames[5], rare, user_id)

        report = compute_balance(
            session, [sequence.id], TaskType.DETECTION, GroupingRules(), {rare.id}
        )

        entry = next(c for c in report.classes if c.name == "mx-excl-rare")
        assert entry.instances == 0
        assert entry.frames == 0
        assert entry.max_instances == 2
        assert entry.max_frames == 2
    finally:
        session.rollback()
        session.close()


def test_a_capped_class_reports_the_cap_and_its_uncapped_max():
    session = SessionLocal()
    try:
        category, region, sequence, frames, user_id = _island(session, "cap")
        polyp = _label(session, category, region, "mx-cap-polyp")
        for frame in frames:
            _annotate(session, frame, polyp, user_id)

        report = compute_balance(
            session, [sequence.id], TaskType.DETECTION, GroupingRules(), set(),
            class_limits={polyp.id: 2},
        )

        entry = next(c for c in report.classes if c.name == "mx-cap-polyp")
        assert entry.instances == 2
        assert entry.max_instances == 6
    finally:
        session.rollback()
        session.close()


def test_excluding_a_class_does_not_make_imbalance_ratio_infinite():
    # The specific regression zero-instance rows invite: compute_imbalance_metrics
    # divides by the smallest class, so a 0 would make min_count 0 and the ratio inf.
    session = SessionLocal()
    try:
        category, region, sequence, frames, user_id = _island(session, "inf")
        polyp = _label(session, category, region, "mx-inf-polyp")
        rare = _label(session, category, region, "mx-inf-rare")
        for frame in frames[:5]:
            _annotate(session, frame, polyp, user_id)
        _annotate(session, frames[5], rare, user_id)

        report = compute_balance(
            session, [sequence.id], TaskType.DETECTION, GroupingRules(), {rare.id}
        )

        assert math.isfinite(report.metrics["imbalance_ratio"])
        assert report.metrics["min_count"] > 0
    finally:
        session.rollback()
        session.close()


def test_an_excluded_class_is_absent_from_below_threshold():
    session = SessionLocal()
    try:
        category, region, sequence, frames, user_id = _island(session, "belowthr")
        polyp = _label(session, category, region, "mx-belowthr-polyp")
        rare = _label(session, category, region, "mx-belowthr-rare")
        for frame in frames[:5]:
            _annotate(session, frame, polyp, user_id)
        _annotate(session, frames[5], rare, user_id)

        report = compute_balance(
            session, [sequence.id], TaskType.DETECTION, GroupingRules(), {rare.id}, threshold=10
        )

        assert "mx-belowthr-rare" not in report.below_threshold
        assert "mx-belowthr-polyp" in report.below_threshold
    finally:
        session.rollback()
        session.close()


def test_total_frames_reflects_the_effective_composition_not_the_uncapped_one():
    session = SessionLocal()
    try:
        category, region, sequence, frames, user_id = _island(session, "totals")
        polyp = _label(session, category, region, "mx-totals-polyp")
        rare = _label(session, category, region, "mx-totals-rare")
        for frame in frames[:4]:
            _annotate(session, frame, polyp, user_id)
        _annotate(session, frames[4], rare, user_id)

        full = compute_balance(session, [sequence.id], TaskType.DETECTION, GroupingRules(), set())
        excluded = compute_balance(
            session, [sequence.id], TaskType.DETECTION, GroupingRules(), {rare.id}
        )

        assert full.total_frames == 5
        assert excluded.total_frames == 4
    finally:
        session.rollback()
        session.close()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_dataset_class_maxima.py -v`
Expected: FAIL — `AttributeError: 'ClassCount' object has no attribute 'max_instances'`.

- [ ] **Step 3: Add the fields to `ClassCount`**

In `backend/app/datasets/service.py`, extend the dataclass. Both new fields default to `0` so any existing construction site keeps working:

```python
@dataclass
class ClassCount:
    label_id: int
    name: str
    instances: int
    frames: int
    # Uncapped, unexcluded size of this class in the current selection.
    # Presentation-only: the panel pre-fills a limit input with max_instances
    # and greys an excluded row while still showing how much it holds.
    max_instances: int = 0
    max_frames: int = 0
```

- [ ] **Step 4: Compute the maxima and build both collections**

In `compute_balance`, after the existing `rows` query and the `resolved_ids`/`names` lookups, add an unrestricted pass. Place it just before the `classes` list is built:

```python
    # Uncapped, unexcluded counts, for the panel's grey bars and limit maxima.
    # Reuses collect_frames rather than a bespoke query so both passes resolve
    # classes through exactly the same path.
    unrestricted = collect_frames(
        session, sequence_ids, task_type, set(), tree, rules, None
    )
    unrestricted_ids = [aid for item in unrestricted for aid in item.annotation_ids]
    max_instances: dict[int, int] = {}
    max_frames_by_class: dict[int, set[int]] = {}
    if unrestricted_ids:
        for row in (
            session.query(Annotation.id, Annotation.frame_id, Annotation.label_id)
            .filter(Annotation.id.in_(unrestricted_ids))
            .all()
        ):
            class_id = resolve_class(row.label_id, tree, rules)
            max_instances[class_id] = max_instances.get(class_id, 0) + 1
            max_frames_by_class.setdefault(class_id, set()).add(row.frame_id)
            names.setdefault(class_id, None)

    missing_names = [cid for cid, value in names.items() if value is None]
    if missing_names:
        for label in session.query(Label).filter(Label.id.in_(missing_names)).all():
            names[label.id] = label.name
```

Then replace the `classes` construction so it covers every class seen in either pass:

```python
    all_class_ids = set(instances) | set(max_instances)
    classes = [
        ClassCount(
            label_id=class_id,
            name=names.get(class_id) or f"label-{class_id}",
            instances=instances.get(class_id, 0),
            frames=len(frames_by_class.get(class_id, set())),
            max_instances=max_instances.get(class_id, 0),
            max_frames=len(max_frames_by_class.get(class_id, set())),
        )
        for class_id in all_class_ids
    ]
    classes.sort(key=lambda c: (-c.max_instances, c.name))

    # Metrics, the under-threshold list and the recommendations all describe the
    # dataset that would actually be built, so they see only classes that still
    # contribute. Feeding a zero-instance row to compute_imbalance_metrics would
    # make min_count 0 and imbalance_ratio literally inf.
    effective = [c for c in classes if c.instances > 0]
    below = [c.name for c in effective if c.instances < threshold]
    metrics = compute_imbalance_metrics({c.name: c.instances for c in effective})
```

and make the recommendations use `effective` too — find the `BalanceReport(...)` construction and the `build_recommendations` call below it, and pass a report whose `classes` are `effective` for that call only. Concretely, replace the recommendation line with:

```python
    report.recommendations = build_recommendations(
        BalanceReport(
            classes=effective,
            total_frames=report.total_frames,
            negative_frames=report.negative_frames,
            below_threshold=below,
            threshold=threshold,
            metrics=metrics,
        ),
        concentration,
    )
```

Sorting by `-max_instances` rather than `-instances` keeps an excluded class in its natural size position instead of sinking it to the bottom — the point of the grey bar is to show how big the thing you removed was.

- [ ] **Step 5: Extend the read schema**

In `backend/app/datasets/schemas.py`, add to `ClassCountRead`:

```python
    max_instances: int = 0
    max_frames: int = 0
```

and in `backend/app/datasets/router.py`'s `/balance` response, include them in the per-class dict:

```python
            {"label_id": c.label_id, "name": c.name, "instances": c.instances,
             "frames": c.frames, "max_instances": c.max_instances,
             "max_frames": c.max_frames}
```

Also add them to the `classes` entries stored in `create_dataset`'s `balance_metrics` snapshot, so a saved dataset's Metrics dialog shows the same shape.

- [ ] **Step 6: Run the tests**

Run: `cd backend && uv run pytest tests/test_dataset_class_maxima.py tests/test_dataset_balance.py tests/test_datasets_api.py tests/test_dataset_recommendations.py -v`
Expected: PASS.

- [ ] **Step 7: Verify against real data**

```bash
cd backend && PYTHONPATH=. uv run python -c "
from app.db import SessionLocal
from app.datasets.models import TaskType
from app.datasets.service import compute_balance
from app.taxonomy.hierarchy import GroupingRules
import sqlalchemy as sa
s = SessionLocal()
ids = [r[0] for r in s.execute(sa.text('SELECT id FROM sequences')).all()]
full = compute_balance(s, ids, TaskType.DETECTION, GroupingRules(), set())
foam = next(c for c in full.classes if c.name == 'foam')
excl = compute_balance(s, ids, TaskType.DETECTION, GroupingRules(), {foam.label_id})
e = next(c for c in excl.classes if c.name == 'foam')
print('foam when included:', e.instances if False else (foam.instances, foam.max_instances))
print('foam when excluded:', (e.instances, e.max_instances))
print('ratio finite      :', excl.metrics['imbalance_ratio'])
print('foam in below_thr :', 'foam' in excl.below_threshold)
s.close()"
```

Expected: `foam when excluded: (0, 2)`, a finite ratio, and `False` for the under-threshold membership.

- [ ] **Step 8: Regenerate OpenAPI and commit**

```bash
cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py
git diff --stat openapi.json
git add backend/app/datasets/ backend/tests/test_dataset_class_maxima.py openapi.json
git commit -m "feat: report every class with its uncapped maximum"
```

---

### Task 2: Frontend — grey excluded rows, prefilled maxima, debounced limits

**Files:**
- Modify: `frontend/src/features/datasets/BalancePanel.tsx`
- Modify: `frontend/src/features/datasets/DatasetsPage.tsx`
- Test: `frontend/src/features/datasets/BalancePanel.test.tsx` (append)
- Test: `frontend/src/features/datasets/DatasetsPage.test.tsx` (append)

**Interfaces:**
- Consumes: `ClassCountRead.max_instances` and `.max_frames` from Task 1's regenerated client.
- Produces: no new exports — behaviour changes only.

Four changes, all in service of one idea: the panel should show what you removed and what you could still keep.

1. **Excluded rows stay, greyed.** A row whose class is excluded renders with muted text and a grey bar sized by `max_instances`, still showing its counts. The separate "Excluded classes" list is removed — it duplicated this less usefully.
2. **`0` and the checkbox are one state.** Typing `0` unchecks the row's include checkbox; unchecking the checkbox puts `0` in its limit field. They express the same thing.
3. **Each limit field starts at the class's maximum** and rejects a larger value.
4. **A limit applies on debounce**, not per keystroke.

- [ ] **Step 1: Regenerate the API client**

```bash
cd frontend && npm run generate-api
grep -c "max_instances" src/shared/api/generated/schema.d.ts
```
Expected: non-zero. If zero, Task 1's OpenAPI regeneration did not land — stop.

- [ ] **Step 2: Write the failing tests**

Append to `frontend/src/features/datasets/BalancePanel.test.tsx`. Add `max_instances`/`max_frames` to the file's shared `REPORT` fixture classes first (mirroring their `instances`/`frames`), so existing tests keep type-checking:

```tsx
it("keeps an excluded class on the chart, greyed, with its size still visible", () => {
  renderPanel({
    report: {
      ...REPORT,
      classes: [
        { label_id: 1, name: "polyp", instances: 35, frames: 33, max_instances: 35, max_frames: 33 },
        { label_id: 2, name: "foam", instances: 0, frames: 0, max_instances: 2, max_frames: 2 },
      ],
    },
    excluded: new Set([2]),
  });

  const row = screen.getByTestId("class-row-2");
  expect(row).toBeInTheDocument();
  expect(row).toHaveTextContent("2");
  expect(row.className).toMatch(/opacity|text-gray-5|text-gray-6/);
});

it("pre-fills each limit input with the class's maximum", () => {
  renderPanel({
    report: {
      ...REPORT,
      classes: [
        { label_id: 1, name: "polyp", instances: 35, frames: 33, max_instances: 35, max_frames: 33 },
      ],
    },
  });

  expect(screen.getByLabelText(/limit polyp/i)).toHaveValue(35);
});

it("does not accept a limit above the class maximum", () => {
  const props = renderPanel({
    report: {
      ...REPORT,
      classes: [
        { label_id: 1, name: "polyp", instances: 35, frames: 33, max_instances: 35, max_frames: 33 },
      ],
    },
  });

  const input = screen.getByLabelText(/limit polyp/i);
  expect(input).toHaveAttribute("max", "35");
});

it("labels the two-number column so instances and frames are distinguishable", () => {
  renderPanel();
  expect(screen.getByTestId("counts-heading")).toHaveTextContent(/instances/i);
  expect(screen.getByTestId("counts-heading")).toHaveTextContent(/frames/i);
});
```

Append to `frontend/src/features/datasets/DatasetsPage.test.tsx` — these pin the synchronization and the debounce. Match the file's existing mock setup and its `class_limits` assertion style:

```tsx
it("unchecks the include checkbox when a limit of 0 is entered", async () => {
  render(<DatasetsPage />, { wrapper });
  await userEvent.click(await screen.findByLabelText(/select seq-a/i));

  const limitInput = await screen.findByLabelText(/limit polyp/i);
  fireEvent.change(limitInput, { target: { value: "0" } });

  await waitFor(() => {
    expect(screen.getByLabelText(/include polyp/i)).not.toBeChecked();
  });
});

it("puts 0 in the limit field when the include checkbox is cleared", async () => {
  render(<DatasetsPage />, { wrapper });
  await userEvent.click(await screen.findByLabelText(/select seq-a/i));

  await userEvent.click(await screen.findByLabelText(/include polyp/i));

  await waitFor(() => {
    expect(screen.getByLabelText(/limit polyp/i)).toHaveValue(0);
  });
});

it("sends the typed limit, not an intermediate keystroke", async () => {
  render(<DatasetsPage />, { wrapper });
  await userEvent.click(await screen.findByLabelText(/select seq-a/i));

  const limitInput = await screen.findByLabelText(/limit polyp/i);
  fireEvent.change(limitInput, { target: { value: "1" } });
  fireEvent.change(limitInput, { target: { value: "10" } });

  await new Promise((resolve) => setTimeout(resolve, 500));

  const calls = vi.mocked(apiClient.POST).mock.calls.filter(([p]) => p === "/datasets/balance");
  expect(calls.at(-1)?.[1]?.body?.class_limits).toEqual({ 1: 10 });
});
```

Ensure the mocked balance response in that file returns a class with `label_id: 1, name: "polyp"` plus `max_instances`/`max_frames`, and that `fireEvent` is imported alongside the existing testing-library imports.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/datasets/`
Expected: FAIL — no `counts-heading`, the limit input has no `max`, and the excluded row is absent.

- [ ] **Step 4: Update `BalancePanel`**

- Remove the `excludedLabels` prop, the "Excluded classes" section that renders it, and the `Re-include {name}` buttons. Excluded classes now appear as greyed rows in the main list, so that section is redundant. Leave the prop out of the interface entirely rather than accepting an unused one.
- Add a heading row above the bars with `data-testid="counts-heading"` reading `instances / frames`, styled like the existing muted labels (`text-xs text-gray-400`).
- For each row, derive `const isExcluded = excluded.has(entry.label_id);` and apply muted classes when true — e.g. add `opacity-50` to the row and render the bar with `bg-gray-600` instead of `bg-blue-600`.
- Size the bar by `max_instances` so an excluded row still shows its real size: use `entry.max_instances` for the width numerator and compute `maxInstances` from `Math.max(1, ...report.classes.map((c) => c.max_instances))`.
- Show both counts as `{entry.instances} / {entry.frames}` when included, and `0 / 0 (max {entry.max_instances})` when excluded — so the row states plainly that it contributes nothing but holds that much.
- Give the limit input `max={entry.max_instances}` and default its displayed value to `classLimits[entry.label_id] ?? entry.max_instances`.

- [ ] **Step 5: Synchronize `0` with the checkbox and debounce the limit**

In `DatasetsPage.tsx`:

- `changeLimit(labelId, limit)` currently deletes the key for any value `< 1`. Change it so a value of exactly `0` means "exclude": add the label to `excluded` and store `0` in `classLimits`. A `null` (cleared field) still deletes the key and leaves `excluded` untouched. A negative or non-finite value is ignored.
- `toggleExclude(labelId)` must keep the two in step: when excluding, set `classLimits[labelId] = 0`; when re-including, delete the limit key so the field falls back to showing the maximum.
- The limit already flows through the page's existing debounced request state; verify the input's `onChange` does not bypass it. If `BalancePanel` currently calls `onChangeLimit` on every keystroke and the page applies it immediately, move the application into the same debounced path the selection uses — the request body must settle on the final typed value.

- [ ] **Step 6: Run the tests**

```bash
cd frontend && npx vitest run src/features/datasets/ && npm test
npx tsc -b --noEmit 2>&1 | grep -E "features/datasets|entities/useDatasets" | grep -v "\.test\."
```
Expected: datasets tests pass, whole suite green, and the tsc check prints only the one accepted `useDatasets.ts(26,38)` line.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/datasets/
git commit -m "feat: grey excluded classes, prefill limit maxima, debounce limit edits"
```

---

### Task 3: Real-browser verification and ROADMAP

**Files:**
- Modify: `ROADMAP.md`

- [ ] **Step 1: Start the stack**

```bash
docker compose up -d
cd backend && uv run uvicorn app.main:app --port 8000
cd frontend && npm run dev -- --port 5173 --strictPort
```

Use `--strictPort` and verify against the port Vite prints. A stale dev server from an earlier session would silently serve old code.

Log in as `manualcheck@example.com` / `manual-check-pass` (NOT the test fixtures' `pass1234`).

- [ ] **Step 2: Verify the four behaviours against real data**

On `/datasets`, select all annotated sequences with `task_type = detection`. Ground truth: `polyp` 45/43, `foam` 2/2, `lst_g_homogeneous` 2/2, and six singletons at 1/1.

- **Typing a limit works.** Type `10` into `polyp`'s limit field. It must settle at 10 instances — NOT collapse to 1 after the first keystroke. This is the bug this plan exists to fix; verify it explicitly.
- **The field starts at the maximum.** Before typing, `polyp`'s field shows `35`-or-whatever its `max_instances` is, and refuses a larger value.
- **Excluding greys instead of hiding.** Uncheck `foam`. Its row stays, greyed, still showing `max 2`. Its checkbox is unchecked and its limit field shows `0`.
- **Typing `0` excludes.** Type `0` into `lst_g_homogeneous`'s field; its checkbox must clear and its row grey out.
- **Metrics stay finite.** With classes excluded, `Imbalance ratio` must show a real number, never `Infinity` or `∞`.

- [ ] **Step 3: Verify the counts heading**

The two-number column carries a visible `instances / frames` heading, so `18 / 17` is self-explanatory.

- [ ] **Step 4: Run both suites**

```bash
cd backend && uv run pytest -q
cd frontend && npm test
```
Report the real numbers. Backend has 16 pre-existing failures — do not fix them.

- [ ] **Step 5: Record it in ROADMAP and commit**

Add a Phase 2b entry recording: the per-keystroke limit bug and its fix, excluded classes staying visible as grey bars with their maxima, the `0`/checkbox synchronization replacing the earlier "0 clears the cap" behaviour (and why — the original Critical was two controls disagreeing, not the meaning of zero), the prefilled maxima, and the `instances / frames` heading. Note that the metrics are computed from the non-excluded subset specifically to keep `imbalance_ratio` finite. Follow the deviation-log style the file already uses.

```bash
git add ROADMAP.md
git commit -m "docs: record the balance-panel limit and exclusion work in ROADMAP"
```

---

## Deferred, deliberately

- **YOLO export**, `data.yaml`, the class-map fingerprint and archive download — still the next separate piece of work.
- **Auto-applied recommendations.** They stay advisory; applying an exclusion or cap on the user's behalf is the invisible data decision this screen exists to prevent.
- **A focus trap in the metrics dialog.** It has `role="dialog"`, `aria-modal` and Escape-to-close; a full trap is more machinery than it earns.
