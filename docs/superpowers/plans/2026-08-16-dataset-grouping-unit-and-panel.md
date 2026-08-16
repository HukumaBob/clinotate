# Dataset Grouping Unit and Balance Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a real split-leakage defect by making the *video* the unit of data independence, add per-class limits whose selection is spread across that unit, and surface the balance analysis the backend already computes but the screen hides.

**Architecture:** One `grouping_key` helper defines the indivisible unit (video when present, else the sequence) and is applied in two places: `assign_splits` deals whole units instead of sequences, and class limits apportion their cap across units. The panel additions are mostly display of data that already exists — nine computed metrics of which two are shown, and a `balance_metrics` snapshot already saved and already returned by the API.

**Tech Stack:** FastAPI, SQLAlchemy 2.0, Alembic, Pydantic v2, pytest, React + TypeScript, TanStack Query, Vitest, Tailwind (dark-only).

**Spec:** [docs/superpowers/specs/2026-08-16-dataset-grouping-unit-and-panel-design.md](../specs/2026-08-16-dataset-grouping-unit-and-panel-design.md)

## Global Constraints

- **Language:** English only in all committed content — code, comments, docstrings, UI copy. No Russian. (Standing exception: the pre-existing Russian design specs and ROADMAP's verbatim quotes of their headings.)
- **UI theme:** dark only. Never introduce light-background Tailwind classes.
- **`taxonomy_version`:** copy from the source row; never re-derive. Already correct — do not change it.
- **JSON, not JSONB** for new columns: every existing JSON-ish column in this repo (`Annotation.payload`, `Sequence.crop_box`, `Job.payload`, `Dataset.split_config`) is `JSON`. Do not "upgrade" it.
- **API contract:** after any backend schema/route change run `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py` (the `PYTHONPATH=.` is required) and verify with `git diff --stat openapi.json` that it changed. Never hand-edit `frontend/src/shared/api/generated/`.
- **TDD:** every backend task and every frontend task with logic gets a failing test, actually run and observed failing, before the implementation.
- **Git:** commit directly to `master`. No branch, no worktree, no merge, no push.

### Environment facts — verified, do not re-derive

- **`npm run build` (tsc) is RED and predates this work** (~235 errors: a broken repo-wide jest-dom matcher type setup, plus an `annotation_scope` literal-union mismatch in old fixtures). NOT an acceptance gate. New tests using `toBeInTheDocument()` add more instances of that same gap — expected.
- **Gates:** `npm test` green (baseline **436**), and no new product-code tsc errors. Exactly one is expected and accepted: `useDatasets.ts(26,38): Property 'error' does not exist on type 'never'` — a repo-wide parameterless-GET typing defect that also affects `useSettings.ts`. Check with:
  `npx tsc -b --noEmit 2>&1 | grep -E "features/datasets|entities/useDatasets" | grep -v "\.test\."`
- **Backend baseline: 282 passed / 15 pre-existing failures** (`test_jobs.py`, `test_mask_postprocess_endpoint.py`, `test_media_service.py` and others). Do not fix those 15; do not report them as breakage.
- **Backend tests run against the REAL dev database** (`conftest.py` builds `endoscopy_test` via `create_all` and drops it at teardown — Alembic never runs there). Use uniquely-named throwaway fixtures that roll back. **Never TRUNCATE/DELETE/DROP anything in `endoscopy`** — it holds real taxonomy and live annotations.
- Current Alembic head at plan time: `90d664916285`. Task 3's migration revises it.
- **Model field names that bite** (verified by constructing each for real): `Video` takes `duration_seconds`, not `duration`, and its `checksum` is required with no default. `Frame` takes `frame_index`, not `index`, and `width`/`height` are required. `Sequence.duration` does exist. The fixtures below already account for all of this — do not "simplify" them.

### Real data this plan is verified against

Five annotated sequences map to **three** grouping units:

| unit | sequences | annotated frames |
|---|---|---|
| video 2178 | 2323 (87), 2322 (9) | 96 |
| video 2113 | 2074 `caecum01` (29), 2075 `ileum` (3) | 32 |
| photo batch | 2094 (32) | 32 |

**The defect to fix, reproduced:** today `assign_splits` puts 2074 in train and 2075 in val — video 2113 on both sides of the split.

---

### Task 1: `grouping_key` — the unit of data independence

**Files:**
- Modify: `backend/app/datasets/service.py` (append)
- Test: `backend/tests/test_grouping_unit.py`

**Interfaces:**
- Consumes: `Sequence` from `app.media.models`.
- Produces:
  - `GroupingKey = tuple[str, int]` — a type alias.
  - `grouping_key(video_id: int | None, sequence_id: int) -> GroupingKey` — returns `("video", video_id)` when `video_id` is not None, else `("sequence", sequence_id)`.
  - `grouping_keys_for_sequences(session: Session, sequence_ids: list[int]) -> dict[int, GroupingKey]` — one query, maps each sequence id to its key.

**Why this exists:** a sequence is a slice of one video, so sequences cut from the same video share a patient, scope, bowel prep and session. They are not independent samples. A photo batch has no video, so the sequence is its own unit.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_grouping_unit.py`:

```python
import app.main  # noqa: F401 -- registers every model on Base.metadata for create_all
import sqlalchemy as sa

from app.datasets.service import grouping_key, grouping_keys_for_sequences
from app.db import SessionLocal
from app.media.models import Sequence, Video


def test_video_backed_sequences_share_one_key():
    assert grouping_key(2113, 2074) == grouping_key(2113, 2075)


def test_a_videoless_sequence_is_its_own_key():
    assert grouping_key(None, 2094) == ("sequence", 2094)


def test_a_videoless_sequence_never_collides_with_a_video_key():
    # ("video", 7) and ("sequence", 7) must be different units even though
    # the integer is the same.
    assert grouping_key(7, 99) != grouping_key(None, 7)


def test_grouping_keys_for_sequences_maps_every_requested_id():
    session = SessionLocal()
    try:
        video = Video(title="gk-video", storage_key="gk/v.mp4", checksum="gk-checksum",
                      fps=25.0, duration_seconds=1.0)
        session.add(video)
        session.flush()
        with_video_a = Sequence(name="gk-a", start_time=0, duration=1, video_id=video.id)
        with_video_b = Sequence(name="gk-b", start_time=0, duration=1, video_id=video.id)
        without_video = Sequence(name="gk-c", start_time=0, duration=1, video_id=None)
        session.add_all([with_video_a, with_video_b, without_video])
        session.flush()

        keys = grouping_keys_for_sequences(
            session, [with_video_a.id, with_video_b.id, without_video.id]
        )

        assert keys[with_video_a.id] == keys[with_video_b.id]
        assert keys[without_video.id] == ("sequence", without_video.id)
        assert len(set(keys.values())) == 2
    finally:
        session.rollback()
        session.close()


def test_grouping_keys_for_sequences_handles_an_empty_request():
    session = SessionLocal()
    try:
        assert grouping_keys_for_sequences(session, []) == {}
    finally:
        session.close()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_grouping_unit.py -v`
Expected: FAIL with `ImportError: cannot import name 'grouping_key' from 'app.datasets.service'`.

- [ ] **Step 3: Implement**

Append to `backend/app/datasets/service.py` (put the `Sequence` import in the module's existing top-level import block — never mid-file):

```python
GroupingKey = tuple[str, int]


def grouping_key(video_id: int | None, sequence_id: int) -> GroupingKey:
    """The unit within which data is NOT independent.

    A sequence is a slice of one video, so every sequence cut from the same
    video shares a patient, a scope, a bowel prep and a session. Treating
    those as independent samples leaks: the same procedure lands on both
    sides of a split, and validation then measures memorisation of that
    procedure rather than generalisation. A photo batch has no video, so the
    sequence is its own unit.

    The tag distinguishes the two id spaces -- ("video", 7) and
    ("sequence", 7) are different units.
    """
    if video_id is not None:
        return ("video", video_id)
    return ("sequence", sequence_id)


def grouping_keys_for_sequences(
    session: Session, sequence_ids: list[int]
) -> dict[int, GroupingKey]:
    """Map each sequence id to its grouping key in one query."""
    if not sequence_ids:
        return {}
    rows = (
        session.query(Sequence.id, Sequence.video_id)
        .filter(Sequence.id.in_(sequence_ids))
        .all()
    )
    return {row.id: grouping_key(row.video_id, row.id) for row in rows}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_grouping_unit.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/datasets/service.py backend/tests/test_grouping_unit.py
git commit -m "feat: add grouping_key, the unit of data independence"
```

---

### Task 2: Assign splits per grouping unit

**Files:**
- Modify: `backend/app/datasets/service.py` (`assign_splits`, `create_dataset`)
- Test: `backend/tests/test_dataset_splits_by_unit.py`

**Interfaces:**
- Consumes: `grouping_key`, `grouping_keys_for_sequences` from Task 1.
- Produces: `assign_splits(sequence_ids, split_config, frame_counts_by_sequence=None, grouping_keys=None) -> dict[int, SplitName]`. When `grouping_keys` is omitted, behaviour is unchanged (each sequence is its own unit), so existing callers and tests keep working.

**The defect this fixes, on real data:** video 2113 owns sequences 2074 and 2075; today they land in train and val respectively, putting one procedure on both sides of the split.

**What does NOT change:** the largest-remainder apportionment, the minimum guarantees (≥1 unit in train always, ≥1 in val at 2+ units, ≥1 in test at 3+), and determinism. Only the identity of the indivisible thing changes.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_dataset_splits_by_unit.py`:

```python
import app.main  # noqa: F401
import collections

from app.datasets.service import assign_splits


def test_sequences_of_one_video_never_separate():
    # The real defect: video 2113 owns 2074 and 2075.
    keys = {
        2074: ("video", 2113),
        2075: ("video", 2113),
        2094: ("sequence", 2094),
        2322: ("video", 2178),
        2323: ("video", 2178),
    }
    counts = {2323: 87, 2094: 32, 2074: 29, 2322: 9, 2075: 3}

    assignment = assign_splits(list(keys), {"train": 70, "val": 20}, counts, keys)

    splits_per_unit = collections.defaultdict(set)
    for sequence_id, split in assignment.items():
        splits_per_unit[keys[sequence_id]].add(split.value)
    for unit, splits in splits_per_unit.items():
        assert len(splits) == 1, f"unit {unit} was split across {splits}"


def test_every_sequence_still_receives_a_split():
    keys = {1: ("video", 10), 2: ("video", 10), 3: ("sequence", 3)}
    assignment = assign_splits(list(keys), {"train": 70, "val": 20}, {1: 5, 2: 5, 3: 5}, keys)
    assert set(assignment) == {1, 2, 3}


def test_three_units_fill_all_three_splits():
    keys = {1: ("video", 10), 2: ("video", 10), 3: ("sequence", 3), 4: ("sequence", 4)}
    counts = {1: 50, 2: 50, 3: 30, 4: 20}
    assignment = assign_splits(list(keys), {"train": 70, "val": 20}, counts, keys)
    assert {s.value for s in assignment.values()} == {"train", "val", "test"}


def test_two_units_still_guarantee_train_and_val():
    keys = {1: ("video", 10), 2: ("sequence", 2)}
    assignment = assign_splits(list(keys), {"train": 70, "val": 20}, {1: 9, 2: 1}, keys)
    assert {s.value for s in assignment.values()} == {"train", "val"}


def test_assignment_is_deterministic_regardless_of_input_order():
    keys = {1: ("video", 10), 2: ("video", 10), 3: ("sequence", 3), 4: ("sequence", 4)}
    counts = {1: 50, 2: 50, 3: 30, 4: 20}
    forward = assign_splits([1, 2, 3, 4], {"train": 70, "val": 20}, counts, keys)
    backward = assign_splits([4, 3, 2, 1], {"train": 70, "val": 20}, counts, keys)
    assert {k: v.value for k, v in forward.items()} == {k: v.value for k, v in backward.items()}


def test_omitting_grouping_keys_treats_each_sequence_as_its_own_unit():
    # Backward compatibility for callers that have no keys handy.
    assignment = assign_splits([1, 2, 3], {"train": 70, "val": 20}, {1: 3, 2: 2, 3: 1})
    assert set(assignment) == {1, 2, 3}
    assert {s.value for s in assignment.values()} == {"train", "val", "test"}


def test_a_unit_is_ordered_by_its_total_contributed_frames():
    # The big video must reach train even though each of its sequences is
    # individually smaller than the standalone one.
    keys = {1: ("video", 10), 2: ("video", 10), 3: ("sequence", 3)}
    counts = {1: 30, 2: 30, 3: 50}  # video 10 totals 60 > 50
    assignment = assign_splits(list(keys), {"train": 70, "val": 20}, counts, keys)
    assert assignment[1].value == "train"
    assert assignment[2].value == "train"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_dataset_splits_by_unit.py -v`
Expected: FAIL — `assign_splits` takes 3 positional arguments but 4 were given, and the first test fails on the unit being split.

- [ ] **Step 3: Rewrite `assign_splits` to deal units**

In `backend/app/datasets/service.py`, change the signature and the body so it apportions over units. Keep every existing docstring paragraph and add the unit explanation:

```python
def assign_splits(
    sequence_ids: list[int],
    split_config: dict,
    frame_counts_by_sequence: dict[int, int] | None = None,
    grouping_keys: dict[int, GroupingKey] | None = None,
) -> dict[int, SplitName]:
    """Assign whole grouping units to splits; sequences inherit their unit's.

    The indivisible unit is the video, not the sequence: several sequences
    cut from one video are the same procedure, so putting one in train and
    another in val leaks -- validation would measure memorisation of that
    procedure. A sequence with no video is its own unit.

    Units are processed in DESCENDING contributed-frame-count order (summed
    over the unit's sequences), largest first, and dealt largest-remainder
    style: each unit goes to whichever split is currently furthest below its
    target share. Dealing largest-first into "most under target" rather than
    block-filling train, then val, then test means the few units that
    actually carry content get spread across all three splits.

    With few units the realized fractions cannot match the requested ones --
    expected, and the caller reports realized counts rather than forcing
    them even.

    When `grouping_keys` is omitted every sequence is treated as its own
    unit, preserving the old behaviour for callers without keys.
    """
    if not sequence_ids:
        return {}

    frame_counts_by_sequence = frame_counts_by_sequence or {}
    keys = grouping_keys or {sid: ("sequence", sid) for sid in sequence_ids}

    sequences_by_unit: dict[GroupingKey, list[int]] = {}
    for sequence_id in sequence_ids:
        unit = keys.get(sequence_id, ("sequence", sequence_id))
        sequences_by_unit.setdefault(unit, []).append(sequence_id)

    frames_by_unit = {
        unit: sum(frame_counts_by_sequence.get(sid, 0) for sid in members)
        for unit, members in sequences_by_unit.items()
    }
    ordered_units = sorted(
        sequences_by_unit,
        key=lambda unit: (-frames_by_unit[unit], unit[0], unit[1]),
    )
    total = len(ordered_units)

    train_pct = split_config.get("train", 70) / 100
    val_pct = split_config.get("val", 20) / 100
    test_pct = max(1 - train_pct - val_pct, 0.0)
    targets = {"train": total * train_pct, "val": total * val_pct, "test": total * test_pct}

    min_order = ["train", "val", "test"]
    min_n = {
        "train": 1 if total >= 1 else 0,
        "val": 1 if total >= 2 else 0,
        "test": 1 if total >= 3 else 0,
    }

    counts = {"train": 0, "val": 0, "test": 0}
    unit_split: dict[GroupingKey, SplitName] = {}
    remaining = list(ordered_units)

    for name in min_order:
        while counts[name] < min_n[name] and remaining:
            unit = remaining.pop(0)
            counts[name] += 1
            unit_split[unit] = SplitName(name)

    for unit in remaining:
        chosen = max(counts, key=lambda name: targets[name] - counts[name])
        counts[chosen] += 1
        unit_split[unit] = SplitName(chosen)

    assignment: dict[int, SplitName] = {}
    for unit, members in sequences_by_unit.items():
        for sequence_id in members:
            assignment[sequence_id] = unit_split[unit]
    return assignment
```

- [ ] **Step 4: Pass real keys from `create_dataset`**

In `create_dataset`, just before the `assign_splits(...)` call, fetch the keys and pass them:

```python
    grouping_keys = grouping_keys_for_sequences(session, payload.sequence_ids)
    split_by_sequence = assign_splits(
        payload.sequence_ids, payload.split_config, frame_counts_by_sequence, grouping_keys
    )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_dataset_splits_by_unit.py tests/test_datasets_api.py -v`
Expected: PASS — the 7 new tests, plus the existing API tests (whose sequence-level assertion still holds, since a unit never splits).

- [ ] **Step 6: Verify the real defect is gone**

```bash
cd backend && PYTHONPATH=. uv run python -c "
from app.db import SessionLocal
from app.datasets.service import assign_splits, grouping_keys_for_sequences
import sqlalchemy as sa, collections
s = SessionLocal()
rows = s.execute(sa.text('''SELECT s.id, s.video_id FROM sequences s
 WHERE s.id IN (SELECT DISTINCT f.sequence_id FROM frames f
                JOIN annotations a ON a.frame_id = f.id)''')).all()
ids = [r[0] for r in rows]
video_by_seq = {r[0]: r[1] for r in rows}
keys = grouping_keys_for_sequences(s, ids)
a = assign_splits(ids, {'train': 70, 'val': 20}, {i: 1 for i in ids}, keys)
by_video = collections.defaultdict(set)
for sid, split in a.items():
    by_video[video_by_seq[sid]].add(split.value)
leak = [v for v, sp in by_video.items() if v is not None and len(sp) > 1]
print('assignment:', {k: v.value for k, v in a.items()})
print('videos across >1 split:', leak if leak else 'NONE -- defect fixed')
s.close()"
```

Expected: `NONE -- defect fixed`, and sequences 2074/2075 share a split.

- [ ] **Step 7: Commit**

```bash
git add backend/app/datasets/service.py backend/tests/test_dataset_splits_by_unit.py
git commit -m "fix: assign dataset splits per video, not per sequence"
```

---

### Task 3: `class_limits` — cap an over-represented class

**Files:**
- Modify: `backend/app/datasets/models.py` (`Dataset`)
- Create: `backend/alembic/versions/<generated>_add_class_limits_to_datasets.py`
- Modify: `backend/app/datasets/service.py` (`collect_frames`, `compute_balance`, `create_dataset`)
- Modify: `backend/app/datasets/schemas.py` (`BalanceRequest`, `DatasetCreate`, `DatasetRead`)
- Modify: `backend/app/datasets/router.py` (pass limits through both endpoints)
- Modify: `openapi.json` (regenerated)
- Test: `backend/tests/test_dataset_class_limits.py`

**Interfaces:**
- Consumes: `grouping_keys_for_sequences` from Task 1; `resolve_class`, `build_label_tree`, `GroupingRules` from `app.taxonomy.hierarchy`.
- Produces:
  - `Dataset.class_limits` — JSON, `{label_id: max_instances}`, default `{}`.
  - `apply_class_limits(composition, annotation_rows, limits, tree, rules, grouping_keys, sequence_by_frame) -> list[FrameComposition]`.
  - `collect_frames(..., class_limits: dict[int, int] | None = None)` — same call shape as today plus one optional argument.

**Keys are RESOLVED class ids** — the same id space the panel displays and `excluded_label_ids` already uses. Using raw leaf ids here would make capping a collapsed group a silent no-op, exactly the bug already fixed for exclusions.

**Selection must spread across grouping units.** Taking the first N by id draws from whichever procedures were annotated first; taking N at random needs a stored seed, which conflicts with composition being frozen at save time. Proportional-by-unit gives the model the class under different scopes, preps and patients, and is reproducible with no seed because every tie breaks by id.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_dataset_class_limits.py`:

```python
import app.main  # noqa: F401
import sqlalchemy as sa

from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
from app.datasets.models import TaskType
from app.datasets.service import collect_frames
from app.db import SessionLocal
from app.media.models import Frame, Sequence, Video
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure


def _island(session, tag, sequences_per_video=2, frames_per_sequence=6):
    """Two videos' worth of sequences, so limits have units to spread across."""
    procedure = Procedure(name=f"cl-{tag}-proc")
    session.add(procedure)
    session.flush()
    category = Category(name=f"cl-{tag}-cat", procedure_id=procedure.id)
    session.add(category)
    session.flush()
    region = EvaluationType(name=f"cl-{tag}-region", annotation_scope=AnnotationScope.REGION)
    session.add(region)
    session.flush()

    sequences = []
    for v in range(2):
        video = Video(title=f"cl-{tag}-v{v}", storage_key=f"cl/{tag}/{v}.mp4",
                      checksum=f"cl-{tag}-{v}", fps=25.0, duration_seconds=1.0)
        session.add(video)
        session.flush()
        for q in range(sequences_per_video):
            sequence = Sequence(
                name=f"cl-{tag}-v{v}s{q}", start_time=0, duration=1,
                procedure_id=procedure.id, video_id=video.id,
            )
            session.add(sequence)
            session.flush()
            frames = [
                Frame(sequence_id=sequence.id, storage_key=f"cl/{tag}/{v}{q}{i}",
                      frame_index=i, width=64, height=64)
                for i in range(frames_per_sequence)
            ]
            session.add_all(frames)
            session.flush()
            sequences.append((video.id, sequence, frames))

    user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
    return category, region, sequences, user_id


def _label(session, category, evaluation_type, name, parent_id=None, is_abstract=False):
    label = Label(
        name=name, category_id=category.id, evaluation_type_id=evaluation_type.id,
        parent_label_id=parent_id, is_abstract=is_abstract,
    )
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


def _instances(composition):
    return sum(len(c.annotation_ids) for c in composition)


def test_a_limit_caps_the_number_of_instances():
    session = SessionLocal()
    try:
        category, region, sequences, user_id = _island(session, "cap")
        common = _label(session, category, region, "cl-cap-common")
        for _, _, frames in sequences:
            for frame in frames:
                _annotate(session, frame, common, user_id)
        sequence_ids = [seq.id for _, seq, _ in sequences]

        uncapped = collect_frames(session, sequence_ids, TaskType.DETECTION, set())
        capped = collect_frames(
            session, sequence_ids, TaskType.DETECTION, set(), class_limits={common.id: 8}
        )

        assert _instances(uncapped) == 24
        assert _instances(capped) == 8
    finally:
        session.rollback()
        session.close()


def test_a_limit_spreads_across_grouping_units():
    session = SessionLocal()
    try:
        category, region, sequences, user_id = _island(session, "spread")
        common = _label(session, category, region, "cl-spread-common")
        for _, _, frames in sequences:
            for frame in frames:
                _annotate(session, frame, common, user_id)
        sequence_ids = [seq.id for _, seq, _ in sequences]
        video_by_sequence = {seq.id: video_id for video_id, seq, _ in sequences}

        capped = collect_frames(
            session, sequence_ids, TaskType.DETECTION, set(), class_limits={common.id: 8}
        )

        frame_to_sequence = {}
        for _, seq, frames in sequences:
            for frame in frames:
                frame_to_sequence[frame.id] = seq.id
        per_video: dict[int, int] = {}
        for item in capped:
            video_id = video_by_sequence[frame_to_sequence[item.frame_id]]
            per_video[video_id] = per_video.get(video_id, 0) + len(item.annotation_ids)

        # Two videos, 12 annotations each, cap 8 -> 4 from each video.
        assert len(per_video) == 2
        assert set(per_video.values()) == {4}
    finally:
        session.rollback()
        session.close()


def test_capping_is_reproducible():
    session = SessionLocal()
    try:
        category, region, sequences, user_id = _island(session, "repro")
        common = _label(session, category, region, "cl-repro-common")
        for _, _, frames in sequences:
            for frame in frames:
                _annotate(session, frame, common, user_id)
        sequence_ids = [seq.id for _, seq, _ in sequences]

        first = collect_frames(
            session, sequence_ids, TaskType.DETECTION, set(), class_limits={common.id: 7}
        )
        second = collect_frames(
            session, sequence_ids, TaskType.DETECTION, set(), class_limits={common.id: 7}
        )

        assert [(c.frame_id, c.annotation_ids) for c in first] == [
            (c.frame_id, c.annotation_ids) for c in second
        ]
    finally:
        session.rollback()
        session.close()


def test_a_limit_at_or_above_the_total_is_a_no_op():
    session = SessionLocal()
    try:
        category, region, sequences, user_id = _island(session, "noop")
        common = _label(session, category, region, "cl-noop-common")
        for _, _, frames in sequences:
            for frame in frames:
                _annotate(session, frame, common, user_id)
        sequence_ids = [seq.id for _, seq, _ in sequences]

        uncapped = collect_frames(session, sequence_ids, TaskType.DETECTION, set())
        capped = collect_frames(
            session, sequence_ids, TaskType.DETECTION, set(), class_limits={common.id: 999}
        )

        assert _instances(capped) == _instances(uncapped)
    finally:
        session.rollback()
        session.close()


def test_a_frame_whose_annotations_are_all_capped_away_drops_out_and_is_not_a_negative():
    # Capping is a bookkeeping decision, not a claim the frame is empty --
    # the same rule exclusions already follow.
    session = SessionLocal()
    try:
        category, region, sequences, user_id = _island(session, "drop")
        common = _label(session, category, region, "cl-drop-common")
        for _, _, frames in sequences:
            for frame in frames:
                _annotate(session, frame, common, user_id)
        sequence_ids = [seq.id for _, seq, _ in sequences]

        capped = collect_frames(
            session, sequence_ids, TaskType.DETECTION, set(), class_limits={common.id: 4}
        )

        assert all(not c.is_negative for c in capped)
        assert len(capped) == 4
    finally:
        session.rollback()
        session.close()


def test_capping_a_collapsed_parent_caps_its_children():
    # Limits key on RESOLVED class ids, like exclusions do.
    session = SessionLocal()
    try:
        category, region, sequences, user_id = _island(session, "parent")
        polyp = _label(session, category, region, "cl-parent-polyp", is_abstract=True)
        ip = _label(session, category, region, "cl-parent-ip", parent_id=polyp.id)
        is_ = _label(session, category, region, "cl-parent-is", parent_id=polyp.id)
        for index, (_, _, frames) in enumerate(sequences):
            for frame in frames:
                _annotate(session, frame, ip if index % 2 == 0 else is_, user_id)
        sequence_ids = [seq.id for _, seq, _ in sequences]

        from app.taxonomy.hierarchy import GroupingRules, build_label_tree

        tree = build_label_tree(session)
        capped = collect_frames(
            session, sequence_ids, TaskType.DETECTION, set(),
            tree=tree, rules=GroupingRules(), class_limits={polyp.id: 6},
        )

        assert _instances(capped) == 6
    finally:
        session.rollback()
        session.close()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_dataset_class_limits.py -v`
Expected: FAIL — `collect_frames() got an unexpected keyword argument 'class_limits'`.

- [ ] **Step 3: Add the column and its migration**

In `backend/app/datasets/models.py`, inside `class Dataset`, after `excluded_label_ids`:

```python
    class_limits: Mapped[dict] = mapped_column(JSON, default=dict)
```

Run `cd backend && uv run alembic revision -m "add class limits to datasets"`, confirm `down_revision` is `'90d664916285'` (verify with `uv run alembic heads` first), then:

```python
def upgrade() -> None:
    op.add_column(
        'datasets',
        sa.Column('class_limits', sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )


def downgrade() -> None:
    op.drop_column('datasets', 'class_limits')
```

Note the `server_default` — the column is NOT NULL on a table that may already have rows.

Apply it: `cd backend && uv run alembic upgrade head`.

- [ ] **Step 4: Implement the capping**

Append to `backend/app/datasets/service.py`:

```python
def _apportion(total: int, weights: dict, order: list) -> dict:
    """Split `total` across `order` proportionally to `weights`.

    Largest-remainder: floor each share, then hand the leftovers to the
    largest fractional parts, ties broken by the caller's order. Never
    allocates more to a key than its own weight.
    """
    weight_sum = sum(weights[key] for key in order)
    if weight_sum <= 0 or total <= 0:
        return {key: 0 for key in order}

    exact = {key: total * weights[key] / weight_sum for key in order}
    allocation = {key: min(int(exact[key]), weights[key]) for key in order}
    leftover = total - sum(allocation.values())

    while leftover > 0:
        candidates = [key for key in order if allocation[key] < weights[key]]
        if not candidates:
            break
        best = max(candidates, key=lambda key: (exact[key] - allocation[key],))
        allocation[best] += 1
        leftover -= 1
    return allocation


def apply_class_limits(
    composition: list[FrameComposition],
    class_by_annotation: dict[int, int],
    limits: dict[int, int],
    unit_by_frame: dict[int, GroupingKey],
    sequence_by_frame: dict[int, int],
) -> list[FrameComposition]:
    """Cap each limited class, spreading the survivors across grouping units.

    Taking the first N by id would draw from whichever procedures were
    annotated first; taking N at random would need a stored seed, which
    conflicts with composition being frozen at save time. Apportioning by
    unit gives the model the class under different scopes, preps and
    patients, and is reproducible with no seed because every tie breaks by
    id.

    A frame whose annotations are all capped away leaves the dataset rather
    than becoming a negative -- a cap is a bookkeeping decision, not a claim
    that the frame is empty.
    """
    if not limits:
        return composition

    # annotation ids of each limited class, bucketed by unit then sequence
    per_class: dict[int, dict[GroupingKey, dict[int, list[int]]]] = {}
    for item in composition:
        unit = unit_by_frame.get(item.frame_id, ("sequence", item.frame_id))
        sequence_id = sequence_by_frame.get(item.frame_id, 0)
        for annotation_id in item.annotation_ids:
            class_id = class_by_annotation.get(annotation_id)
            if class_id is None or class_id not in limits:
                continue
            per_class.setdefault(class_id, {}).setdefault(unit, {}).setdefault(
                sequence_id, []
            ).append(annotation_id)

    keep: set[int] = set()
    for class_id, by_unit in per_class.items():
        cap = limits[class_id]
        unit_order = sorted(by_unit, key=lambda unit: (unit[0], unit[1]))
        unit_weights = {
            unit: sum(len(ids) for ids in by_unit[unit].values()) for unit in unit_order
        }
        per_unit = _apportion(cap, unit_weights, unit_order)

        for unit in unit_order:
            by_sequence = by_unit[unit]
            sequence_order = sorted(by_sequence)
            sequence_weights = {sid: len(by_sequence[sid]) for sid in sequence_order}
            per_sequence = _apportion(per_unit[unit], sequence_weights, sequence_order)
            for sequence_id in sequence_order:
                keep.update(sorted(by_sequence[sequence_id])[: per_sequence[sequence_id]])

    limited: list[FrameComposition] = []
    for item in composition:
        if item.is_negative:
            limited.append(item)
            continue
        kept_ids = [
            annotation_id
            for annotation_id in item.annotation_ids
            if class_by_annotation.get(annotation_id) not in limits
            or annotation_id in keep
        ]
        if kept_ids:
            limited.append(
                FrameComposition(frame_id=item.frame_id, annotation_ids=kept_ids)
            )
    return limited
```

Then extend `collect_frames`: add `class_limits: dict[int, int] | None = None` as its last parameter, and just before the `return`, when `class_limits` is truthy, build the three maps it needs (`class_by_annotation` from the same resolution already performed for exclusions, `unit_by_frame` via `grouping_keys_for_sequences`, `sequence_by_frame` from the frames already loaded) and pass the composition through `apply_class_limits`.

- [ ] **Step 5: Thread it through the API**

In `backend/app/datasets/schemas.py`, add to both `BalanceRequest` and `DatasetCreate`:

```python
    class_limits: dict[int, int] = Field(default_factory=dict)
```

and to `DatasetRead`:

```python
    class_limits: dict[int, int]
```

In `backend/app/datasets/router.py`, pass `payload.class_limits` into `compute_balance` (which forwards it to `collect_frames`) in the `/balance` endpoint, and include `"class_limits": dataset.class_limits` in `_serialize_summary`/`_serialize_one`. In `create_dataset`, store `class_limits=dict(payload.class_limits)` on the `Dataset` row and pass the limits into the composition call.

`compute_balance` gains the same optional `class_limits` parameter and forwards it, so the live panel previews the capped numbers.

- [ ] **Step 6: Run the tests**

Run: `cd backend && uv run pytest tests/test_dataset_class_limits.py tests/test_datasets_api.py tests/test_dataset_balance.py -v`
Expected: PASS.

- [ ] **Step 7: Regenerate OpenAPI**

```bash
cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py
git diff --stat openapi.json
```
Expected: non-empty diff adding `class_limits` to the three schemas. If empty, stop — the frontend task depends on it.

- [ ] **Step 8: Commit**

```bash
git add backend/app/datasets/ backend/alembic/versions/ backend/tests/test_dataset_class_limits.py openapi.json
git commit -m "feat: cap over-represented classes, spread across grouping units"
```

---

### Task 4: Per-scope annotation counts on the sequence list

**Files:**
- Modify: `backend/app/media/schemas.py` (`SequenceListItem`)
- Modify: `backend/app/media/router.py:~410-470` (the list query and the item construction)
- Modify: `openapi.json` (regenerated)
- Test: `backend/tests/test_media_sequence_scope_counts.py`

**Interfaces:**
- Produces: `SequenceListItem.region_annotation_count: int` and `SequenceListItem.frame_annotation_count: int`.

`video_id`, `frame_count` and `labeled_frame_count` are already returned — only the per-scope counts are missing.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_media_sequence_scope_counts.py`:

```python
import app.main  # noqa: F401
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _register_and_login(email: str) -> dict[str, str]:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "admin"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_sequence_list_reports_per_scope_annotation_counts():
    headers = _register_and_login("seq-scope1@example.com")

    response = client.get("/media/sequences", params={"page": 1, "page_size": 5}, headers=headers)

    assert response.status_code == 200
    items = response.json()["items"]
    assert items, "expected at least one sequence in the dev database"
    for item in items:
        assert "region_annotation_count" in item
        assert "frame_annotation_count" in item
        assert item["region_annotation_count"] >= 0
        assert item["frame_annotation_count"] >= 0
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && uv run pytest tests/test_media_sequence_scope_counts.py -v`
Expected: FAIL with `KeyError` / assertion on the missing field.

- [ ] **Step 3: Add the fields**

In `backend/app/media/schemas.py`, add to `SequenceListItem` after `labeled_frame_count`:

```python
    region_annotation_count: int = 0
    frame_annotation_count: int = 0
```

In `backend/app/media/router.py`, alongside the existing `labeled_counts_by_sequence` query, add one grouped query counting annotations per sequence per scope:

```python
        scope_rows = (
            session.query(
                Frame.sequence_id,
                EvaluationType.annotation_scope,
                func.count(Annotation.id),
            )
            .join(Annotation, Annotation.frame_id == Frame.id)
            .join(Label, Label.id == Annotation.label_id)
            .join(EvaluationType, EvaluationType.id == Label.evaluation_type_id)
            .filter(Frame.sequence_id.in_(sequence_ids))
            .group_by(Frame.sequence_id, EvaluationType.annotation_scope)
            .all()
        )
        region_counts: dict[int, int] = {}
        frame_counts: dict[int, int] = {}
        for sequence_id, scope, count in scope_rows:
            target = region_counts if scope == AnnotationScope.REGION else frame_counts
            target[sequence_id] = count
```

Then pass them into the `SequenceListItem(...)` construction:

```python
                region_annotation_count=region_counts.get(sequence.id, 0),
                frame_annotation_count=frame_counts.get(sequence.id, 0),
```

Add whatever of `Label`, `EvaluationType`, `AnnotationScope`, `func` is not already imported at the top of `router.py`. Use `sequence_ids` — the same list the existing counts query already uses.

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run pytest tests/test_media_sequence_scope_counts.py tests/test_media.py -v`
Expected: PASS.

- [ ] **Step 5: Regenerate OpenAPI and commit**

```bash
cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py
git diff --stat openapi.json
git add backend/app/media/ backend/tests/test_media_sequence_scope_counts.py openapi.json
git commit -m "feat: report per-scope annotation counts on the sequence list"
```

---

### Task 5: Recommendations derived from the metrics

**Files:**
- Modify: `backend/app/datasets/service.py` (append)
- Modify: `backend/app/datasets/schemas.py` (`BalanceReportRead`)
- Modify: `backend/app/datasets/router.py` (include in the response)
- Modify: `openapi.json` (regenerated)
- Test: `backend/tests/test_dataset_recommendations.py`

**Interfaces:**
- Produces:
  - `Recommendation` — dataclass with `kind: str`, `message: str`.
  - `build_recommendations(report: BalanceReport, concentration: dict[int, float]) -> list[Recommendation]`.
  - `BalanceReport.recommendations: list[Recommendation]` and `BalanceReportRead.recommendations: list[RecommendationRead]`.

Computed from the data, not canned strings: each rule names the actual class and number involved.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_dataset_recommendations.py`:

```python
import app.main  # noqa: F401

from app.datasets.service import BalanceReport, ClassCount, build_recommendations


def _report(classes, below, metrics, threshold=10, negatives=0):
    return BalanceReport(
        classes=classes, total_frames=sum(c.frames for c in classes),
        negative_frames=negatives, below_threshold=below,
        threshold=threshold, metrics=metrics, recommendations=[],
    )


def test_under_threshold_classes_are_named():
    report = _report(
        [ClassCount(1, "polyp", 35, 33), ClassCount(2, "ileum", 1, 1)],
        ["ileum"], {"severity": "severe_imbalance", "imbalance_ratio": 35.0},
    )
    messages = " ".join(r.message for r in build_recommendations(report, {}))
    assert "ileum" in messages


def test_severe_imbalance_suggests_focal_loss_or_weighted_sampling():
    report = _report(
        [ClassCount(1, "polyp", 35, 33), ClassCount(2, "ileum", 1, 1)],
        ["ileum"], {"severity": "severe_imbalance", "imbalance_ratio": 35.0},
    )
    kinds = {r.kind for r in build_recommendations(report, {})}
    assert "loss_weighting" in kinds


def test_a_high_ratio_suggests_capping_the_largest_class_by_name():
    report = _report(
        [ClassCount(1, "polyp", 35, 33), ClassCount(2, "ileum", 1, 1)],
        ["ileum"], {"severity": "severe_imbalance", "imbalance_ratio": 35.0},
    )
    capping = [r for r in build_recommendations(report, {}) if r.kind == "cap_largest"]
    assert capping and "polyp" in capping[0].message


def test_a_class_concentrated_in_one_unit_is_flagged():
    report = _report(
        [ClassCount(1, "polyp", 35, 33)], [], {"severity": "moderate_imbalance", "imbalance_ratio": 2.0},
    )
    recs = build_recommendations(report, {1: 1.0})
    assert any(r.kind == "single_unit_concentration" and "polyp" in r.message for r in recs)


def test_a_balanced_report_produces_no_alarming_recommendations():
    report = _report(
        [ClassCount(1, "a", 20, 20), ClassCount(2, "b", 19, 19)],
        [], {"severity": "balanced", "imbalance_ratio": 1.05},
    )
    kinds = {r.kind for r in build_recommendations(report, {1: 0.4, 2: 0.4})}
    assert "loss_weighting" not in kinds
    assert "cap_largest" not in kinds


def test_an_empty_report_produces_no_recommendations():
    report = _report([], [], {"severity": "no_data"})
    assert build_recommendations(report, {}) == []
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && uv run pytest tests/test_dataset_recommendations.py -v`
Expected: FAIL with `ImportError: cannot import name 'build_recommendations'`.

- [ ] **Step 3: Implement**

Append to `backend/app/datasets/service.py`, and add `recommendations: list["Recommendation"] = field(default_factory=list)` to the `BalanceReport` dataclass:

```python
@dataclass
class Recommendation:
    kind: str
    message: str


def build_recommendations(
    report: BalanceReport, concentration: dict[int, float]
) -> list[Recommendation]:
    """Concrete next actions, computed from this selection's own numbers.

    `concentration[label_id]` is the share of that class's instances coming
    from its single largest grouping unit.
    """
    if not report.classes:
        return []

    recommendations: list[Recommendation] = []

    if report.below_threshold:
        names = ", ".join(report.below_threshold)
        recommendations.append(
            Recommendation(
                kind="under_threshold",
                message=(
                    f"{len(report.below_threshold)} class(es) below {report.threshold} "
                    f"instances: {names}. Annotate more, collapse them into a parent "
                    f"class, or exclude them."
                ),
            )
        )

    severity = report.metrics.get("severity")
    if severity in {"severe_imbalance", "extreme_imbalance"}:
        recommendations.append(
            Recommendation(
                kind="loss_weighting",
                message=(
                    f"Imbalance is {severity.replace('_', ' ')}. Consider Focal Loss or "
                    f"weighted sampling so the rare classes still contribute gradient."
                ),
            )
        )

    ratio = report.metrics.get("imbalance_ratio") or 0
    if ratio > 10 and report.classes:
        largest = report.classes[0]
        smallest = min(report.classes, key=lambda c: c.instances)
        suggested = max(smallest.instances * 10, report.threshold)
        if suggested < largest.instances:
            recommendations.append(
                Recommendation(
                    kind="cap_largest",
                    message=(
                        f"'{largest.name}' has {largest.instances} instances against "
                        f"'{smallest.name}' at {smallest.instances}. Capping "
                        f"'{largest.name}' to about {suggested} would even the ratio."
                    ),
                )
            )

    for entry in report.classes:
        share = concentration.get(entry.label_id)
        if share is not None and share >= 0.9 and entry.instances >= 2:
            recommendations.append(
                Recommendation(
                    kind="single_unit_concentration",
                    message=(
                        f"{round(share * 100)}% of '{entry.name}' comes from one video "
                        f"or photo batch. The model may learn that procedure rather "
                        f"than the finding -- annotate it in other studies."
                    ),
                )
            )

    return recommendations
```

In `compute_balance`, build `concentration` while counting instances (track, per resolved class, the instance counts per grouping unit, then divide the largest by the total) and set `report.recommendations = build_recommendations(report, concentration)` before returning.

- [ ] **Step 4: Expose it through the API**

In `backend/app/datasets/schemas.py`:

```python
class RecommendationRead(BaseModel):
    kind: str
    message: str
```

and add `recommendations: list[RecommendationRead] = Field(default_factory=list)` to `BalanceReportRead`. In `router.py`'s `/balance` response include:

```python
        "recommendations": [
            {"kind": r.kind, "message": r.message} for r in report.recommendations
        ],
```

Also add the same list to the stored `balance_metrics` snapshot in `create_dataset`, so a saved dataset's Metrics dialog shows the advice that applied at save time.

- [ ] **Step 5: Run tests, regenerate OpenAPI, commit**

```bash
cd backend && uv run pytest tests/test_dataset_recommendations.py tests/test_datasets_api.py -v
PYTHONPATH=. uv run python scripts/export_openapi.py
git diff --stat openapi.json
git add backend/app/datasets/ backend/tests/test_dataset_recommendations.py openapi.json
git commit -m "feat: derive balance recommendations from the computed metrics"
```

---

### Task 6: Key metrics block and recommendations in the panel

**Files:**
- Modify: `frontend/src/features/datasets/BalancePanel.tsx`
- Test: `frontend/src/features/datasets/BalancePanel.test.tsx` (append)

**Interfaces:**
- Consumes: `BalanceReportRead.metrics` and `.recommendations` from the regenerated client.

**The information hierarchy does not change:** the under-threshold summary stays the headline. Collapsing a group *raises* `imbalance_ratio` (measured: 16 → 35) while being the correct call, so promoting severity would push the user toward meaningless mega-classes. The metrics block is reference detail, placed below the class bars.

- [ ] **Step 1: Regenerate the client**

```bash
cd frontend && npm run generate-api
grep -c "recommendations" src/shared/api/generated/schema.d.ts
```
Expected: non-zero. If zero, Task 5's OpenAPI regeneration did not land — stop.

- [ ] **Step 2: Write the failing tests**

Append to `frontend/src/features/datasets/BalancePanel.test.tsx`, matching the file's existing render helper and fixture style:

```tsx
it("shows the computed key metrics as a labelled block", () => {
  renderPanel({
    report: {
      ...REPORT,
      metrics: {
        severity: "severe_imbalance",
        imbalance_ratio: 35,
        gini_index: 0.587,
        normalized_entropy: 0.528,
        min_count: 1,
        max_count: 35,
        mean_count: 11.5,
      },
    },
  });

  const metrics = screen.getByTestId("key-metrics");
  expect(metrics).toHaveTextContent("35");
  expect(metrics).toHaveTextContent("0.59");
  expect(metrics).toHaveTextContent("0.53");
});

it("renders recommendations when the report carries them", () => {
  renderPanel({
    report: {
      ...REPORT,
      recommendations: [
        { kind: "under_threshold", message: "1 class(es) below 10 instances: ileum." },
        { kind: "loss_weighting", message: "Consider Focal Loss or weighted sampling." },
      ],
    },
  });

  const list = screen.getByTestId("recommendations");
  expect(list).toHaveTextContent("ileum");
  expect(list).toHaveTextContent("Focal Loss");
});

it("renders no recommendations section when there are none", () => {
  renderPanel({ report: { ...REPORT, recommendations: [] } });
  expect(screen.queryByTestId("recommendations")).not.toBeInTheDocument();
});

it("keeps the under-threshold summary above the metrics block", () => {
  renderPanel();
  const summary = screen.getByTestId("below-threshold-summary");
  const metrics = screen.getByTestId("key-metrics");
  expect(summary.compareDocumentPosition(metrics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
```

Add `recommendations: []` to the file's shared `REPORT` fixture so the existing tests keep type-checking.

- [ ] **Step 3: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/features/datasets/BalancePanel.test.tsx`
Expected: FAIL — `Unable to find an element by: [data-testid="key-metrics"]`.

- [ ] **Step 4: Implement**

In `BalancePanel.tsx`, replace the existing severity footer with a labelled metrics block, and add a recommendations list. Place both after the class bars and after the excluded-classes section. Copy Tailwind classes from the surrounding markup — dark theme only:

```tsx
      <div data-testid="key-metrics" className="rounded border border-gray-800 bg-gray-900 p-3">
        <h3 className="mb-2 text-xs uppercase tracking-wide text-gray-400">Key metrics</h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-300">
          <dt>Total instances</dt>
          <dd className="text-right">{totalInstances}</dd>
          <dt>Total frames</dt>
          <dd className="text-right">{report.total_frames}</dd>
          <dt>Classes</dt>
          <dd className="text-right">{report.classes.length}</dd>
          <dt>Imbalance ratio</dt>
          <dd className="text-right">{formatNumber(report.metrics.imbalance_ratio, 2)}</dd>
          <dt>Gini index</dt>
          <dd className="text-right">{formatNumber(report.metrics.gini_index, 2)}</dd>
          <dt>Normalized entropy</dt>
          <dd className="text-right">{formatNumber(report.metrics.normalized_entropy, 2)}</dd>
          <dt>Min / max per class</dt>
          <dd className="text-right">
            {formatNumber(report.metrics.min_count, 0)} / {formatNumber(report.metrics.max_count, 0)}
          </dd>
          <dt>Severity</dt>
          <dd className="text-right">{String(report.metrics.severity ?? "no_data")}</dd>
        </dl>
      </div>

      {report.recommendations.length > 0 && (
        <ul data-testid="recommendations" className="flex flex-col gap-1">
          {report.recommendations.map((recommendation) => (
            <li
              key={`${recommendation.kind}-${recommendation.message}`}
              className="rounded border border-gray-800 bg-gray-900 px-3 py-2 text-xs text-gray-300"
            >
              {recommendation.message}
            </li>
          ))}
        </ul>
      )}
```

with these helpers above the return:

```tsx
  const totalInstances = report.classes.reduce((sum, entry) => sum + entry.instances, 0);

  function formatNumber(value: unknown, digits: number): string {
    return typeof value === "number" ? value.toFixed(digits) : "-";
  }
```

- [ ] **Step 5: Run the tests and commit**

```bash
cd frontend && npx vitest run src/features/datasets/BalancePanel.test.tsx && npm test
git add frontend/src/features/datasets/BalancePanel.tsx frontend/src/features/datasets/BalancePanel.test.tsx
git commit -m "feat: show key metrics and recommendations in the balance panel"
```

---

### Task 7: Class-limit controls and the saved-dataset Metrics dialog

**Files:**
- Modify: `frontend/src/features/datasets/BalancePanel.tsx` (a limit input per class row)
- Modify: `frontend/src/features/datasets/DatasetsPage.tsx` (limit state, request wiring)
- Create: `frontend/src/features/datasets/DatasetMetricsDialog.tsx`
- Modify: `frontend/src/features/datasets/DatasetsTable.tsx` (a Metrics action)
- Test: `frontend/src/features/datasets/DatasetMetricsDialog.test.tsx`
- Test: `frontend/src/features/datasets/DatasetsPage.test.tsx` (append)

**Interfaces:**
- Consumes: `class_limits` on `BalanceRequest`/`DatasetCreate`/`DatasetRead`, and `Dataset.balance_metrics` — all already returned by the API.
- Produces: `<DatasetMetricsDialog dataset={...} onClose={...} />`.

The dialog renders the **stored** snapshot. No recomputation, no new endpoint: composition is frozen at save time, so its balance is too.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/features/datasets/DatasetMetricsDialog.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DatasetMetricsDialog } from "./DatasetMetricsDialog";

const DATASET = {
  id: 1,
  name: "colono-detection",
  task_type: "detection",
  taxonomy_version: 1,
  split_config: { train: 70, val: 20, test: 10 },
  grouping_overrides: {},
  excluded_label_ids: [],
  class_limits: {},
  balance_metrics: {
    severity: "severe_imbalance",
    threshold: 10,
    negative_frames: 23,
    below_threshold: ["ileum"],
    metrics: { imbalance_ratio: 35, gini_index: 0.587, severity: "severe_imbalance" },
    classes: [
      { label_id: 1, name: "polyp", instances: 35, frames: 33 },
      { label_id: 2, name: "ileum", instances: 1, frames: 1 },
    ],
  },
  created_at: "2026-08-16T10:00:00Z",
  item_count: 66,
  split_counts: { train: 40, val: 20, test: 6 },
  items: [],
};

describe("DatasetMetricsDialog", () => {
  it("renders the stored class snapshot", () => {
    render(<DatasetMetricsDialog dataset={DATASET} onClose={vi.fn()} />);
    expect(screen.getByText("polyp")).toBeInTheDocument();
    expect(screen.getByText("ileum")).toBeInTheDocument();
  });

  it("shows the stored severity and split counts", () => {
    render(<DatasetMetricsDialog dataset={DATASET} onClose={vi.fn()} />);
    expect(screen.getByTestId("dialog-severity")).toHaveTextContent("severe_imbalance");
    expect(screen.getByTestId("dialog-splits")).toHaveTextContent("40");
  });

  it("calls onClose when the close control is used", async () => {
    const onClose = vi.fn();
    render(<DatasetMetricsDialog dataset={DATASET} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("handles a dataset saved without a snapshot", () => {
    render(
      <DatasetMetricsDialog dataset={{ ...DATASET, balance_metrics: {} }} onClose={vi.fn()} />,
    );
    expect(screen.getByTestId("dialog-empty")).toBeInTheDocument();
  });
});
```

Append to `DatasetsPage.test.tsx`:

```tsx
it("sends a class limit in the balance request", async () => {
  render(<DatasetsPage />, { wrapper });
  await userEvent.click(await screen.findByLabelText(/select seq-a/i));

  const limitInput = await screen.findByLabelText(/limit polyp/i);
  await userEvent.clear(limitInput);
  await userEvent.type(limitInput, "20");

  await waitFor(() => {
    const calls = vi.mocked(apiClient.POST).mock.calls.filter(([p]) => p === "/datasets/balance");
    expect(calls.at(-1)?.[1]?.body?.class_limits).toEqual({ 1: 20 });
  });
});
```

Adjust the mocked balance response in that file so it returns a class with `label_id: 1, name: "polyp"`, and add `recommendations: []` to it.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/features/datasets/`
Expected: FAIL — cannot resolve `./DatasetMetricsDialog`, and no limit input exists.

- [ ] **Step 3: Add the limit input to `BalancePanel`**

Give `BalancePanel` two more optional props — `classLimits?: Record<number, number>` and `onChangeLimit?: (labelId: number, limit: number | null) => void` — and render a small number input in each class row, labelled `Limit {name}`, showing the current cap or empty. An empty value calls `onChangeLimit(labelId, null)` to clear the cap. Match the existing row's Tailwind classes; dark theme only.

- [ ] **Step 4: Wire limits into `DatasetsPage`**

Add `const [classLimits, setClassLimits] = useState<Record<number, number>>({})`, include it in the debounced balance request as `class_limits: classLimits` and in the save payload, and pass `classLimits`/`onChangeLimit` to `BalancePanel`. Setting a limit to `null` deletes the key rather than storing zero — a cap of 0 would mean "exclude", which is what the exclude checkbox is for.

- [ ] **Step 5: Write `DatasetMetricsDialog`**

Create `frontend/src/features/datasets/DatasetMetricsDialog.tsx`: a modal reading `dataset.balance_metrics`, rendering the stored per-class instance/frame counts, the stored metrics, severity (`data-testid="dialog-severity"`), the split counts (`data-testid="dialog-splits"`), the stored recommendations if present, and a `data-testid="dialog-empty"` placeholder when the snapshot is missing or empty. Include a Close button. Dark theme only; copy the overlay/panel classes from an existing modal in the codebase if one exists, otherwise use the same `bg-gray-900`/`border-gray-800` palette as the panel.

- [ ] **Step 6: Add the Metrics action to `DatasetsTable`**

Add a `Metrics` button per row that calls a new `onShowMetrics(dataset)` prop; `DatasetsPage` holds the selected dataset in state and renders `DatasetMetricsDialog` when it is set. Keep the existing two-click Delete exactly as it is.

- [ ] **Step 7: Run the tests**

```bash
cd frontend && npx vitest run src/features/datasets/ && npm test
npx tsc -b --noEmit 2>&1 | grep -E "features/datasets|entities/useDatasets" | grep -v "\.test\."
```
Expected: tests pass; the tsc check prints only the one accepted `useDatasets.ts(26,38)` line.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/features/datasets/
git commit -m "feat: add class-limit controls and a saved-dataset metrics dialog"
```

---

### Task 8: Richer sequence picker, real-browser verification, ROADMAP

**Files:**
- Modify: `frontend/src/features/datasets/DatasetsPage.tsx` (picker columns)
- Modify: `frontend/src/features/datasets/DatasetsPage.test.tsx` (append)
- Modify: `ROADMAP.md`

- [ ] **Step 1: Write the failing test**

Append to `DatasetsPage.test.tsx`, extending the mocked sequence fixture with `region_annotation_count: 12`, `frame_annotation_count: 3` and `video_id: 7`:

```tsx
it("shows per-scope annotation counts and the owning video in the picker", async () => {
  render(<DatasetsPage />, { wrapper });
  const row = (await screen.findByText("seq-a")).closest("tr")!;
  expect(row).toHaveTextContent("12");
  expect(row).toHaveTextContent("3");
  expect(row).toHaveTextContent("7");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/features/datasets/DatasetsPage.test.tsx`
Expected: FAIL — the row has no such cells.

- [ ] **Step 3: Add the columns**

Add `Region`, `Frame` and `Video` columns to the picker table, reading `region_annotation_count`, `frame_annotation_count` and `video_id` (render `—` when `video_id` is null, i.e. a photo batch). Keep the existing Select/Name/Frames/Labeled columns.

- [ ] **Step 4: Run the frontend suite**

```bash
cd frontend && npm test
```
Expected: green.

- [ ] **Step 5: Start the stack and verify in a real browser**

```bash
docker compose up -d
cd backend && uv run uvicorn app.main:app --port 8000
cd frontend && npm run dev -- --port 5173 --strictPort
```

Use `--strictPort` and verify against the port it prints. A stale dev server from an earlier session on the default port would silently serve old code.

Log in as `manualcheck@example.com` / `manual-check-pass` (**not** the test fixtures' `pass1234`), open `/datasets` and confirm:
- the picker shows Region/Frame/Video columns, and sequences 2074 (`caecum01`) and 2075 (`ileum`) both show video 2113;
- selecting all annotated sequences shows the key-metrics block with numbers matching a direct `POST /datasets/balance`;
- recommendations appear and name real classes;
- setting a limit on `polyp` reduces its instance count in the panel;
- saving a dataset and opening its Metrics action shows the stored snapshot;
- **the split check:** `GET /datasets/{id}` shows sequences 2074 and 2075 in the SAME split.

Delete any dataset created during this check.

- [ ] **Step 6: Run both suites**

```bash
cd backend && uv run pytest -q
cd frontend && npm test
```
Report the real numbers. Backend has 15 pre-existing failures — do not fix them.

- [ ] **Step 7: Record it in ROADMAP and commit**

Add a Phase 2b entry recording: the grouping-unit correction (with the video 2113 leak it fixes), class limits and why selection is apportioned across units, the metrics block and recommendations, the saved-dataset Metrics dialog, and the per-scope picker columns. Note that the pie chart was deliberately not adopted. Follow the deviation-log style the file already uses.

```bash
git add frontend/src/features/datasets/ ROADMAP.md
git commit -m "feat: enrich the sequence picker and record the work in ROADMAP"
```

---

## Deferred, deliberately

- **The pie chart.** At 26 classes its sectors are indistinguishable and its legend outgrows the chart; the existing bars answer the same question at any scale.
- **YOLO export**, `data.yaml`, the class-map fingerprint and archive download — still the next separate piece of work.
- **Auto-apply recommendations.** The reference has a one-click "apply recommended filtering"; the recommendations here are advisory only, because applying an exclusion or cap silently on the user's behalf is exactly the kind of invisible data decision this screen exists to make visible.
