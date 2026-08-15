# Dataset Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `datasets` backend module and the `/datasets` screen, so a user can select sequences, watch the resulting class balance live, choose a grouping and exclusions while watching it, and save the result as a `Dataset` with a frozen frame list.

**Architecture:** A new `backend/app/datasets/` module following this repo's `models/schemas/service/router` layout. Composition and balance live in `service.py` as pure functions over the ORM; classes are resolved through `resolve_class` from `app/taxonomy/hierarchy.py` so the panel and any future export agree by construction. The screen is a two-column page reusing the existing `GET /media/sequences` endpoint for its sequence picker — no media-side change is needed.

**Tech Stack:** FastAPI, SQLAlchemy 2.0 (`Mapped`/`mapped_column`), Alembic, Pydantic v2, pytest, React + TypeScript, TanStack Query, Vitest, Tailwind (dark-only).

**Spec:** [docs/superpowers/specs/2026-08-15-dataset-screen-design.md](../specs/2026-08-15-dataset-screen-design.md)

## Global Constraints

- **License/Language:** English only in all committed content — code, comments, docstrings, UI copy. No Russian anywhere. (Standing exception: the pre-existing Russian design specs and ROADMAP's verbatim quotes of their headings — do not touch those, and do not add new Russian.)
- **UI theme:** dark only. Never introduce light-background Tailwind classes.
- **Object storage:** all binary media goes through `StorageService`. This plan touches no binary media at all.
- **`taxonomy_version`:** copy it from the source row at creation time; never hardcode or re-derive. `Dataset.taxonomy_version` is pinned at creation.
- **API contract:** after any backend schema/route change, regenerate the committed OpenAPI document: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py` (the `PYTHONPATH=.` is required), then verify with `git diff --stat openapi.json` that it changed. Never hand-edit anything under `frontend/src/shared/api/generated/`.
- **TDD:** every backend task and every frontend task with logic gets a failing test, actually run and observed failing, before the implementation.
- **Git:** commit directly to `master` in the primary working directory. No branch, no worktree, no merge, no push.

### Environment facts — verified, do not re-derive

- **`npm run build` (tsc) is RED and predates this work** (~235 errors: a broken repo-wide jest-dom matcher type setup, plus an `annotation_scope: string` vs `"frame" | "region"` literal-union mismatch in old fixtures). It is NOT an acceptance gate. New tests using `toBeInTheDocument()` mechanically add more instances of the same gap — expected and accepted. The gates are: `npm test` green, and **zero new tsc errors in product code** (`.tsx`/`.ts` files that are not `.test.*`).
- **The backend suite has 15 pre-existing failures** (`test_jobs.py`, `test_mask_postprocess_endpoint.py`, `test_media_service.py` and others), present before this plan. Do not fix them; do not report them as your breakage. Baseline at plan time: **244 passed, 15 failed**.
- **Backend tests run against the REAL dev database** (`conftest.py` redirects `app.db` to `endoscopy_test`, which it builds via `Base.metadata.create_all` and drops at teardown — Alembic never runs there). Use uniquely-named throwaway rows. **Never TRUNCATE/DELETE/DROP anything in `endoscopy`** — it holds real taxonomy and 82 live annotations.
- Current Alembic head at plan time: `663b8b5c3cad`. Task 1's migration revises it, and Task 2's revises Task 1's.
- **Use `JSON`, not `JSONB`**, for the new columns. Every existing JSON-ish column in this repo (`Annotation.payload`, `Sequence.crop_box`, `Job.payload`) is `JSON`; nothing queries into these documents by content, so matching the established convention beats a lone JSONB outlier. Do not "upgrade" it.

### Real data this plan will run against

- 17 sequences, 1805 frames, 82 annotations (all `DRAFT`), 75 annotated frames across 7 sequences.
- **Zero frames have `no_findings_reviewed` set** — the first dataset will legitimately contain 0 negatives.
- Frame 5672 carries two `colon_adenoma` annotations (2 instances / 1 frame). Frame 14084 carries three distinct classes. Both are real fixtures for the counting tests.
- No frame mixes REGION and FRAME scopes today, but nothing prevents it — filter per annotation, never per frame.

---

### Task 1: Seed the `polyp` default grouping

**Files:**
- Create: `backend/alembic/versions/<generated>_seed_polyp_parent_grouping.py`
- Test: `backend/tests/test_polyp_grouping_seed.py`

**Interfaces:**
- Consumes: `Label.parent_label_id`, `Label.is_abstract` (already shipped).
- Produces: a `polyp` label (colono, REGION, `is_abstract=True`) that is the parent of five subtypes. Later tasks rely on this existing so the balance panel has something to collapse.

**Why first:** a panel cannot collapse a group that does not exist. Without this, the screen's first run shows exactly today's picture with nothing to toggle.

- [ ] **Step 1: Confirm the starting state**

```bash
docker compose exec postgres psql -U endoscopy -c "
SELECT l.id, l.name, l.parent_label_id, l.is_abstract, c.id AS category_id, p.name AS procedure
FROM labels l JOIN categories c ON c.id = l.category_id JOIN procedures p ON p.id = c.procedure_id
WHERE l.name IN ('pedunculated_polyp_0_Ip','sessile_polyp_0_Is','flat_lesion_0_IIa',
                 'lst_g_nodular_mixed','lst_ng_flat_elevated','polyp')
  AND p.name = 'colono' ORDER BY l.name;"
```

Expect five rows, all with `parent_label_id` NULL and `is_abstract` false, all sharing one `category_id` (the colono `Findings` category), and no `polyp` row yet. Record the shared `category_id` and the `evaluation_type_id` — the migration derives both in SQL, but you need them to sanity-check the result.

- [ ] **Step 2: Write the failing test**

Create `backend/tests/test_polyp_grouping_seed.py`:

```python
"""The polyp grouping is seeded so the balance panel has a default to collapse.

Name-based rather than id-based, so it holds in any environment whose
taxonomy was imported separately.
"""

import app.main  # noqa: F401 -- registers every model on Base.metadata for create_all
from app.db import SessionLocal
from app.taxonomy.models import Category, Label

SUBTYPES = (
    "pedunculated_polyp_0_Ip",
    "sessile_polyp_0_Is",
    "flat_lesion_0_IIa",
    "lst_g_nodular_mixed",
    "lst_ng_flat_elevated",
)


def _colono_label(session, name):
    return (
        session.query(Label)
        .join(Category, Category.id == Label.category_id)
        .filter(Label.name == name)
        .order_by(Label.id)
        .first()
    )


def test_polyp_parent_exists_and_is_abstract():
    session = SessionLocal()
    try:
        polyp = _colono_label(session, "polyp")
        assert polyp is not None, "expected a 'polyp' grouping label"
        assert polyp.is_abstract is True, "polyp is a grouping container, not annotatable"
    finally:
        session.close()


def test_all_five_subtypes_hang_under_polyp():
    session = SessionLocal()
    try:
        polyp = _colono_label(session, "polyp")
        assert polyp is not None
        for name in SUBTYPES:
            label = _colono_label(session, name)
            assert label is not None, f"missing subtype {name}"
            assert label.parent_label_id == polyp.id, f"{name} is not parented to polyp"
    finally:
        session.close()


def test_polyp_shares_category_and_scope_with_its_children():
    # The hierarchy invariants require same procedure and same annotation_scope.
    # Sharing the children's category satisfies both at once.
    session = SessionLocal()
    try:
        polyp = _colono_label(session, "polyp")
        assert polyp is not None
        for name in SUBTYPES:
            label = _colono_label(session, name)
            assert label.category_id == polyp.category_id
            assert label.evaluation_type_id == polyp.evaluation_type_id
    finally:
        session.close()
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && uv run pytest tests/test_polyp_grouping_seed.py -v`
Expected: FAIL — "expected a 'polyp' grouping label" (no such row yet).

Note: the ephemeral test DB has no taxonomy seeded, so these will fail there for that reason too. Real verification is against the dev DB in Step 6, as with the earlier quality migration.

- [ ] **Step 4: Write the migration**

Run `cd backend && uv run alembic revision -m "seed polyp parent grouping"`, then:

```python
SUBTYPES = (
    "'pedunculated_polyp_0_Ip'", "'sessile_polyp_0_Is'", "'flat_lesion_0_IIa'",
    "'lst_g_nodular_mixed'", "'lst_ng_flat_elevated'",
)
SUBTYPE_LIST = ", ".join(SUBTYPES)


def upgrade() -> None:
    connection = op.get_bind()

    # Create `polyp` in the same category and evaluation type as its children.
    # Sharing the category satisfies both hierarchy invariants at once: same
    # procedure (a category belongs to exactly one) and same annotation_scope
    # (which follows from the evaluation type).
    connection.execute(sa.text(f"""
        INSERT INTO labels (name, color, category_id, evaluation_type_id, taxonomy_version,
                            is_abstract, created_at)
        SELECT DISTINCT 'polyp', '#F97316', l.category_id, l.evaluation_type_id, 1, true, now()
        FROM labels l
        WHERE l.name IN ({SUBTYPE_LIST})
          AND NOT EXISTS (
              SELECT 1 FROM labels existing
              WHERE existing.name = 'polyp' AND existing.category_id = l.category_id
          )
    """))

    connection.execute(sa.text(f"""
        UPDATE labels child
        SET parent_label_id = (
            SELECT parent.id FROM labels parent
            WHERE parent.name = 'polyp' AND parent.category_id = child.category_id
            LIMIT 1
        )
        WHERE child.name IN ({SUBTYPE_LIST})
    """))


def downgrade() -> None:
    connection = op.get_bind()

    connection.execute(sa.text(f"""
        UPDATE labels SET parent_label_id = NULL WHERE name IN ({SUBTYPE_LIST})
    """))

    # Only delete the grouping row if nobody annotated with it. It is abstract,
    # so nobody should have been able to -- but fail loudly rather than delete
    # annotated data if that assumption ever broke.
    annotated = connection.execute(sa.text("""
        SELECT count(*) FROM annotations a JOIN labels l ON l.id = a.label_id
        WHERE l.name = 'polyp' AND l.is_abstract
    """)).scalar()
    if annotated:
        raise RuntimeError(
            f"Refusing to downgrade: {annotated} annotation(s) reference the 'polyp' "
            "grouping label. Reassign them first."
        )

    connection.execute(sa.text("DELETE FROM labels WHERE name = 'polyp' AND is_abstract"))
```

- [ ] **Step 5: Apply to the dev database**

```bash
cd backend && uv run alembic upgrade head
```

- [ ] **Step 6: Verify against real data**

```bash
docker compose exec postgres psql -U endoscopy -c "
SELECT child.name, child.parent_label_id, parent.name AS parent_name, parent.is_abstract
FROM labels child LEFT JOIN labels parent ON parent.id = child.parent_label_id
WHERE child.name IN ('pedunculated_polyp_0_Ip','sessile_polyp_0_Is','flat_lesion_0_IIa',
                     'lst_g_nodular_mixed','lst_ng_flat_elevated')
ORDER BY child.name;"
```

Expected: all five rows show `parent_name = polyp`, `is_abstract = t`. Also confirm the annotation count is still 82 and no label ids changed.

- [ ] **Step 7: Commit**

```bash
git add backend/alembic/versions/ backend/tests/test_polyp_grouping_seed.py
git commit -m "feat: seed polyp as the default grouping parent for its subtypes"
```

---

### Task 2: `Dataset` and `DatasetItem` models

**Files:**
- Create: `backend/app/datasets/__init__.py`, `backend/app/datasets/models.py`
- Create: `backend/alembic/versions/<generated>_add_dataset_tables.py`
- Test: `backend/tests/test_dataset_models.py`

**Interfaces:**
- Produces:
  - `TaskType` — a `str` enum with members `DETECTION = "detection"`, `SEGMENTATION = "segmentation"`, `CLASSIFICATION = "classification"`.
  - `SplitName` — a `str` enum with `TRAIN = "train"`, `VAL = "val"`, `TEST = "test"`.
  - `Dataset(id, name, task_type, taxonomy_version, split_config, grouping_overrides, excluded_label_ids, balance_metrics, created_by_id, created_at)`.
  - `DatasetItem(id, dataset_id, frame_id, annotation_ids, split)`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_dataset_models.py`:

```python
import app.main  # noqa: F401 -- registers every model on Base.metadata for create_all
from app.datasets.models import Dataset, DatasetItem, SplitName, TaskType
from app.db import SessionLocal


def test_dataset_round_trips_its_jsonb_fields():
    session = SessionLocal()
    try:
        user_id = session.execute(
            __import__("sqlalchemy").text("SELECT id FROM users ORDER BY id LIMIT 1")
        ).scalar()
        dataset = Dataset(
            name="ds-model-test",
            task_type=TaskType.DETECTION,
            taxonomy_version=1,
            split_config={"train": 70, "val": 20},
            grouping_overrides={"collapse": [1], "expand": [2]},
            excluded_label_ids=[3, 4],
            balance_metrics={"severity": "severe_imbalance"},
            created_by_id=user_id,
        )
        session.add(dataset)
        session.commit()
        session.refresh(dataset)

        assert dataset.task_type is TaskType.DETECTION
        assert dataset.split_config == {"train": 70, "val": 20}
        assert dataset.grouping_overrides == {"collapse": [1], "expand": [2]}
        assert dataset.excluded_label_ids == [3, 4]
        assert dataset.balance_metrics == {"severity": "severe_imbalance"}
        assert dataset.created_at is not None
    finally:
        session.rollback()
        session.close()


def test_dataset_item_records_its_frame_split_and_annotations():
    session = SessionLocal()
    try:
        import sqlalchemy as sa

        user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
        frame_id = session.execute(sa.text("SELECT id FROM frames ORDER BY id LIMIT 1")).scalar()
        dataset = Dataset(
            name="ds-item-test",
            task_type=TaskType.CLASSIFICATION,
            taxonomy_version=1,
            split_config={"train": 80, "val": 20},
            grouping_overrides={},
            excluded_label_ids=[],
            balance_metrics={},
            created_by_id=user_id,
        )
        session.add(dataset)
        session.flush()

        item = DatasetItem(
            dataset_id=dataset.id,
            frame_id=frame_id,
            annotation_ids=[10, 11],
            split=SplitName.TRAIN,
        )
        session.add(item)
        session.commit()
        session.refresh(item)

        assert item.split is SplitName.TRAIN
        assert item.annotation_ids == [10, 11]
        assert item.dataset_id == dataset.id
    finally:
        session.rollback()
        session.close()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && uv run pytest tests/test_dataset_models.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.datasets'`.

- [ ] **Step 3: Write the models**

Create `backend/app/datasets/__init__.py` (empty), then `backend/app/datasets/models.py`:

```python
import enum
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Enum, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class TaskType(str, enum.Enum):
    DETECTION = "detection"
    SEGMENTATION = "segmentation"
    CLASSIFICATION = "classification"


class SplitName(str, enum.Enum):
    TRAIN = "train"
    VAL = "val"
    TEST = "test"


class Dataset(Base):
    __tablename__ = "datasets"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    task_type: Mapped[TaskType] = mapped_column(Enum(TaskType))
    # Pinned at creation, like Annotation's: records which taxonomy this
    # dataset belongs to. Grouping itself stays live -- a rebuild picks up
    # current parent edges. Provenance and behaviour are separate questions.
    taxonomy_version: Mapped[int] = mapped_column()
    split_config: Mapped[dict] = mapped_column(JSON, default=dict)
    # Delta over the taxonomy's default grouping: {"collapse": [...], "expand": [...]}
    grouping_overrides: Mapped[dict] = mapped_column(JSON, default=dict)
    excluded_label_ids: Mapped[list] = mapped_column(JSON, default=list)
    balance_metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    created_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class DatasetItem(Base):
    __tablename__ = "dataset_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("datasets.id", ondelete="CASCADE"))
    frame_id: Mapped[int] = mapped_column(ForeignKey("frames.id"))
    annotation_ids: Mapped[list] = mapped_column(JSON, default=list)
    split: Mapped[SplitName] = mapped_column(Enum(SplitName))
```

Then import the module in `backend/app/main.py` so `Base.metadata` registers both tables (add alongside the other router imports; the router itself arrives in Task 5, so for now add `import app.datasets.models  # noqa: F401` near the top with a comment saying the router follows).

- [ ] **Step 4: Generate and write the migration**

Run `cd backend && uv run alembic revision -m "add dataset tables"`, confirm `down_revision` is `'663b8b5c3cad'` (or whatever `uv run alembic heads` reports if Task 1 already landed — it should be Task 1's revision), then:

```python
def upgrade() -> None:
    task_type = sa.Enum('DETECTION', 'SEGMENTATION', 'CLASSIFICATION', name='tasktype')
    split_name = sa.Enum('TRAIN', 'VAL', 'TEST', name='splitname')
    task_type.create(op.get_bind())
    split_name.create(op.get_bind())

    op.create_table(
        'datasets',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('task_type', task_type, nullable=False),
        sa.Column('taxonomy_version', sa.Integer(), nullable=False),
        sa.Column('split_config', sa.JSON(), nullable=False),
        sa.Column('grouping_overrides', sa.JSON(), nullable=False),
        sa.Column('excluded_label_ids', sa.JSON(), nullable=False),
        sa.Column('balance_metrics', sa.JSON(), nullable=False),
        sa.Column('created_by_id', sa.Integer(), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        'dataset_items',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('dataset_id', sa.Integer(),
                  sa.ForeignKey('datasets.id', ondelete='CASCADE'), nullable=False),
        sa.Column('frame_id', sa.Integer(), sa.ForeignKey('frames.id'), nullable=False),
        sa.Column('annotation_ids', sa.JSON(), nullable=False),
        sa.Column('split', split_name, nullable=False),
    )
    op.create_index('ix_dataset_items_dataset_id', 'dataset_items', ['dataset_id'])


def downgrade() -> None:
    op.drop_index('ix_dataset_items_dataset_id', table_name='dataset_items')
    op.drop_table('dataset_items')
    op.drop_table('datasets')
    sa.Enum(name='splitname').drop(op.get_bind())
    sa.Enum(name='tasktype').drop(op.get_bind())
```

- [ ] **Step 5: Apply and run the tests**

```bash
cd backend && uv run alembic upgrade head
uv run pytest tests/test_dataset_models.py -v
```
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/app/datasets/ backend/app/main.py backend/alembic/versions/ backend/tests/test_dataset_models.py
git commit -m "feat: add Dataset and DatasetItem models"
```

---

### Task 3: Composition — which frames enter a dataset

**Files:**
- Create: `backend/app/datasets/service.py`
- Test: `backend/tests/test_dataset_composition.py`

**Interfaces:**
- Consumes: `TaskType` from Task 2; `Annotation`, `Frame`, `Label`, `EvaluationType`, `AnnotationScope`.
- Produces:
  - `FrameComposition` — a dataclass with `frame_id: int`, `annotation_ids: list[int]`, `is_negative: bool`.
  - `scope_for_task(task_type: TaskType) -> AnnotationScope`.
  - `collect_frames(session, sequence_ids: list[int], task_type: TaskType, excluded_label_ids: set[int]) -> list[FrameComposition]`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_dataset_composition.py`. These build their own throwaway rows so they do not depend on dev data:

```python
import app.main  # noqa: F401 -- registers every model on Base.metadata for create_all
import sqlalchemy as sa

from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
from app.datasets.models import TaskType
from app.datasets.service import collect_frames, scope_for_task
from app.db import SessionLocal
from app.media.models import Frame, Sequence
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure


def _fixture(session, tag):
    """Build an isolated procedure/category/labels/sequence/frames island."""
    procedure = Procedure(name=f"ds-{tag}-proc")
    session.add(procedure)
    session.flush()
    category = Category(name=f"ds-{tag}-cat", procedure_id=procedure.id)
    session.add(category)
    session.flush()
    region = EvaluationType(name=f"ds-{tag}-region", annotation_scope=AnnotationScope.REGION)
    frame_et = EvaluationType(name=f"ds-{tag}-frame", annotation_scope=AnnotationScope.FRAME)
    session.add_all([region, frame_et])
    session.flush()
    sequence = Sequence(name=f"ds-{tag}-seq", start_time=0, duration=1, procedure_id=procedure.id)
    session.add(sequence)
    session.flush()
    # NB: the column is `frame_index`, not `index`; width/height are required.
    frames = [
        Frame(sequence_id=sequence.id, storage_key=f"k{i}", frame_index=i, width=64, height=64)
        for i in range(4)
    ]
    session.add_all(frames)
    session.flush()
    user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
    return procedure, category, region, frame_et, sequence, frames, user_id


def _label(session, category, evaluation_type, name):
    label = Label(name=name, category_id=category.id, evaluation_type_id=evaluation_type.id)
    session.add(label)
    session.flush()
    return label


def _annotate(session, frame, label, user_id, annotation_type=AnnotationType.MASK):
    annotation = Annotation(
        frame_id=frame.id, label_id=label.id, taxonomy_version=label.taxonomy_version,
        annotation_type=annotation_type, payload={}, status=AnnotationStatus.DRAFT,
        created_by_id=user_id,
    )
    session.add(annotation)
    session.flush()
    return annotation


def test_scope_for_task_maps_each_task_type():
    assert scope_for_task(TaskType.DETECTION) is AnnotationScope.REGION
    assert scope_for_task(TaskType.SEGMENTATION) is AnnotationScope.REGION
    assert scope_for_task(TaskType.CLASSIFICATION) is AnnotationScope.FRAME


def test_annotated_frame_is_included_with_its_annotation_ids():
    session = SessionLocal()
    try:
        _, category, region, _, sequence, frames, user_id = _fixture(session, "inc")
        polyp = _label(session, category, region, "ds-inc-polyp")
        annotation = _annotate(session, frames[0], polyp, user_id)

        result = collect_frames(session, [sequence.id], TaskType.DETECTION, set())

        included = {c.frame_id: c for c in result}
        assert frames[0].id in included
        assert included[frames[0].id].annotation_ids == [annotation.id]
        assert included[frames[0].id].is_negative is False
    finally:
        session.rollback()
        session.close()


def test_unannotated_frame_without_the_flag_is_omitted():
    session = SessionLocal()
    try:
        _, category, region, _, sequence, frames, user_id = _fixture(session, "omit")
        polyp = _label(session, category, region, "ds-omit-polyp")
        _annotate(session, frames[0], polyp, user_id)

        result = collect_frames(session, [sequence.id], TaskType.DETECTION, set())

        assert {c.frame_id for c in result} == {frames[0].id}
    finally:
        session.rollback()
        session.close()


def test_no_findings_reviewed_frame_is_included_as_a_negative():
    session = SessionLocal()
    try:
        _, _, _, _, sequence, frames, _ = _fixture(session, "neg")
        frames[1].no_findings_reviewed = True
        session.flush()

        result = collect_frames(session, [sequence.id], TaskType.DETECTION, set())

        negatives = [c for c in result if c.is_negative]
        assert [c.frame_id for c in negatives] == [frames[1].id]
        assert negatives[0].annotation_ids == []
    finally:
        session.rollback()
        session.close()


def test_task_type_filters_by_annotation_scope():
    session = SessionLocal()
    try:
        _, category, region, frame_et, sequence, frames, user_id = _fixture(session, "scope")
        mask_label = _label(session, category, region, "ds-scope-mask")
        cls_label = _label(session, category, frame_et, "ds-scope-cls")
        _annotate(session, frames[0], mask_label, user_id)
        _annotate(session, frames[1], cls_label, user_id, AnnotationType.CLASSIFICATION)

        detection = collect_frames(session, [sequence.id], TaskType.DETECTION, set())
        classification = collect_frames(session, [sequence.id], TaskType.CLASSIFICATION, set())

        assert {c.frame_id for c in detection} == {frames[0].id}
        assert {c.frame_id for c in classification} == {frames[1].id}
    finally:
        session.rollback()
        session.close()


def test_a_frame_carrying_both_scopes_contributes_only_the_matching_annotations():
    # No frame mixes scopes in the dev data today, but marking an annotated
    # frame low_quality is legitimate, so the filter must work per annotation.
    session = SessionLocal()
    try:
        _, category, region, frame_et, sequence, frames, user_id = _fixture(session, "mixed")
        mask_label = _label(session, category, region, "ds-mixed-mask")
        cls_label = _label(session, category, frame_et, "ds-mixed-cls")
        mask_annotation = _annotate(session, frames[0], mask_label, user_id)
        _annotate(session, frames[0], cls_label, user_id, AnnotationType.CLASSIFICATION)

        detection = collect_frames(session, [sequence.id], TaskType.DETECTION, set())

        assert len(detection) == 1
        assert detection[0].annotation_ids == [mask_annotation.id]
    finally:
        session.rollback()
        session.close()


def test_frame_whose_annotations_are_all_excluded_drops_out_and_is_not_a_negative():
    # "We chose not to train the ileum class" does not mean "this frame is empty".
    # Turning it into a negative would manufacture a false negative.
    session = SessionLocal()
    try:
        _, category, region, _, sequence, frames, user_id = _fixture(session, "excl")
        rare = _label(session, category, region, "ds-excl-rare")
        _annotate(session, frames[0], rare, user_id)

        result = collect_frames(session, [sequence.id], TaskType.DETECTION, {rare.id})

        assert result == []
    finally:
        session.rollback()
        session.close()


def test_an_excluded_frame_that_is_also_flagged_stays_as_a_negative():
    session = SessionLocal()
    try:
        _, category, region, _, sequence, frames, user_id = _fixture(session, "exclneg")
        rare = _label(session, category, region, "ds-exclneg-rare")
        _annotate(session, frames[0], rare, user_id)
        frames[0].no_findings_reviewed = True
        session.flush()

        result = collect_frames(session, [sequence.id], TaskType.DETECTION, {rare.id})

        assert len(result) == 1
        assert result[0].frame_id == frames[0].id
        assert result[0].is_negative is True
        assert result[0].annotation_ids == []
    finally:
        session.rollback()
        session.close()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_dataset_composition.py -v`
Expected: FAIL with `ImportError: cannot import name 'collect_frames' from 'app.datasets.service'` (or `ModuleNotFoundError` for the module).

- [ ] **Step 3: Implement composition**

Create `backend/app/datasets/service.py`:

```python
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.annotation.models import Annotation
from app.datasets.models import TaskType
from app.media.models import Frame
from app.taxonomy.models import AnnotationScope, EvaluationType, Label

_SCOPE_BY_TASK = {
    TaskType.DETECTION: AnnotationScope.REGION,
    TaskType.SEGMENTATION: AnnotationScope.REGION,
    TaskType.CLASSIFICATION: AnnotationScope.FRAME,
}


@dataclass
class FrameComposition:
    frame_id: int
    annotation_ids: list[int] = field(default_factory=list)
    is_negative: bool = False


def scope_for_task(task_type: TaskType) -> AnnotationScope:
    """A classification label has no coordinates, so a detector cannot train on
    it alongside boxes. annotation_scope is what separates the two."""
    return _SCOPE_BY_TASK[task_type]


def collect_frames(
    session: Session,
    sequence_ids: list[int],
    task_type: TaskType,
    excluded_label_ids: set[int],
) -> list[FrameComposition]:
    """Frames entering a dataset: annotated-and-compatible, or flagged negative.

    A frame whose every annotation is excluded leaves the dataset entirely
    rather than becoming a negative -- excluding a class is a bookkeeping
    decision, not a claim that the frame is empty.
    """
    if not sequence_ids:
        return []

    scope = scope_for_task(task_type)

    frames = (
        session.query(Frame)
        .filter(Frame.sequence_id.in_(sequence_ids))
        .order_by(Frame.id)
        .all()
    )
    frame_ids = [frame.id for frame in frames]
    if not frame_ids:
        return []

    rows = (
        session.query(Annotation.id, Annotation.frame_id, Annotation.label_id)
        .join(Label, Label.id == Annotation.label_id)
        .join(EvaluationType, EvaluationType.id == Label.evaluation_type_id)
        .filter(Annotation.frame_id.in_(frame_ids))
        .filter(EvaluationType.annotation_scope == scope)
        .order_by(Annotation.id)
        .all()
    )

    kept_by_frame: dict[int, list[int]] = {}
    for annotation_id, frame_id, label_id in rows:
        if label_id in excluded_label_ids:
            continue
        kept_by_frame.setdefault(frame_id, []).append(annotation_id)

    composition: list[FrameComposition] = []
    for frame in frames:
        annotation_ids = kept_by_frame.get(frame.id, [])
        if annotation_ids:
            composition.append(
                FrameComposition(frame_id=frame.id, annotation_ids=annotation_ids)
            )
        elif frame.no_findings_reviewed:
            composition.append(FrameComposition(frame_id=frame.id, is_negative=True))
    return composition
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_dataset_composition.py -v`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/datasets/service.py backend/tests/test_dataset_composition.py
git commit -m "feat: assemble dataset frame composition"
```

---

### Task 4: Balance computation and imbalance metrics

**Files:**
- Modify: `backend/app/datasets/service.py` (append)
- Test: `backend/tests/test_dataset_balance.py`

**Interfaces:**
- Consumes: `collect_frames`, `FrameComposition`, `scope_for_task` from Task 3; `build_label_tree`, `GroupingRules`, `resolve_class` from `app.taxonomy.hierarchy`.
- Produces:
  - `ClassCount` — dataclass with `label_id: int`, `name: str`, `instances: int`, `frames: int`.
  - `BalanceReport` — dataclass with `classes: list[ClassCount]`, `total_frames: int`, `negative_frames: int`, `below_threshold: list[str]`, `threshold: int`, `metrics: dict`.
  - `compute_imbalance_metrics(counts: dict[str, int]) -> dict`.
  - `compute_balance(session, sequence_ids, task_type, rules, excluded_label_ids, threshold=10) -> BalanceReport`.

**The counting rule that matters:** instances count annotation rows; frames count distinct frame ids. They genuinely differ — frame 5672 in the dev data carries two `colon_adenoma` annotations (2 instances, 1 frame). Using `DISTINCT` for both would undercount instances.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_dataset_balance.py`:

```python
import math

import app.main  # noqa: F401 -- registers every model on Base.metadata for create_all
from app.datasets.service import compute_imbalance_metrics


def test_perfectly_balanced_classes_report_ratio_one_and_zero_gini():
    metrics = compute_imbalance_metrics({"a": 10, "b": 10, "c": 10})
    assert metrics["imbalance_ratio"] == 1.0
    assert metrics["gini_index"] < 1e-9
    assert metrics["severity"] == "balanced"


def test_severity_thresholds_match_the_reference_scale():
    assert compute_imbalance_metrics({"a": 10, "b": 10})["severity"] == "balanced"
    assert compute_imbalance_metrics({"a": 30, "b": 12})["severity"] == "mild_imbalance"
    assert compute_imbalance_metrics({"a": 100, "b": 15})["severity"] == "moderate_imbalance"
    # min_count < 10 forces at least severe, even when the ratio looks tame.
    assert compute_imbalance_metrics({"a": 20, "b": 9})["severity"] == "severe_imbalance"


def test_real_polyp_distribution_is_severe_both_grouped_and_ungrouped():
    # The measured fact behind the spec's decision to lead with an absolute
    # threshold: collapsing polyps makes the RATIO worse, not better, because
    # imbalance is measured against the smallest class.
    leaves = {
        "0-Ip": 16, "0-Is": 14, "flat_IIa": 3, "lst_g": 1, "lst_ng": 1,
        "colon_adenoma": 8, "colono_ssl": 1, "foam": 2, "sheath": 1,
        "cap": 1, "valvula": 1, "ileum": 1,
    }
    grouped = {
        "polyp": 35, "colon_adenoma": 8, "colono_ssl": 1, "foam": 2,
        "sheath": 1, "cap": 1, "valvula": 1, "ileum": 1,
    }
    leaves_metrics = compute_imbalance_metrics(leaves)
    grouped_metrics = compute_imbalance_metrics(grouped)

    assert leaves_metrics["severity"] == "severe_imbalance"
    assert grouped_metrics["severity"] == "severe_imbalance"
    assert grouped_metrics["imbalance_ratio"] > leaves_metrics["imbalance_ratio"]


def test_single_class_is_degenerate_but_does_not_crash():
    metrics = compute_imbalance_metrics({"only": 7})
    assert metrics["imbalance_ratio"] == 1.0
    assert metrics["normalized_entropy"] == 0.0
    assert not math.isnan(metrics["gini_index"])


def test_empty_input_returns_no_data():
    metrics = compute_imbalance_metrics({})
    assert metrics["severity"] == "no_data"
```

Then append the integration tests, reusing Task 3's fixture helpers (import them by copying the `_fixture`/`_label`/`_annotate` helpers into this file — the plan deliberately repeats them rather than sharing a conftest, so each test file stands alone):

```python
import sqlalchemy as sa

from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
from app.datasets.models import TaskType
from app.datasets.service import compute_balance
from app.db import SessionLocal
from app.media.models import Frame, Sequence
from app.taxonomy.hierarchy import GroupingRules
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure


def _fixture(session, tag):
    procedure = Procedure(name=f"bal-{tag}-proc")
    session.add(procedure)
    session.flush()
    category = Category(name=f"bal-{tag}-cat", procedure_id=procedure.id)
    session.add(category)
    session.flush()
    region = EvaluationType(name=f"bal-{tag}-region", annotation_scope=AnnotationScope.REGION)
    session.add(region)
    session.flush()
    sequence = Sequence(name=f"bal-{tag}-seq", start_time=0, duration=1, procedure_id=procedure.id)
    session.add(sequence)
    session.flush()
    # NB: the column is `frame_index`, not `index`; width/height are required.
    frames = [
        Frame(sequence_id=sequence.id, storage_key=f"b{i}", frame_index=i, width=64, height=64)
        for i in range(4)
    ]
    session.add_all(frames)
    session.flush()
    user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
    return category, region, sequence, frames, user_id


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


def test_two_annotations_of_one_class_on_one_frame_count_as_two_instances_one_frame():
    session = SessionLocal()
    try:
        category, region, sequence, frames, user_id = _fixture(session, "dup")
        adenoma = _label(session, category, region, "bal-dup-adenoma")
        _annotate(session, frames[0], adenoma, user_id)
        _annotate(session, frames[0], adenoma, user_id)

        report = compute_balance(session, [sequence.id], TaskType.DETECTION, GroupingRules(), set())

        counts = {c.name: c for c in report.classes}
        assert counts["bal-dup-adenoma"].instances == 2
        assert counts["bal-dup-adenoma"].frames == 1
    finally:
        session.rollback()
        session.close()


def test_collapsing_a_parent_merges_its_children_into_one_class():
    session = SessionLocal()
    try:
        category, region, sequence, frames, user_id = _fixture(session, "grp")
        polyp = _label(session, category, region, "bal-grp-polyp", is_abstract=True)
        ip = _label(session, category, region, "bal-grp-ip", parent_id=polyp.id)
        is_ = _label(session, category, region, "bal-grp-is", parent_id=polyp.id)
        _annotate(session, frames[0], ip, user_id)
        _annotate(session, frames[1], is_, user_id)

        collapsed = compute_balance(
            session, [sequence.id], TaskType.DETECTION, GroupingRules(), set()
        )
        expanded = compute_balance(
            session, [sequence.id], TaskType.DETECTION,
            GroupingRules(expand=frozenset({polyp.id})), set(),
        )

        assert {c.name for c in collapsed.classes} == {"bal-grp-polyp"}
        assert collapsed.classes[0].instances == 2
        assert {c.name for c in expanded.classes} == {"bal-grp-ip", "bal-grp-is"}
    finally:
        session.rollback()
        session.close()


def test_below_threshold_lists_classes_under_the_limit():
    session = SessionLocal()
    try:
        category, region, sequence, frames, user_id = _fixture(session, "thr")
        common = _label(session, category, region, "bal-thr-common")
        rare = _label(session, category, region, "bal-thr-rare")
        for frame in frames:
            _annotate(session, frame, common, user_id)
        _annotate(session, frames[0], rare, user_id)

        report = compute_balance(
            session, [sequence.id], TaskType.DETECTION, GroupingRules(), set(), threshold=3
        )

        assert "bal-thr-rare" in report.below_threshold
        assert "bal-thr-common" not in report.below_threshold
        assert report.threshold == 3
    finally:
        session.rollback()
        session.close()


def test_negatives_are_counted_separately_and_form_no_class():
    session = SessionLocal()
    try:
        category, region, sequence, frames, user_id = _fixture(session, "negcount")
        polyp = _label(session, category, region, "bal-negcount-polyp")
        _annotate(session, frames[0], polyp, user_id)
        frames[1].no_findings_reviewed = True
        session.flush()

        report = compute_balance(session, [sequence.id], TaskType.DETECTION, GroupingRules(), set())

        assert report.negative_frames == 1
        assert report.total_frames == 2
        assert {c.name for c in report.classes} == {"bal-negcount-polyp"}
    finally:
        session.rollback()
        session.close()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_dataset_balance.py -v`
Expected: FAIL with `ImportError: cannot import name 'compute_imbalance_metrics'`.

- [ ] **Step 3: Implement metrics and balance**

Append to `backend/app/datasets/service.py`:

```python
import math

from app.taxonomy.hierarchy import GroupingRules, build_label_tree, resolve_class


@dataclass
class ClassCount:
    label_id: int
    name: str
    instances: int
    frames: int


@dataclass
class BalanceReport:
    classes: list[ClassCount]
    total_frames: int
    negative_frames: int
    below_threshold: list[str]
    threshold: int
    metrics: dict


def compute_imbalance_metrics(counts: dict[str, int]) -> dict:
    """Imbalance figures, thresholds taken from the Django reference's
    DatasetBalanceAnalyzer._assess_imbalance_severity.

    These are REFERENCE figures, not the headline. Collapsing a group raises
    imbalance_ratio (it grows the largest class while the singleton tail
    stays), so optimizing this number would push toward a few meaningless
    mega-classes. The actionable signal is BalanceReport.below_threshold.
    """
    if not counts:
        return {"severity": "no_data"}

    values = list(counts.values())
    total = sum(values)
    min_count, max_count = min(values), max(values)
    mean = total / len(values)
    variance = sum((v - mean) ** 2 for v in values) / len(values)
    std = math.sqrt(variance)

    imbalance_ratio = max_count / min_count if min_count > 0 else float("inf")

    entropy = -sum((v / total) * math.log(v / total) for v in values if v > 0)
    max_entropy = math.log(len(values)) if len(values) > 1 else 0.0
    normalized_entropy = entropy / max_entropy if max_entropy > 0 else 0.0

    ordered = sorted(values)
    n = len(ordered)
    cumulative = 0
    running_sum = 0
    for value in ordered:
        cumulative += value
        running_sum += cumulative
    gini = (n + 1 - 2 * running_sum / cumulative) / n if cumulative > 0 else 0.0

    if imbalance_ratio <= 1.5 and gini < 0.1:
        severity = "balanced"
    elif imbalance_ratio <= 3.0 and gini < 0.3:
        severity = "mild_imbalance"
    elif imbalance_ratio <= 10.0 and gini < 0.5:
        severity = "moderate_imbalance"
    elif imbalance_ratio <= 100.0 or min_count < 10:
        severity = "severe_imbalance"
    else:
        severity = "extreme_imbalance"

    return {
        "min_count": min_count,
        "max_count": max_count,
        "mean_count": mean,
        "std_count": std,
        "imbalance_ratio": imbalance_ratio,
        "coefficient_of_variation": std / mean if mean > 0 else 0.0,
        "normalized_entropy": normalized_entropy,
        "gini_index": gini,
        "severity": severity,
    }


def compute_balance(
    session: Session,
    sequence_ids: list[int],
    task_type: TaskType,
    rules: GroupingRules,
    excluded_label_ids: set[int],
    threshold: int = 10,
) -> BalanceReport:
    """Live class balance for a selection. Writes nothing.

    Classes resolve through the taxonomy's shared resolve_class, so this panel
    and any future export cannot disagree about what a class is.
    """
    composition = collect_frames(session, sequence_ids, task_type, excluded_label_ids)
    negative_frames = sum(1 for item in composition if item.is_negative)

    annotation_ids = [aid for item in composition for aid in item.annotation_ids]
    if not annotation_ids:
        return BalanceReport(
            classes=[], total_frames=len(composition), negative_frames=negative_frames,
            below_threshold=[], threshold=threshold,
            metrics=compute_imbalance_metrics({}),
        )

    rows = (
        session.query(Annotation.id, Annotation.frame_id, Annotation.label_id)
        .filter(Annotation.id.in_(annotation_ids))
        .all()
    )

    tree = build_label_tree(session)
    resolved_ids = {row.label_id: resolve_class(row.label_id, tree, rules) for row in rows}
    names = {
        label.id: label.name
        for label in session.query(Label).filter(Label.id.in_(set(resolved_ids.values()))).all()
    }

    instances: dict[int, int] = {}
    frames_by_class: dict[int, set[int]] = {}
    for row in rows:
        class_id = resolved_ids[row.label_id]
        instances[class_id] = instances.get(class_id, 0) + 1
        frames_by_class.setdefault(class_id, set()).add(row.frame_id)

    classes = [
        ClassCount(
            label_id=class_id,
            name=names.get(class_id, f"label-{class_id}"),
            instances=count,
            frames=len(frames_by_class[class_id]),
        )
        for class_id, count in instances.items()
    ]
    classes.sort(key=lambda c: (-c.instances, c.name))

    below = [c.name for c in classes if c.instances < threshold]
    metrics = compute_imbalance_metrics({c.name: c.instances for c in classes})

    return BalanceReport(
        classes=classes,
        total_frames=len(composition),
        negative_frames=negative_frames,
        below_threshold=below,
        threshold=threshold,
        metrics=metrics,
    )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_dataset_balance.py -v`
Expected: PASS (9 tests).

- [ ] **Step 5: Cross-check against the real database**

Verify the numbers match direct SQL rather than trusting the code's own arithmetic:

```bash
cd backend && PYTHONPATH=. uv run python -c "
from app.db import SessionLocal
from app.datasets.models import TaskType
from app.datasets.service import compute_balance
from app.taxonomy.hierarchy import GroupingRules
import sqlalchemy as sa

session = SessionLocal()
ids = [r[0] for r in session.execute(sa.text('SELECT id FROM sequences')).all()]
report = compute_balance(session, ids, TaskType.DETECTION, GroupingRules(), set())
print('total_frames', report.total_frames, 'negatives', report.negative_frames)
for c in report.classes:
    print(f'  {c.name}: {c.instances} instances / {c.frames} frames')
print('severity', report.metrics['severity'], 'below threshold', report.below_threshold)
session.close()
"
```

Compare against:
```bash
docker compose exec postgres psql -U endoscopy -c "
SELECT l.name, count(*) AS instances, count(DISTINCT a.frame_id) AS frames
FROM annotations a JOIN labels l ON l.id = a.label_id
JOIN evaluation_types et ON et.id = l.evaluation_type_id
WHERE et.annotation_scope = 'REGION' GROUP BY 1 ORDER BY 2 DESC;"
```

The polyp subtypes should appear **collapsed into `polyp`** in the Python output (Task 1 seeded that) while the SQL shows them separately — that difference is the grouping working, not a mismatch. Every other class must match exactly.

- [ ] **Step 6: Commit**

```bash
git add backend/app/datasets/service.py backend/tests/test_dataset_balance.py
git commit -m "feat: compute live dataset class balance and imbalance metrics"
```

---

### Task 5: Schemas, split assignment, and the API

**Files:**
- Create: `backend/app/datasets/schemas.py`, `backend/app/datasets/router.py`
- Modify: `backend/app/datasets/service.py` (append `assign_splits`, `create_dataset`)
- Modify: `backend/app/main.py` (register the router)
- Modify: `openapi.json` (regenerated)
- Test: `backend/tests/test_datasets_api.py`

**Interfaces:**
- Consumes: everything from Tasks 2-4.
- Produces:
  - `assign_splits(composition, sequence_by_frame, split_config) -> dict[int, SplitName]`.
  - `create_dataset(session, payload, user) -> Dataset`.
  - Endpoints: `POST /datasets/balance`, `POST /datasets`, `GET /datasets`, `GET /datasets/{id}`, `DELETE /datasets/{id}`.

**Splits are assigned per SEQUENCE, never per frame.** Consecutive frames of one video are near-duplicates; a frame in train with its neighbour in val is effectively the same image on both sides, inflating validation metrics into meaninglessness. Whole sequences are assigned; every frame inherits its sequence's split. With few sequences the realized percentages cannot match the requested ones (7 sequences at 70/20/10 lands on 71/14/14), so the response reports realized per-split frame counts alongside the request.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_datasets_api.py`:

```python
import app.main  # noqa: F401
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _register_and_login(email: str) -> dict[str, str]:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "admin"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_balance_endpoint_writes_nothing_and_returns_a_report():
    headers = _register_and_login("ds-api1@example.com")
    before = client.get("/datasets", headers=headers).json()

    response = client.post(
        "/datasets/balance",
        json={"sequence_ids": [], "task_type": "detection",
              "grouping_overrides": {}, "excluded_label_ids": [], "threshold": 10},
        headers=headers,
    )

    assert response.status_code == 200
    body = response.json()
    assert body["classes"] == []
    assert body["total_frames"] == 0
    assert body["metrics"]["severity"] == "no_data"
    assert client.get("/datasets", headers=headers).json() == before


def test_create_dataset_materializes_items_and_pins_taxonomy_version():
    headers = _register_and_login("ds-api2@example.com")
    sequences = client.get("/media/sequences", params={"page": 1, "page_size": 50}, headers=headers).json()
    sequence_ids = [s["id"] for s in sequences["items"]]

    response = client.post(
        "/datasets",
        json={
            "name": "ds-api2-dataset", "task_type": "detection",
            "sequence_ids": sequence_ids, "split_config": {"train": 70, "val": 20},
            "grouping_overrides": {}, "excluded_label_ids": [], "threshold": 10,
        },
        headers=headers,
    )

    assert response.status_code == 201
    body = response.json()
    assert body["taxonomy_version"] >= 1
    assert body["item_count"] == body["split_counts"]["train"] + body["split_counts"]["val"] + body["split_counts"]["test"]
    assert body["balance_metrics"]["severity"] in {
        "no_data", "balanced", "mild_imbalance", "moderate_imbalance",
        "severe_imbalance", "extreme_imbalance",
    }

    client.delete(f"/datasets/{body['id']}", headers=headers)


def test_every_frame_of_a_sequence_lands_in_the_same_split():
    # Frame-level splitting would leak: consecutive video frames are near-duplicates.
    headers = _register_and_login("ds-api3@example.com")
    sequences = client.get("/media/sequences", params={"page": 1, "page_size": 50}, headers=headers).json()
    sequence_ids = [s["id"] for s in sequences["items"]]

    created = client.post(
        "/datasets",
        json={
            "name": "ds-api3-dataset", "task_type": "detection",
            "sequence_ids": sequence_ids, "split_config": {"train": 70, "val": 20},
            "grouping_overrides": {}, "excluded_label_ids": [], "threshold": 10,
        },
        headers=headers,
    ).json()

    detail = client.get(f"/datasets/{created['id']}", headers=headers).json()
    splits_per_sequence: dict[int, set[str]] = {}
    for item in detail["items"]:
        splits_per_sequence.setdefault(item["sequence_id"], set()).add(item["split"])
    for sequence_id, splits in splits_per_sequence.items():
        assert len(splits) == 1, f"sequence {sequence_id} was split across {splits}"

    client.delete(f"/datasets/{created['id']}", headers=headers)


def test_delete_removes_the_dataset_and_its_items():
    headers = _register_and_login("ds-api4@example.com")
    created = client.post(
        "/datasets",
        json={
            "name": "ds-api4-dataset", "task_type": "detection", "sequence_ids": [],
            "split_config": {"train": 70, "val": 20}, "grouping_overrides": {},
            "excluded_label_ids": [], "threshold": 10,
        },
        headers=headers,
    ).json()

    assert client.delete(f"/datasets/{created['id']}", headers=headers).status_code == 204
    assert client.get(f"/datasets/{created['id']}", headers=headers).status_code == 404


def test_unknown_dataset_returns_404():
    headers = _register_and_login("ds-api5@example.com")
    assert client.get("/datasets/99999999", headers=headers).status_code == 404
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_datasets_api.py -v`
Expected: FAIL — 404s, because `/datasets` does not exist yet.

- [ ] **Step 3: Write the schemas**

Create `backend/app/datasets/schemas.py`:

```python
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.datasets.models import SplitName, TaskType


class GroupingOverrides(BaseModel):
    collapse: list[int] = Field(default_factory=list)
    expand: list[int] = Field(default_factory=list)


class BalanceRequest(BaseModel):
    sequence_ids: list[int] = Field(default_factory=list)
    task_type: TaskType
    grouping_overrides: GroupingOverrides = Field(default_factory=GroupingOverrides)
    excluded_label_ids: list[int] = Field(default_factory=list)
    threshold: int = 10


class ClassCountRead(BaseModel):
    label_id: int
    name: str
    instances: int
    frames: int


class BalanceReportRead(BaseModel):
    classes: list[ClassCountRead]
    total_frames: int
    negative_frames: int
    below_threshold: list[str]
    threshold: int
    metrics: dict


class DatasetCreate(BaseModel):
    name: str
    task_type: TaskType
    sequence_ids: list[int] = Field(default_factory=list)
    split_config: dict = Field(default_factory=lambda: {"train": 70, "val": 20})
    grouping_overrides: GroupingOverrides = Field(default_factory=GroupingOverrides)
    excluded_label_ids: list[int] = Field(default_factory=list)
    threshold: int = 10


class DatasetItemRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    frame_id: int
    sequence_id: int
    split: SplitName


class DatasetRead(BaseModel):
    id: int
    name: str
    task_type: TaskType
    taxonomy_version: int
    split_config: dict
    grouping_overrides: dict
    excluded_label_ids: list[int]
    balance_metrics: dict
    created_at: datetime
    item_count: int
    split_counts: dict[str, int]
    items: list[DatasetItemRead] = Field(default_factory=list)
```

- [ ] **Step 4: Implement split assignment and creation**

Append to `backend/app/datasets/service.py`:

```python
from app.datasets.models import Dataset, DatasetItem, SplitName


def assign_splits(
    sequence_ids: list[int], split_config: dict
) -> dict[int, SplitName]:
    """Assign whole sequences to splits; frames inherit their sequence's split.

    Splitting frames instead would leak -- consecutive frames of one video are
    near-duplicates, so the same image would sit on both sides of the split and
    inflate validation metrics into meaninglessness.

    With few sequences the realized fractions cannot match the requested ones
    (7 sequences at 70/20/10 lands on 71/14/14). Fill train first, then val,
    then test, and let the caller report realized counts.
    """
    ordered = sorted(sequence_ids)
    total = len(ordered)
    if total == 0:
        return {}

    train_pct = split_config.get("train", 70) / 100
    val_pct = split_config.get("val", 20) / 100

    train_n = int(total * train_pct)
    val_n = int(total * val_pct)
    # Guarantee at least one training sequence whenever anything was selected.
    if train_n == 0:
        train_n = 1
        val_n = min(val_n, max(total - train_n, 0))

    assignment: dict[int, SplitName] = {}
    for index, sequence_id in enumerate(ordered):
        if index < train_n:
            assignment[sequence_id] = SplitName.TRAIN
        elif index < train_n + val_n:
            assignment[sequence_id] = SplitName.VAL
        else:
            assignment[sequence_id] = SplitName.TEST
    return assignment


def create_dataset(session: Session, payload, user) -> Dataset:
    """Create a Dataset and freeze its frame list.

    Composition is materialized here rather than recomputed on read: otherwise
    tomorrow's annotation silently changes yesterday's dataset, and the split
    shifts with it.
    """
    rules = GroupingRules(
        collapse=frozenset(payload.grouping_overrides.collapse),
        expand=frozenset(payload.grouping_overrides.expand),
    )
    excluded = set(payload.excluded_label_ids)

    report = compute_balance(
        session, payload.sequence_ids, payload.task_type, rules, excluded, payload.threshold
    )
    composition = collect_frames(session, payload.sequence_ids, payload.task_type, excluded)

    taxonomy_version = (
        session.query(func.max(Label.taxonomy_version)).scalar() or 1
    )

    dataset = Dataset(
        name=payload.name,
        task_type=payload.task_type,
        taxonomy_version=taxonomy_version,
        split_config=payload.split_config,
        grouping_overrides=payload.grouping_overrides.model_dump(),
        excluded_label_ids=list(excluded),
        balance_metrics={
            "severity": report.metrics.get("severity"),
            "metrics": report.metrics,
            "classes": [
                {"label_id": c.label_id, "name": c.name,
                 "instances": c.instances, "frames": c.frames}
                for c in report.classes
            ],
            "below_threshold": report.below_threshold,
            "threshold": report.threshold,
            "negative_frames": report.negative_frames,
        },
        created_by_id=user.id,
    )
    session.add(dataset)
    session.flush()

    frame_ids = [item.frame_id for item in composition]
    sequence_by_frame = dict(
        session.query(Frame.id, Frame.sequence_id).filter(Frame.id.in_(frame_ids)).all()
    ) if frame_ids else {}

    split_by_sequence = assign_splits(payload.sequence_ids, payload.split_config)

    for item in composition:
        sequence_id = sequence_by_frame.get(item.frame_id)
        session.add(
            DatasetItem(
                dataset_id=dataset.id,
                frame_id=item.frame_id,
                annotation_ids=item.annotation_ids,
                split=split_by_sequence.get(sequence_id, SplitName.TRAIN),
            )
        )

    session.commit()
    session.refresh(dataset)
    return dataset
```

Add `from sqlalchemy import func` to the module's imports.

- [ ] **Step 5: Write the router**

Create `backend/app/datasets/router.py`:

```python
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.datasets.models import Dataset, DatasetItem
from app.datasets.schemas import (
    BalanceReportRead,
    BalanceRequest,
    DatasetCreate,
    DatasetRead,
)
from app.datasets.service import compute_balance, create_dataset
from app.db import get_session
from app.media.models import Frame
from app.taxonomy.hierarchy import GroupingRules

router = APIRouter(prefix="/datasets", tags=["datasets"], dependencies=[Depends(get_current_user)])


def _serialize(session: Session, dataset: Dataset, include_items: bool) -> dict:
    items = session.query(DatasetItem).filter(DatasetItem.dataset_id == dataset.id).all()
    split_counts = {"train": 0, "val": 0, "test": 0}
    for item in items:
        split_counts[item.split.value] += 1

    serialized_items = []
    if include_items and items:
        sequence_by_frame = dict(
            session.query(Frame.id, Frame.sequence_id)
            .filter(Frame.id.in_([i.frame_id for i in items]))
            .all()
        )
        serialized_items = [
            {
                "frame_id": item.frame_id,
                "sequence_id": sequence_by_frame.get(item.frame_id, 0),
                "split": item.split,
            }
            for item in items
        ]

    return {
        "id": dataset.id,
        "name": dataset.name,
        "task_type": dataset.task_type,
        "taxonomy_version": dataset.taxonomy_version,
        "split_config": dataset.split_config,
        "grouping_overrides": dataset.grouping_overrides,
        "excluded_label_ids": dataset.excluded_label_ids,
        "balance_metrics": dataset.balance_metrics,
        "created_at": dataset.created_at,
        "item_count": len(items),
        "split_counts": split_counts,
        "items": serialized_items,
    }


@router.post("/balance", response_model=BalanceReportRead)
def dataset_balance(payload: BalanceRequest, session: Session = Depends(get_session)) -> dict:
    """Live recompute for the panel. Writes nothing -- that is its contract."""
    rules = GroupingRules(
        collapse=frozenset(payload.grouping_overrides.collapse),
        expand=frozenset(payload.grouping_overrides.expand),
    )
    report = compute_balance(
        session, payload.sequence_ids, payload.task_type, rules,
        set(payload.excluded_label_ids), payload.threshold,
    )
    return {
        "classes": [
            {"label_id": c.label_id, "name": c.name, "instances": c.instances, "frames": c.frames}
            for c in report.classes
        ],
        "total_frames": report.total_frames,
        "negative_frames": report.negative_frames,
        "below_threshold": report.below_threshold,
        "threshold": report.threshold,
        "metrics": report.metrics,
    }


@router.post("", response_model=DatasetRead, status_code=status.HTTP_201_CREATED)
def create(
    payload: DatasetCreate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    dataset = create_dataset(session, payload, current_user)
    return _serialize(session, dataset, include_items=False)


@router.get("", response_model=list[DatasetRead])
def list_datasets(session: Session = Depends(get_session)) -> list[dict]:
    datasets = session.query(Dataset).order_by(Dataset.created_at.desc()).all()
    return [_serialize(session, dataset, include_items=False) for dataset in datasets]


@router.get("/{dataset_id}", response_model=DatasetRead)
def get_dataset(dataset_id: int, session: Session = Depends(get_session)) -> dict:
    dataset = session.get(Dataset, dataset_id)
    if dataset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found")
    return _serialize(session, dataset, include_items=True)


@router.delete("/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dataset(dataset_id: int, session: Session = Depends(get_session)) -> None:
    dataset = session.get(Dataset, dataset_id)
    if dataset is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found")
    session.query(DatasetItem).filter(DatasetItem.dataset_id == dataset_id).delete()
    session.delete(dataset)
    session.commit()
```

Register it in `backend/app/main.py`: add `from app.datasets.router import router as datasets_router` with the other router imports and `app.include_router(datasets_router)` with the other registrations. If Task 2 left a bare `import app.datasets.models` line, remove it — the router import now pulls the models in.

- [ ] **Step 6: Run the tests**

Run: `cd backend && uv run pytest tests/test_datasets_api.py -v`
Expected: PASS (5 tests).

- [ ] **Step 7: Regenerate the OpenAPI document**

```bash
cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py
git diff --stat openapi.json
```
Expected: a non-empty diff adding the five `/datasets` paths. If it is empty, the export did not pick up the router — do not proceed.

- [ ] **Step 8: Commit**

```bash
git add backend/app/datasets/ backend/app/main.py backend/tests/test_datasets_api.py openapi.json
git commit -m "feat: add datasets API with live balance and sequence-level splits"
```

---

### Task 6: Query hooks and the balance panel component

**Files:**
- Create: `frontend/src/entities/useDatasets.ts`
- Create: `frontend/src/features/datasets/BalancePanel.tsx`
- Test: `frontend/src/features/datasets/BalancePanel.test.tsx`

**Interfaces:**
- Consumes: the generated client's `/datasets/balance`, `/datasets` operations.
- Produces:
  - `useDatasetBalance(request)` — a TanStack Query hook, debounced by the caller.
  - `useDatasets()`, `useCreateDataset()`, `useDeleteDataset()`.
  - `<BalancePanel report={...} onToggleCollapse={...} onToggleExclude={...} collapsed={...} excluded={...} />`.

- [ ] **Step 1: Regenerate the API client**

```bash
cd frontend && npm run generate-api
grep -c "datasets" src/shared/api/generated/schema.d.ts
```
Expected: a non-zero count. If zero, Task 5's `openapi.json` regeneration did not land.

- [ ] **Step 2: Write the failing test**

Create `frontend/src/features/datasets/BalancePanel.test.tsx`. Read an existing panel test first (e.g. `src/features/tags/ClassificationsPanel.test.tsx`) and match its render/mocking style:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BalancePanel } from "./BalancePanel";

const REPORT = {
  classes: [
    { label_id: 1, name: "polyp", instances: 35, frames: 33 },
    { label_id: 2, name: "ileum", instances: 1, frames: 1 },
  ],
  total_frames: 34,
  negative_frames: 0,
  below_threshold: ["ileum"],
  threshold: 10,
  metrics: { severity: "severe_imbalance", imbalance_ratio: 35, gini_index: 0.69 },
};

function renderPanel(overrides = {}) {
  const props = {
    report: REPORT,
    collapsed: new Set<number>(),
    excluded: new Set<number>(),
    onToggleCollapse: vi.fn(),
    onToggleExclude: vi.fn(),
    ...overrides,
  };
  render(<BalancePanel {...props} />);
  return props;
}

describe("BalancePanel", () => {
  it("leads with the under-threshold classes", () => {
    renderPanel();
    expect(screen.getByTestId("below-threshold-summary")).toHaveTextContent("1");
    expect(screen.getByTestId("below-threshold-summary")).toHaveTextContent("ileum");
  });

  it("shows both instance and frame counts for each class", () => {
    renderPanel();
    const row = screen.getByTestId("class-row-1");
    expect(row).toHaveTextContent("35");
    expect(row).toHaveTextContent("33");
  });

  it("reports zero negatives explicitly rather than hiding the row", () => {
    renderPanel();
    expect(screen.getByTestId("negative-frames")).toHaveTextContent("0");
  });

  it("calls onToggleExclude with the label id when a class is excluded", async () => {
    const props = renderPanel();
    await userEvent.click(screen.getByTestId("exclude-2"));
    expect(props.onToggleExclude).toHaveBeenCalledWith(2);
  });

  it("shows severity as a secondary figure, not the headline", () => {
    renderPanel();
    const severity = screen.getByTestId("severity-reference");
    expect(severity).toHaveTextContent("severe_imbalance");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/features/datasets/BalancePanel.test.tsx`
Expected: FAIL — cannot resolve `./BalancePanel`.

- [ ] **Step 4: Write the hooks**

Create `frontend/src/entities/useDatasets.ts`, following `useSequencesList.ts`'s shape exactly:

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";
import type { components } from "../shared/api/generated/schema";

type BalanceRequest = components["schemas"]["BalanceRequest"];
type DatasetCreate = components["schemas"]["DatasetCreate"];

export function useDatasetBalance(request: BalanceRequest, enabled = true) {
  return useQuery({
    queryKey: ["dataset-balance", request],
    enabled,
    queryFn: async () => {
      const result = await apiClient.POST("/datasets/balance", { body: request });
      if (result.error) throw result.error;
      return result.data;
    },
  });
}

export function useDatasets() {
  return useQuery({
    queryKey: ["datasets"],
    queryFn: async () => {
      const result = await apiClient.GET("/datasets", {});
      if (result.error) throw result.error;
      return result.data;
    },
  });
}

export function useCreateDataset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: DatasetCreate) => {
      const result = await apiClient.POST("/datasets", { body });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["datasets"] }),
  });
}

export function useDeleteDataset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (datasetId: number) => {
      const result = await apiClient.DELETE("/datasets/{dataset_id}", {
        params: { path: { dataset_id: datasetId } },
      });
      if (result.error) throw result.error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["datasets"] }),
  });
}
```

- [ ] **Step 5: Write the panel**

Create `frontend/src/features/datasets/BalancePanel.tsx`. Dark theme only — copy class strings from an existing panel rather than inventing a palette:

```tsx
import type { components } from "../../shared/api/generated/schema";

type BalanceReportRead = components["schemas"]["BalanceReportRead"];

interface BalancePanelProps {
  report: BalanceReportRead;
  collapsed: Set<number>;
  excluded: Set<number>;
  onToggleCollapse: (labelId: number) => void;
  onToggleExclude: (labelId: number) => void;
}

export function BalancePanel({
  report,
  collapsed,
  excluded,
  onToggleCollapse,
  onToggleExclude,
}: BalancePanelProps) {
  const maxInstances = Math.max(1, ...report.classes.map((c) => c.instances));

  return (
    <div className="flex flex-col gap-4 text-sm text-gray-200">
      {/* The headline: an absolute per-class floor. Severity is deliberately
          NOT the lead -- collapsing a group raises imbalance_ratio while being
          the right call, so optimizing severity would mislead. */}
      <div
        data-testid="below-threshold-summary"
        className="rounded border border-amber-700 bg-amber-950 px-3 py-2"
      >
        <strong>{report.below_threshold.length}</strong> classes below{" "}
        {report.threshold} instances
        {report.below_threshold.length > 0 && (
          <span className="text-gray-300">: {report.below_threshold.join(", ")}</span>
        )}
      </div>

      <div className="flex gap-4 text-xs text-gray-400">
        <span data-testid="total-frames">Frames: {report.total_frames}</span>
        <span data-testid="negative-frames">Negatives: {report.negative_frames}</span>
      </div>

      <ul className="flex flex-col gap-1">
        {report.classes.map((entry) => (
          <li
            key={entry.label_id}
            data-testid={`class-row-${entry.label_id}`}
            className="flex items-center gap-2"
          >
            <input
              type="checkbox"
              data-testid={`exclude-${entry.label_id}`}
              aria-label={`Exclude ${entry.name}`}
              checked={!excluded.has(entry.label_id)}
              onChange={() => onToggleExclude(entry.label_id)}
            />
            <button
              type="button"
              data-testid={`collapse-${entry.label_id}`}
              aria-label={`Toggle grouping for ${entry.name}`}
              className="w-32 truncate text-left text-gray-100 hover:text-blue-400"
              onClick={() => onToggleCollapse(entry.label_id)}
            >
              {collapsed.has(entry.label_id) ? "▸" : "▾"} {entry.name}
            </button>
            <div className="h-3 flex-1 rounded bg-gray-800">
              <div
                className="h-3 rounded bg-blue-600"
                style={{ width: `${(entry.instances / maxInstances) * 100}%` }}
              />
            </div>
            <span className="w-24 text-right text-xs text-gray-400">
              {entry.instances} / {entry.frames}
            </span>
          </li>
        ))}
      </ul>

      <div data-testid="severity-reference" className="text-xs text-gray-500">
        Reference: {String(report.metrics.severity ?? "no_data")}
        {report.metrics.imbalance_ratio !== undefined &&
          ` · ratio ${Number(report.metrics.imbalance_ratio).toFixed(1)}`}
        {report.metrics.gini_index !== undefined &&
          ` · Gini ${Number(report.metrics.gini_index).toFixed(2)}`}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Run the tests**

Run: `cd frontend && npx vitest run src/features/datasets/BalancePanel.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/entities/useDatasets.ts frontend/src/features/datasets/
git commit -m "feat: add dataset query hooks and the class-balance panel"
```

---

### Task 7: The Dataset page

**Files:**
- Create: `frontend/src/features/datasets/DatasetsPage.tsx`
- Create: `frontend/src/features/datasets/DatasetsTable.tsx`
- Modify: `frontend/src/app/App.tsx` (add the `/datasets` route)
- Modify: `frontend/src/app/AppHeader.tsx` (add the nav item)
- Test: `frontend/src/features/datasets/DatasetsPage.test.tsx`

**Interfaces:**
- Consumes: Task 6's hooks and `BalancePanel`; the existing `useSequencesList` hook and `GET /media/sequences` for the picker.
- Produces: the `/datasets` route.

**Reuse, do not rebuild:** the sequence picker reads `GET /media/sequences`, which already supports procedure filtering, text search, pagination, `frame_count` and `labeled_frame_count`. No media-side change is needed.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/datasets/DatasetsPage.test.tsx`, mocking `apiClient` the way the existing page tests do (read `src/features/tags/TagsPage.test.tsx` first and match it):

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import { DatasetsPage } from "./DatasetsPage";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() },
}));

const SEQUENCES = {
  items: [
    { id: 1, name: "seq-a", video_id: 1, procedure_id: 1, frame_count: 100, labeled_frame_count: 10, preview_frames: [] },
    { id: 2, name: "seq-b", video_id: 1, procedure_id: 1, frame_count: 50, labeled_frame_count: 0, preview_frames: [] },
  ],
  total: 2,
};

const BALANCE = {
  classes: [{ label_id: 1, name: "polyp", instances: 35, frames: 33 }],
  total_frames: 33,
  negative_frames: 0,
  below_threshold: [],
  threshold: 10,
  metrics: { severity: "moderate_imbalance" },
};

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("DatasetsPage", () => {
  beforeEach(() => {
    vi.mocked(apiClient.GET).mockImplementation(async (path: string) => {
      if (path === "/media/sequences") return { data: SEQUENCES };
      if (path === "/datasets") return { data: [] };
      if (path === "/taxonomy/procedures") return { data: [] };
      return { data: [] };
    });
    vi.mocked(apiClient.POST).mockResolvedValue({ data: BALANCE });
  });

  it("lists selectable sequences", async () => {
    render(<DatasetsPage />, { wrapper });
    expect(await screen.findByText("seq-a")).toBeInTheDocument();
    expect(screen.getByText("seq-b")).toBeInTheDocument();
  });

  it("requests a balance recompute when a sequence is selected", async () => {
    render(<DatasetsPage />, { wrapper });
    await userEvent.click(await screen.findByLabelText(/select seq-a/i));

    await waitFor(() => {
      const balanceCalls = vi
        .mocked(apiClient.POST)
        .mock.calls.filter(([path]) => path === "/datasets/balance");
      expect(balanceCalls.length).toBeGreaterThan(0);
      expect(balanceCalls.at(-1)?.[1]?.body?.sequence_ids).toContain(1);
    });
  });

  it("disables saving until the dataset has a name", async () => {
    render(<DatasetsPage />, { wrapper });
    expect(await screen.findByRole("button", { name: /save dataset/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/name/i), "my-dataset");
    expect(screen.getByRole("button", { name: /save dataset/i })).toBeEnabled();
  });

  it("shows Test percentage as the computed remainder", async () => {
    render(<DatasetsPage />, { wrapper });
    await waitFor(() => expect(screen.getByTestId("test-remainder")).toHaveTextContent("10"));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/features/datasets/DatasetsPage.test.tsx`
Expected: FAIL — cannot resolve `./DatasetsPage`.

- [ ] **Step 3: Write `DatasetsTable`**

Create `frontend/src/features/datasets/DatasetsTable.tsx` — name, type, created date, frame count, and Delete. Follow `TagsTable.tsx`'s two-click confirm pattern rather than `window.confirm`:

```tsx
import { useState } from "react";

import type { components } from "../../shared/api/generated/schema";

type DatasetRead = components["schemas"]["DatasetRead"];

interface DatasetsTableProps {
  datasets: DatasetRead[];
  onDelete: (datasetId: number) => void;
}

export function DatasetsTable({ datasets, onDelete }: DatasetsTableProps) {
  const [armed, setArmed] = useState<number | null>(null);

  if (datasets.length === 0) {
    return <p className="text-sm text-gray-500">No datasets yet.</p>;
  }

  return (
    <table className="w-full text-left text-sm text-gray-200">
      <thead>
        <tr className="border-b border-gray-800 text-gray-400">
          <th className="px-4 py-2 font-normal">Name</th>
          <th className="px-4 py-2 font-normal">Type</th>
          <th className="px-4 py-2 font-normal">Frames</th>
          <th className="px-4 py-2 font-normal">Severity</th>
          <th className="px-4 py-2 font-normal">Created</th>
          <th className="px-4 py-2 text-right font-normal">Actions</th>
        </tr>
      </thead>
      <tbody>
        {datasets.map((dataset) => (
          <tr key={dataset.id} className="border-b border-gray-900">
            <td className="px-4 py-2">{dataset.name}</td>
            <td className="px-4 py-2 text-gray-400">{dataset.task_type}</td>
            <td className="px-4 py-2">{dataset.item_count}</td>
            <td className="px-4 py-2 text-gray-400">
              {String((dataset.balance_metrics as Record<string, unknown>)?.severity ?? "-")}
            </td>
            <td className="px-4 py-2 text-gray-400">
              {new Date(dataset.created_at).toLocaleDateString()}
            </td>
            <td className="px-4 py-2 text-right">
              {armed === dataset.id ? (
                <button
                  type="button"
                  className="rounded bg-red-700 px-2 py-1 text-xs text-white"
                  onClick={() => {
                    onDelete(dataset.id);
                    setArmed(null);
                  }}
                >
                  Confirm
                </button>
              ) : (
                <button
                  type="button"
                  className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300"
                  onClick={() => setArmed(dataset.id)}
                >
                  Delete
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 4: Write `DatasetsPage`**

Create `frontend/src/features/datasets/DatasetsPage.tsx`. Two columns; left is sequence selection plus config, right is `BalancePanel`; the table sits below. Key behaviours the tests pin:

- A 300 ms debounce before posting a balance recompute, so a click storm does not fire a request per click. Implement with `useEffect` + `setTimeout` over the selection/rules state, storing the debounced value in state and passing it to `useDatasetBalance`.
- Test percentage rendered as `100 - train - val` in an element with `data-testid="test-remainder"`.
- The Save button disabled while the name is empty.
- Each sequence checkbox labelled `Select <name>` so tests and screen readers can find it.
- Collapse/exclude state held as `Set<number>` and passed to `BalancePanel`; toggling either updates the debounced request body (`grouping_overrides.expand` receives ids the user expanded, `excluded_label_ids` receives excluded ids).
- **No Download button** — its absence is deliberate; do not add one.

Copy the page shell (heading, two-column grid, panel borders) from `TagsPage.tsx` so the screen matches the rest of the app. Dark theme only.

- [ ] **Step 5: Register the route and nav item**

In `frontend/src/app/App.tsx`, add the import and the route inside the authenticated layout, after `/sequences`:

```tsx
import { DatasetsPage } from "../features/datasets/DatasetsPage";
...
          <Route path="/datasets" element={<DatasetsPage />} />
```

In `frontend/src/app/AppHeader.tsx`, add to the nav array after `Sequences`:

```tsx
  { label: "Datasets", path: "/datasets" },
```

- [ ] **Step 6: Run the frontend suite**

```bash
cd frontend && npx vitest run src/features/datasets/
npm test
```
Expected: the datasets tests pass, and the whole suite stays green.

- [ ] **Step 7: Check for new product-code type errors**

```bash
cd frontend && npx tsc -b --noEmit 2>&1 | grep -E "features/datasets|entities/useDatasets" | grep -v "\.test\."
```
Expected: no output. Errors inside `.test.tsx` files from the pre-existing jest-dom gap are acceptable; errors in product code are not.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/features/datasets/ frontend/src/app/App.tsx frontend/src/app/AppHeader.tsx
git commit -m "feat: add the Dataset screen with live balance and grouping"
```

---

### Task 8: Real-browser verification and ROADMAP entry

**Files:**
- Modify: `ROADMAP.md`

**Interfaces:**
- Consumes: everything above.

Frontend unit tests mock `apiClient` wholesale and cannot observe that the panel actually recomputes against real data, or that a flagged frame really enters a dataset. This repo has paid for that lesson repeatedly — see ROADMAP's Phase 1 deviation log.

- [ ] **Step 1: Start the stack**

```bash
docker compose up -d
cd backend && uv run uvicorn app.main:app --port 8000
cd frontend && npm run dev
```

Note the port Vite reports. If 5173 is occupied by a stale server from an earlier session, Vite picks 5174 — **verify against the port your own `npm run dev` printed**, not against 5173 by assumption.

- [ ] **Step 2: Verify the panel against real data**

Log in as `manualcheck@example.com` / `manual-check-pass` (the password is `manual-check-pass`, NOT the test fixtures' `pass1234`). Go to `/datasets`:
- Select the sequences that carry annotations. The panel must show classes with both counts.
- **`polyp` must appear as one class of ~35 instances**, not five separate subtypes — that is Task 1's seeding plus the grouping working end to end.
- Click the collapse toggle on `polyp`: it must expand into `pedunculated_polyp_0_Ip`, `sessile_polyp_0_Is`, `flat_lesion_0_IIa`, `lst_g_nodular_mixed`, `lst_ng_flat_elevated`.
- Exclude a singleton class: it must disappear from the chart and the under-threshold list must shrink.
- Negatives must read **0** — no frame has `no_findings_reviewed` set. Confirm the panel says 0 rather than hiding the row.

- [ ] **Step 3: Verify a flagged frame becomes a negative**

This is the one path no test can cover end to end, and the feature that finally consumes `no_findings_reviewed`. In the sequence grid, mark one frame as no-findings, return to `/datasets`, reselect that sequence, and confirm the negative count increments by exactly 1. Then unmark it to leave the data as you found it.

- [ ] **Step 4: Save a dataset and confirm it freezes**

Save a dataset. Then annotate one more frame in an included sequence, and reopen `GET /datasets/{id}`: `item_count` must be unchanged. Composition is frozen at save time; only a new dataset picks up new annotation. Delete any dataset you created for this check.

- [ ] **Step 5: Run both suites**

```bash
cd backend && uv run pytest -q
cd frontend && npm test
```
Report the REAL numbers. Backend baseline was 244 passed / 15 pre-existing failures before this plan; expect the passing count to rise and the 15 to remain. Do not fix the 15.

- [ ] **Step 6: Add the ROADMAP entry**

Add a Phase 2b entry recording what shipped: the `datasets` module, composition rules including the negative-example semantics, `compute_balance` sharing `resolve_class`, sequence-level splits and why frame-level splitting was rejected, the screen, and the `polyp` seeding. Record explicitly that export is deliberately deferred, and that the first datasets contain zero negatives because the flag has never been set. Follow the deviation-log style the file already uses.

- [ ] **Step 7: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: record the Dataset screen implementation in ROADMAP"
```

---

## Deferred, deliberately (not this plan)

- YOLO export: `data.yaml`, image/label files, the resolved class-map fingerprint, archive download, `Dataset.storage_key`.
- The Train screen and `ModelVersion`.
- Auto-applied balance recommendations (the UI spec's checkbox). The Django reference has `_generate_filtering_recommendations`; trusting a heuristic blindly at 75 annotated frames is premature.
- `Dataset` editing. Datasets are create/delete only for now — editing one would reopen the frozen-composition question this plan deliberately settled.
