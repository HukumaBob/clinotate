# Label Hierarchy and Class Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `Label` a recursive parent edge and an abstract flag, migrate the three whole-frame quality labels to `frame_classification` under `low_quality`, and expose a pure `resolve_class` function that dataset export and the future balance panel will share.

**Architecture:** Two nullable-by-design columns on `labels` (`parent_label_id`, `is_abstract`), three invariants enforced in a new `app/taxonomy/hierarchy.py` service module (same procedure, no cycles, same `annotation_scope`) and wired into the existing `PATCH /taxonomy/labels/{id}` endpoint, which today `setattr`s fields with no validation. One Alembic migration performs the quality move entirely through `UPDATE`s so `label_id`s — and the annotations referencing them — survive. `resolve_class` walks the parent chain in memory; the tree is ~200 rows, so no recursive CTE.

**Tech Stack:** FastAPI, SQLAlchemy 2.0 (`Mapped`/`mapped_column`), Alembic, Pydantic v2, pytest, React + TypeScript, Vitest, Tailwind (dark-only).

**Spec:** [docs/superpowers/specs/2026-08-15-label-hierarchy-grouping-design.md](../specs/2026-08-15-label-hierarchy-grouping-design.md)

## Global Constraints

- **Language:** English only in all committed content — code, comments, docstrings, UI copy. No Russian anywhere in the repository.
- **UI theme:** dark only. Never introduce light-background classes.
- **`taxonomy_version`:** copied from the `Label` at creation time, never re-derived. This plan does **not** bump it when a parent changes — grouping is a way of reading a label, not the label itself.
- **API contract:** after any backend schema/route change, regenerate the committed OpenAPI document:
  `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py` (the `PYTHONPATH=.` is required), then verify with `git diff --stat openapi.json` that it actually changed. Never hand-edit anything under `frontend/src/shared/api/generated/`.
- **TDD:** every backend task and every frontend task with logic gets a failing test before the implementation.
- **Git:** commit directly to `master` in the primary working directory. Do not create a branch or worktree.
- **Backend tests** need the `endoscopy_test` database (created once via `docker compose exec postgres psql -U endoscopy -c "CREATE DATABASE endoscopy_test;"`). `tests/conftest.py` already redirects `app.db`'s engine there for the whole session.
- **Never truncate or delete rows from the `endoscopy` (dev) database** without asking the user first — real taxonomy structures live there.
- Current Alembic head at plan time: `2e14d4d8fc1d`. Task 1's migration revises it.

---

### Task 1: Add `parent_label_id` and `is_abstract` columns

**Files:**
- Modify: `backend/app/taxonomy/models.py:39-51`
- Create: `backend/alembic/versions/<generated>_add_label_hierarchy_columns.py`
- Test: `backend/tests/test_label_hierarchy.py`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `Label.parent_label_id: int | None` and `Label.is_abstract: bool` as SQLAlchemy mapped attributes; database columns `labels.parent_label_id` (nullable integer FK to `labels.id`) and `labels.is_abstract` (non-null boolean, default false).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_label_hierarchy.py`:

```python
from app.db import SessionLocal
from app.taxonomy.models import Category, EvaluationType, Label, Procedure
from app.taxonomy.models import AnnotationScope


def _make_label(session, name, procedure_name="hier-proc", scope=AnnotationScope.REGION):
    """Create a Label (plus its Procedure/Category/EvaluationType) for tests."""
    procedure = session.query(Procedure).filter_by(name=procedure_name).one_or_none()
    if procedure is None:
        procedure = Procedure(name=procedure_name)
        session.add(procedure)
        session.flush()
    category = (
        session.query(Category).filter_by(name="hier-cat", procedure_id=procedure.id).one_or_none()
    )
    if category is None:
        category = Category(name="hier-cat", procedure_id=procedure.id)
        session.add(category)
        session.flush()
    et_name = f"hier-et-{scope.value}"
    evaluation_type = session.query(EvaluationType).filter_by(name=et_name).one_or_none()
    if evaluation_type is None:
        evaluation_type = EvaluationType(name=et_name, annotation_scope=scope)
        session.add(evaluation_type)
        session.flush()
    label = Label(
        name=name,
        category_id=category.id,
        evaluation_type_id=evaluation_type.id,
    )
    session.add(label)
    session.flush()
    return label


def test_label_defaults_to_no_parent_and_not_abstract():
    session = SessionLocal()
    try:
        label = _make_label(session, "hier-plain")
        session.commit()
        session.refresh(label)
        assert label.parent_label_id is None
        assert label.is_abstract is False
    finally:
        session.rollback()
        session.close()


def test_label_can_reference_a_parent_label():
    session = SessionLocal()
    try:
        parent = _make_label(session, "hier-parent")
        child = _make_label(session, "hier-child")
        child.parent_label_id = parent.id
        parent.is_abstract = True
        session.commit()
        session.refresh(child)
        session.refresh(parent)
        assert child.parent_label_id == parent.id
        assert parent.is_abstract is True
    finally:
        session.rollback()
        session.close()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_label_hierarchy.py -v`
Expected: FAIL — `AttributeError: 'Label' object has no attribute 'parent_label_id'` (or a SQL error about the missing column).

- [ ] **Step 3: Add the columns to the model**

In `backend/app/taxonomy/models.py`, inside `class Label`, after the `taxonomy_version` line and before `created_at`:

```python
    parent_label_id: Mapped[int | None] = mapped_column(
        ForeignKey("labels.id"), nullable=True, default=None
    )
    is_abstract: Mapped[bool] = mapped_column(default=False)
```

`Boolean` does not need importing — SQLAlchemy infers it from the `bool` annotation. `ForeignKey` is already imported at the top of the file.

- [ ] **Step 4: Generate the migration**

Run: `cd backend && uv run alembic revision -m "add label hierarchy columns"`

Then replace the generated `upgrade`/`downgrade` bodies with:

```python
def upgrade() -> None:
    op.add_column('labels', sa.Column('parent_label_id', sa.Integer(), nullable=True))
    op.create_foreign_key(
        'fk_labels_parent_label_id', 'labels', 'labels', ['parent_label_id'], ['id']
    )
    op.add_column(
        'labels',
        sa.Column('is_abstract', sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column('labels', 'is_abstract')
    op.drop_constraint('fk_labels_parent_label_id', 'labels', type_='foreignkey')
    op.drop_column('labels', 'parent_label_id')
```

Confirm the generated file's `down_revision` is `'2e14d4d8fc1d'`. The `server_default=sa.false()` exists so the column can be `NOT NULL` on a table that already has ~200 rows; the model keeps a Python-side `default=False` for new inserts.

- [ ] **Step 5: Apply the migration to both databases**

```bash
cd backend && uv run alembic upgrade head
```

Then apply it to the test database as well, since `conftest.py` points there:

```bash
cd backend && DATABASE_URL="postgresql+psycopg://endoscopy:endoscopy@localhost:5432/endoscopy_test" uv run alembic upgrade head
```

Verify: `docker compose exec postgres psql -U endoscopy -c "\d labels"` shows both new columns.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_label_hierarchy.py -v`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add backend/app/taxonomy/models.py backend/alembic/versions/ backend/tests/test_label_hierarchy.py
git commit -m "feat: add parent_label_id and is_abstract to Label"
```

---

### Task 2: Hierarchy invariants (`validate_parent_assignment`)

**Files:**
- Create: `backend/app/taxonomy/hierarchy.py`
- Test: `backend/tests/test_label_hierarchy.py` (append)

**Interfaces:**
- Consumes: `Label.parent_label_id` from Task 1.
- Produces: `validate_parent_assignment(session: Session, label: Label, parent_label_id: int | None) -> None` — raises `HierarchyError` (a plain `Exception` subclass with a `.message: str`) when an invariant is violated, returns `None` otherwise. Task 3 maps `HierarchyError` to HTTP 422.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_label_hierarchy.py`:

```python
import pytest

from app.taxonomy.hierarchy import HierarchyError, validate_parent_assignment


def test_parent_from_a_different_procedure_is_rejected():
    session = SessionLocal()
    try:
        child = _make_label(session, "hier-child-proc-a", procedure_name="hier-proc-a")
        parent = _make_label(session, "hier-parent-proc-b", procedure_name="hier-proc-b")
        with pytest.raises(HierarchyError):
            validate_parent_assignment(session, child, parent.id)
    finally:
        session.rollback()
        session.close()


def test_parent_with_a_different_annotation_scope_is_rejected():
    session = SessionLocal()
    try:
        child = _make_label(session, "hier-region-child", scope=AnnotationScope.REGION)
        parent = _make_label(session, "hier-frame-parent", scope=AnnotationScope.FRAME)
        with pytest.raises(HierarchyError):
            validate_parent_assignment(session, child, parent.id)
    finally:
        session.rollback()
        session.close()


def test_direct_self_parent_is_rejected():
    session = SessionLocal()
    try:
        label = _make_label(session, "hier-self")
        with pytest.raises(HierarchyError):
            validate_parent_assignment(session, label, label.id)
    finally:
        session.rollback()
        session.close()


def test_indirect_cycle_is_rejected():
    session = SessionLocal()
    try:
        grandparent = _make_label(session, "hier-gp")
        parent = _make_label(session, "hier-p")
        child = _make_label(session, "hier-c")
        parent.parent_label_id = grandparent.id
        child.parent_label_id = parent.id
        session.flush()
        # Making the grandparent a child of its own descendant closes a loop.
        with pytest.raises(HierarchyError):
            validate_parent_assignment(session, grandparent, child.id)
    finally:
        session.rollback()
        session.close()


def test_unknown_parent_is_rejected():
    session = SessionLocal()
    try:
        label = _make_label(session, "hier-orphan")
        with pytest.raises(HierarchyError):
            validate_parent_assignment(session, label, 99999999)
    finally:
        session.rollback()
        session.close()


def test_valid_parent_assignment_passes():
    session = SessionLocal()
    try:
        parent = _make_label(session, "hier-ok-parent")
        child = _make_label(session, "hier-ok-child")
        assert validate_parent_assignment(session, child, parent.id) is None
    finally:
        session.rollback()
        session.close()


def test_clearing_the_parent_is_always_allowed():
    session = SessionLocal()
    try:
        label = _make_label(session, "hier-clear")
        assert validate_parent_assignment(session, label, None) is None
    finally:
        session.rollback()
        session.close()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_label_hierarchy.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.taxonomy.hierarchy'`.

- [ ] **Step 3: Implement the module**

Create `backend/app/taxonomy/hierarchy.py`:

```python
from sqlalchemy.orm import Session

from app.taxonomy.models import Category, EvaluationType, Label


class HierarchyError(Exception):
    """A proposed parent assignment violates a taxonomy hierarchy invariant."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def _procedure_id_of(session: Session, label: Label) -> int | None:
    category = session.get(Category, label.category_id)
    return None if category is None else category.procedure_id


def _scope_of(session: Session, label: Label):
    evaluation_type = session.get(EvaluationType, label.evaluation_type_id)
    return None if evaluation_type is None else evaluation_type.annotation_scope


def validate_parent_assignment(
    session: Session, label: Label, parent_label_id: int | None
) -> None:
    """Raise HierarchyError unless ``parent_label_id`` is a legal parent for ``label``.

    Three invariants, all enforced here rather than in the schema:

    1. The parent belongs to the same procedure. Procedure is only reachable
       through Category, so a composite foreign key would cost more than it is
       worth -- and quality labels are deliberately procedure-specific, which
       makes this check load-bearing rather than cosmetic.
    2. No cycles. Without this, class resolution would loop at export time
       instead of failing where the mistake was made.
    3. The parent shares the child's annotation_scope. Otherwise a mask label
       could hang under a whole-frame parent and export would emit a class
       mixing bounding boxes with frame-level marks -- the category error
       AnnotationScope exists to prevent, entered from the other side.
    """
    if parent_label_id is None:
        return

    if parent_label_id == label.id:
        raise HierarchyError("A label cannot be its own parent")

    parent = session.get(Label, parent_label_id)
    if parent is None:
        raise HierarchyError(f"Parent label {parent_label_id} does not exist")

    if _procedure_id_of(session, parent) != _procedure_id_of(session, label):
        raise HierarchyError("Parent label must belong to the same procedure as its child")

    if _scope_of(session, parent) != _scope_of(session, label):
        raise HierarchyError("Parent label must have the same annotation scope as its child")

    # Walk up from the proposed parent; reaching `label` would close a loop.
    seen: set[int] = set()
    current = parent
    while current is not None:
        if current.id == label.id:
            raise HierarchyError("Parent assignment would create a cycle")
        if current.id in seen:
            break  # pre-existing loop elsewhere in the tree; not this assignment's fault
        seen.add(current.id)
        current = (
            None
            if current.parent_label_id is None
            else session.get(Label, current.parent_label_id)
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_label_hierarchy.py -v`
Expected: PASS (9 tests total, including Task 1's two).

- [ ] **Step 5: Commit**

```bash
git add backend/app/taxonomy/hierarchy.py backend/tests/test_label_hierarchy.py
git commit -m "feat: validate label parent assignment invariants"
```

---

### Task 3: Expose parent and abstractness through the API

**Files:**
- Modify: `backend/app/taxonomy/schemas.py` (`LabelCreate`, `LabelUpdate`, `LabelRead`)
- Modify: `backend/app/taxonomy/router.py` (`create_label`, `update_label`)
- Modify: `openapi.json` (regenerated, not hand-edited)
- Test: `backend/tests/test_taxonomy.py` (append)

**Interfaces:**
- Consumes: `validate_parent_assignment`, `HierarchyError` from Task 2.
- Produces: `LabelRead.parent_label_id: int | None` and `LabelRead.is_abstract: bool` in every label-returning response (including `/taxonomy/tree`, which serializes through `LabelRead`); `PATCH /taxonomy/labels/{id}` returning 422 on an invalid parent.

**Why this task is not merely plumbing:** `update_label` currently loops `setattr` over every field in the payload with no validation whatsoever. Adding `parent_label_id` to `LabelUpdate` without also wiring in Task 2's checks would let all three invariants be violated through the ordinary edit endpoint.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_taxonomy.py`:

```python
def test_label_read_exposes_hierarchy_fields():
    headers = _auth_headers(_register_and_login("tax-hier1@example.com"))
    procedure = client.post(
        "/taxonomy/procedures", json={"name": "tax-hier1-proc"}, headers=headers
    ).json()
    category = client.post(
        "/taxonomy/categories",
        json={"name": "tax-hier1-cat", "procedure_id": procedure["id"]},
        headers=headers,
    ).json()
    evaluation_type = client.post(
        "/taxonomy/evaluation-types",
        json={"name": "tax-hier1-et", "annotation_scope": "region"},
        headers=headers,
    ).json()

    label = client.post(
        "/taxonomy/labels",
        json={
            "name": "tax-hier1-label",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=headers,
    ).json()

    assert label["parent_label_id"] is None
    assert label["is_abstract"] is False


def test_assigning_a_valid_parent_succeeds_and_marking_abstract_works():
    headers = _auth_headers(_register_and_login("tax-hier2@example.com"))
    procedure = client.post(
        "/taxonomy/procedures", json={"name": "tax-hier2-proc"}, headers=headers
    ).json()
    category = client.post(
        "/taxonomy/categories",
        json={"name": "tax-hier2-cat", "procedure_id": procedure["id"]},
        headers=headers,
    ).json()
    evaluation_type = client.post(
        "/taxonomy/evaluation-types",
        json={"name": "tax-hier2-et", "annotation_scope": "region"},
        headers=headers,
    ).json()

    def make_label(name):
        return client.post(
            "/taxonomy/labels",
            json={
                "name": name,
                "category_id": category["id"],
                "evaluation_type_id": evaluation_type["id"],
            },
            headers=headers,
        ).json()

    parent = make_label("tax-hier2-parent")
    child = make_label("tax-hier2-child")

    response = client.patch(
        f"/taxonomy/labels/{child['id']}",
        json={"parent_label_id": parent["id"]},
        headers=headers,
    )
    assert response.status_code == 200
    assert response.json()["parent_label_id"] == parent["id"]

    abstract_response = client.patch(
        f"/taxonomy/labels/{parent['id']}", json={"is_abstract": True}, headers=headers
    )
    assert abstract_response.status_code == 200
    assert abstract_response.json()["is_abstract"] is True


def test_assigning_a_cross_procedure_parent_returns_422():
    headers = _auth_headers(_register_and_login("tax-hier3@example.com"))
    evaluation_type = client.post(
        "/taxonomy/evaluation-types",
        json={"name": "tax-hier3-et", "annotation_scope": "region"},
        headers=headers,
    ).json()

    def make_label_in(procedure_name, category_name, label_name):
        procedure = client.post(
            "/taxonomy/procedures", json={"name": procedure_name}, headers=headers
        ).json()
        category = client.post(
            "/taxonomy/categories",
            json={"name": category_name, "procedure_id": procedure["id"]},
            headers=headers,
        ).json()
        return client.post(
            "/taxonomy/labels",
            json={
                "name": label_name,
                "category_id": category["id"],
                "evaluation_type_id": evaluation_type["id"],
            },
            headers=headers,
        ).json()

    child = make_label_in("tax-hier3-proc-a", "tax-hier3-cat-a", "tax-hier3-child")
    parent = make_label_in("tax-hier3-proc-b", "tax-hier3-cat-b", "tax-hier3-parent")

    response = client.patch(
        f"/taxonomy/labels/{child['id']}",
        json={"parent_label_id": parent["id"]},
        headers=headers,
    )
    assert response.status_code == 422


def test_self_parent_returns_422():
    headers = _auth_headers(_register_and_login("tax-hier4@example.com"))
    procedure = client.post(
        "/taxonomy/procedures", json={"name": "tax-hier4-proc"}, headers=headers
    ).json()
    category = client.post(
        "/taxonomy/categories",
        json={"name": "tax-hier4-cat", "procedure_id": procedure["id"]},
        headers=headers,
    ).json()
    evaluation_type = client.post(
        "/taxonomy/evaluation-types",
        json={"name": "tax-hier4-et", "annotation_scope": "region"},
        headers=headers,
    ).json()
    label = client.post(
        "/taxonomy/labels",
        json={
            "name": "tax-hier4-label",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=headers,
    ).json()

    response = client.patch(
        f"/taxonomy/labels/{label['id']}",
        json={"parent_label_id": label["id"]},
        headers=headers,
    )
    assert response.status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_taxonomy.py -k hier -v`
Expected: FAIL — `KeyError: 'parent_label_id'` on the first test (the field is not in the response yet).

- [ ] **Step 3: Extend the schemas**

In `backend/app/taxonomy/schemas.py`:

```python
class LabelCreate(BaseModel):
    name: str
    color: str = "#FFFFFF"
    category_id: int
    evaluation_type_id: int
    parent_label_id: int | None = None
    is_abstract: bool = False


class LabelUpdate(BaseModel):
    name: str | None = None
    color: str | None = None
    category_id: int | None = None
    evaluation_type_id: int | None = None
    parent_label_id: int | None = None
    is_abstract: bool | None = None


class LabelRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    color: str
    category_id: int
    evaluation_type_id: int
    taxonomy_version: int
    parent_label_id: int | None
    is_abstract: bool
```

Note `LabelUpdate.parent_label_id` is `int | None = None`, and the router already uses `model_dump(exclude_unset=True)` — so "clear the parent" (explicit `null`) and "don't touch the parent" (field absent) stay distinguishable.

- [ ] **Step 4: Wire validation into the router**

In `backend/app/taxonomy/router.py`, add to the imports:

```python
from app.taxonomy.hierarchy import HierarchyError, validate_parent_assignment
```

Replace the body of `create_label`:

```python
@router.post("/labels", response_model=LabelRead, status_code=status.HTTP_201_CREATED)
def create_label(payload: LabelCreate, session: Session = Depends(get_session)) -> Label:
    label = Label(**payload.model_dump())
    session.add(label)
    session.flush()
    try:
        validate_parent_assignment(session, label, label.parent_label_id)
    except HierarchyError as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=error.message
        ) from None
    session.commit()
    session.refresh(label)
    return label
```

Replace the body of `update_label`:

```python
@router.patch("/labels/{label_id}", response_model=LabelRead)
def update_label(label_id: int, payload: LabelUpdate, session: Session = Depends(get_session)) -> Label:
    label = session.get(Label, label_id)
    if label is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Label not found")
    fields = payload.model_dump(exclude_unset=True)
    if "parent_label_id" in fields:
        try:
            validate_parent_assignment(session, label, fields["parent_label_id"])
        except HierarchyError as error:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=error.message
            ) from None
    for field, value in fields.items():
        setattr(label, field, value)
    session.commit()
    session.refresh(label)
    return label
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_taxonomy.py -v`
Expected: PASS — the four new `hier` tests plus every pre-existing taxonomy test.

- [ ] **Step 6: Regenerate the OpenAPI document**

```bash
cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py
git diff --stat openapi.json
```

Expected: `openapi.json` shows changes (`LabelRead`, `LabelCreate`, `LabelUpdate` gained the two fields). If the diff is empty, the export did not pick up the change — do not proceed.

- [ ] **Step 7: Commit**

```bash
git add backend/app/taxonomy/schemas.py backend/app/taxonomy/router.py backend/tests/test_taxonomy.py openapi.json
git commit -m "feat: expose label parent and abstract flag through taxonomy API"
```

---

### Task 4: `resolve_class` — shared class resolution

**Files:**
- Modify: `backend/app/taxonomy/hierarchy.py` (append)
- Test: `backend/tests/test_resolve_class.py`

**Interfaces:**
- Consumes: `Label.parent_label_id`, `Label.is_abstract` from Task 1.
- Produces:
  - `LabelNode` — a dataclass with `id: int`, `parent_label_id: int | None`, `is_abstract: bool`.
  - `LabelTree` — a dataclass wrapping `nodes: dict[int, LabelNode]`, with a `has_children(label_id) -> bool` helper.
  - `GroupingRules` — a dataclass with `collapse: frozenset[int]`, `expand: frozenset[int]`, and `is_collapsed(tree, label_id) -> bool`.
  - `build_label_tree(session: Session) -> LabelTree`.
  - `resolve_class(label_id: int, tree: LabelTree, rules: GroupingRules) -> int`.

This is the function the dataset export and the future live balance panel both call. Sharing it is a requirement of the spec, not an optimization: a balance panel that reports classes the export would not produce is worse than no panel.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_resolve_class.py`:

```python
from app.taxonomy.hierarchy import GroupingRules, LabelNode, LabelTree, resolve_class


def _tree(*nodes: LabelNode) -> LabelTree:
    return LabelTree(nodes={node.id: node for node in nodes})


# Shape used by most tests:
#   1 polyp (abstract)
#     +-- 2 sessile
#     +-- 3 pedunculated
#   4 standalone (no parent, no children)
POLYP_TREE = _tree(
    LabelNode(id=1, parent_label_id=None, is_abstract=True),
    LabelNode(id=2, parent_label_id=1, is_abstract=False),
    LabelNode(id=3, parent_label_id=1, is_abstract=False),
    LabelNode(id=4, parent_label_id=None, is_abstract=False),
)


def test_root_leaf_resolves_to_itself():
    assert resolve_class(4, POLYP_TREE, GroupingRules()) == 4


def test_child_resolves_to_parent_by_default():
    # A node with children defaults to collapsed -- that is the taxonomy's memory.
    assert resolve_class(2, POLYP_TREE, GroupingRules()) == 1
    assert resolve_class(3, POLYP_TREE, GroupingRules()) == 1


def test_expanding_a_parent_keeps_children_separate():
    rules = GroupingRules(expand=frozenset({1}))
    assert resolve_class(2, POLYP_TREE, rules) == 2
    assert resolve_class(3, POLYP_TREE, rules) == 3


def test_a_collapsed_parent_resolves_to_itself():
    assert resolve_class(1, POLYP_TREE, GroupingRules()) == 1


def test_direct_annotations_on_a_concrete_parent_join_its_children():
    # low_quality (10) is concrete and carries its own annotations.
    tree = _tree(
        LabelNode(id=10, parent_label_id=None, is_abstract=False),
        LabelNode(id=11, parent_label_id=10, is_abstract=False),
        LabelNode(id=12, parent_label_id=10, is_abstract=False),
    )
    rules = GroupingRules()
    assert resolve_class(10, tree, rules) == 10
    assert resolve_class(11, tree, rules) == 10
    assert resolve_class(12, tree, rules) == 10


def test_expanded_concrete_parent_forms_its_own_class():
    tree = _tree(
        LabelNode(id=10, parent_label_id=None, is_abstract=False),
        LabelNode(id=11, parent_label_id=10, is_abstract=False),
    )
    rules = GroupingRules(expand=frozenset({10}))
    assert resolve_class(10, tree, rules) == 10
    assert resolve_class(11, tree, rules) == 11


def test_highest_collapsed_ancestor_wins_in_a_multi_level_tree():
    # 100 polyp -> 200 LST -> 300 lst_g_homogeneous
    # The schema permits depth even though the first UI renders one level,
    # so the behaviour is pinned here.
    tree = _tree(
        LabelNode(id=100, parent_label_id=None, is_abstract=True),
        LabelNode(id=200, parent_label_id=100, is_abstract=True),
        LabelNode(id=300, parent_label_id=200, is_abstract=False),
    )
    assert resolve_class(300, tree, GroupingRules()) == 100


def test_expanding_the_top_falls_back_to_the_next_collapsed_ancestor():
    tree = _tree(
        LabelNode(id=100, parent_label_id=None, is_abstract=True),
        LabelNode(id=200, parent_label_id=100, is_abstract=True),
        LabelNode(id=300, parent_label_id=200, is_abstract=False),
    )
    rules = GroupingRules(expand=frozenset({100}))
    assert resolve_class(300, tree, rules) == 200


def test_abstractness_does_not_affect_resolution():
    # Expanding an abstract parent is legitimate: it yields the subtypes as
    # classes with no parent class at all. is_abstract governs who may
    # annotate a label, never how it resolves.
    rules = GroupingRules(expand=frozenset({1}))
    assert resolve_class(2, POLYP_TREE, rules) == 2
    assert resolve_class(1, POLYP_TREE, rules) == 1


def test_unknown_label_resolves_to_itself():
    assert resolve_class(9999, POLYP_TREE, GroupingRules()) == 9999
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_resolve_class.py -v`
Expected: FAIL with `ImportError: cannot import name 'GroupingRules' from 'app.taxonomy.hierarchy'`.

- [ ] **Step 3: Implement the resolution machinery**

Append to `backend/app/taxonomy/hierarchy.py`:

```python
from dataclasses import dataclass, field


@dataclass(frozen=True)
class LabelNode:
    id: int
    parent_label_id: int | None
    is_abstract: bool


@dataclass(frozen=True)
class LabelTree:
    nodes: dict[int, LabelNode]

    def has_children(self, label_id: int) -> bool:
        return any(node.parent_label_id == label_id for node in self.nodes.values())


@dataclass(frozen=True)
class GroupingRules:
    """A dataset's deviations from the taxonomy's default grouping.

    Empty rules mean "exactly as the taxonomy says" -- which is what makes the
    knob remember its position instead of starting from zero every time.
    """

    collapse: frozenset[int] = field(default_factory=frozenset)
    expand: frozenset[int] = field(default_factory=frozenset)

    def is_collapsed(self, tree: LabelTree, label_id: int) -> bool:
        if label_id in self.expand:
            return False
        if label_id in self.collapse:
            return True
        return tree.has_children(label_id)


def build_label_tree(session: Session) -> LabelTree:
    """Load every label's hierarchy position in one query.

    ~200 labels today; a recursive CTE would be more machinery than the whole
    tree costs to hold in memory, and it will still be hundreds of kilobytes
    at thousands of labels.
    """
    rows = session.query(Label.id, Label.parent_label_id, Label.is_abstract).all()
    return LabelTree(
        nodes={
            row.id: LabelNode(
                id=row.id, parent_label_id=row.parent_label_id, is_abstract=row.is_abstract
            )
            for row in rows
        }
    )


def resolve_class(label_id: int, tree: LabelTree, rules: GroupingRules) -> int:
    """Return the label_id whose name this annotation's export class takes.

    Walk up the parent chain, remembering the *highest* collapsed ancestor --
    highest rather than first, so that under multi-level trees collapsing
    `polyp` beats collapsing `LST` instead of the answer depending on
    traversal order.

    A concrete parent's own direct annotations need no special case: the
    parent resolves to itself and its children resolve to the parent, so both
    land in the same class.
    """
    node = tree.nodes.get(label_id)
    if node is None:
        return label_id

    resolved = label_id
    seen: set[int] = {label_id}
    current = node
    while current.parent_label_id is not None:
        parent_id = current.parent_label_id
        if parent_id in seen:  # defensive: a loop that validation did not catch
            break
        seen.add(parent_id)
        parent = tree.nodes.get(parent_id)
        if parent is None:
            break
        if rules.is_collapsed(tree, parent_id):
            resolved = parent_id
        current = parent

    return resolved
```

Move the `from dataclasses import ...` import to the top of the file alongside the existing imports rather than leaving it mid-file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_resolve_class.py -v`
Expected: PASS (10 tests).

- [ ] **Step 5: Run the whole backend suite for regressions**

Run: `cd backend && uv run pytest -q`
Expected: PASS across the suite.

- [ ] **Step 6: Commit**

```bash
git add backend/app/taxonomy/hierarchy.py backend/tests/test_resolve_class.py
git commit -m "feat: add resolve_class shared by export and balance panel"
```

---

### Task 5: Quality-label migration

**Files:**
- Create: `backend/alembic/versions/<generated>_move_whole_frame_quality_labels.py`
- Test: `backend/tests/test_quality_migration.py`

**Interfaces:**
- Consumes: the columns from Task 1.
- Produces: no Python interface — a data migration. After it, `bad_picture`, `close_focus` and both `dirty_optic` rows have `frame_classification` as their evaluation type and their own procedure's `low_quality` as parent, while staying in the `Quality` category they already sit in.

**Why every step is an UPDATE:** the stated principle is that losing annotation data is tolerable but losing taxonomy structure is not. `UPDATE` preserves `label_id`s, and with them every annotation that references them. Delete-and-recreate would be simpler to write and would silently orphan data.

**Facts confirmed against the dev database at plan time** — re-verify before relying on them, since ids are environment-specific:
- A `Quality` category **already exists for both procedures**: id 111 (colono), id 108 (egds). Each holds a mix of geometric and frame-classification labels, so no new category needs creating — `Category` is keyed on `(name, procedure_id)`, and both rows are present.
- `dirty_optic` id 2222 is **colono**, in category 111. `bad_picture` id 2171, `close_focus` id 2166 and `dirty_optic` id 2165 are **egds**, in category 108. All four are currently `geometric`.
- `low_quality` id 2373 is **colono**, in category 111 — the same category as colono's `dirty_optic`. It carries all 32 CLASSIFICATION annotations in the database. There is no egds `low_quality` yet.
- Zero annotations reference the four labels being moved.

**What this means for the migration:** every label is *already* in its own procedure's `Quality` category, so `category_id` never changes — only `evaluation_type_id` does. The one row that must be created is an **egds** `low_quality`, to parent the three egds labels; colono's already exists. The SQL below is written to be idempotent and keyed on names rather than ids, so it stays correct if another environment's layout differs.

- [ ] **Step 1: Confirm the starting state**

```bash
docker compose exec postgres psql -U endoscopy -c "
SELECT l.id, l.name, p.name AS procedure, c.name AS category, et.name AS eval
FROM labels l
JOIN categories c ON c.id = l.category_id
JOIN procedures p ON p.id = c.procedure_id
JOIN evaluation_types et ON et.id = l.evaluation_type_id
WHERE l.name IN ('bad_picture','close_focus','dirty_optic','low_quality')
ORDER BY l.name, p.name;"
```

Compare the output against the facts block above. The migration keys on names and procedures rather than ids, and Task 5's tests are name-based too, so differing ids are fine — but if the *shape* differs (for instance a procedure with no `Quality` category at all, or an existing egds `low_quality`), read the SQL's `NOT EXISTS` guards to confirm they still do the right thing before applying it.

- [ ] **Step 2: Write the failing test**

Create `backend/tests/test_quality_migration.py`:

```python
"""Verifies the whole-frame quality labels landed in frame_classification.

These assertions run against whatever database the suite is pointed at, and
they are name-based rather than id-based so they hold in both the dev and the
test database.
"""

from app.db import SessionLocal
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label

WHOLE_FRAME_QUALITY_NAMES = ("bad_picture", "close_focus", "dirty_optic")


def _labels_named(session, name):
    return session.query(Label).filter(Label.name == name).all()


def test_whole_frame_quality_labels_are_frame_scoped():
    session = SessionLocal()
    try:
        for name in WHOLE_FRAME_QUALITY_NAMES:
            labels = _labels_named(session, name)
            assert labels, f"expected at least one {name} label"
            for label in labels:
                evaluation_type = session.get(EvaluationType, label.evaluation_type_id)
                assert evaluation_type.name == "frame_classification", (
                    f"{name} (id {label.id}) is still {evaluation_type.name}"
                )
                assert evaluation_type.annotation_scope == AnnotationScope.FRAME
    finally:
        session.close()


def test_whole_frame_quality_labels_hang_under_low_quality_of_their_procedure():
    session = SessionLocal()
    try:
        for name in WHOLE_FRAME_QUALITY_NAMES:
            for label in _labels_named(session, name):
                assert label.parent_label_id is not None, f"{name} has no parent"
                parent = session.get(Label, label.parent_label_id)
                assert parent.name == "low_quality"
                child_category = session.get(Category, label.category_id)
                parent_category = session.get(Category, parent.category_id)
                assert child_category.procedure_id == parent_category.procedure_id
    finally:
        session.close()


def test_every_procedure_with_moved_labels_has_its_own_low_quality():
    session = SessionLocal()
    try:
        low_quality_procedures = set()
        for label in _labels_named(session, "low_quality"):
            category = session.get(Category, label.category_id)
            low_quality_procedures.add(category.procedure_id)

        for name in WHOLE_FRAME_QUALITY_NAMES:
            for label in _labels_named(session, name):
                category = session.get(Category, label.category_id)
                assert category.procedure_id in low_quality_procedures
    finally:
        session.close()


def test_low_quality_is_concrete_not_abstract():
    # "The frame is bad, the reason does not matter" is a legitimate call;
    # forcing annotators to always name a cause would slow annotation down for
    # data nobody needs.
    session = SessionLocal()
    try:
        for label in _labels_named(session, "low_quality"):
            assert label.is_abstract is False
    finally:
        session.close()


def test_region_scoped_quality_labels_were_not_moved():
    # Foam and feces occupy a specific part of the frame and must stay
    # outlineable; only labels describing the whole frame moved.
    session = SessionLocal()
    try:
        for name in ("foam", "feces", "mucus", "bilis", "liquor", "bad_preparation"):
            for label in _labels_named(session, name):
                evaluation_type = session.get(EvaluationType, label.evaluation_type_id)
                assert evaluation_type.annotation_scope == AnnotationScope.REGION, (
                    f"{name} (id {label.id}) should have stayed region-scoped"
                )
    finally:
        session.close()
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd backend && uv run pytest tests/test_quality_migration.py -v`
Expected: FAIL — the labels are still `geometric`.

Note: if the *test* database has no taxonomy imported, these tests will fail on the `assert labels` guard instead. In that case, import the taxonomy into the test database first (see `tests/test_import_taxonomy.py` for the fixture data used), so the test fails for the right reason.

- [ ] **Step 4: Write the migration**

Run `cd backend && uv run alembic revision -m "move whole frame quality labels to frame classification"`, then write:

```python
WHOLE_FRAME_QUALITY = "('bad_picture', 'close_focus', 'dirty_optic')"


def upgrade() -> None:
    connection = op.get_bind()

    # 1. Ensure a Quality category exists for every procedure that owns one of
    #    the labels being moved. In the dev database both already exist (the
    #    category holds a mix of geometric and frame-classification labels), so
    #    this inserts nothing there -- it is here so the migration is correct in
    #    an environment whose taxonomy was imported differently.
    #    Quality stays procedure-specific by design: defocus is defocus, but the
    #    image differs between organs and such frames are plentiful, so keeping
    #    colono and egds apart preserves real training signal.
    connection.execute(sa.text(f"""
        INSERT INTO categories (name, procedure_id)
        SELECT DISTINCT 'Quality', c.procedure_id
        FROM labels l
        JOIN categories c ON c.id = l.category_id
        WHERE l.name IN {WHOLE_FRAME_QUALITY}
          AND NOT EXISTS (
              SELECT 1 FROM categories existing
              WHERE existing.name = 'Quality' AND existing.procedure_id = c.procedure_id
          )
    """))

    # 2. Give every such procedure its own low_quality parent. Colono's already
    #    exists (id 2373 in dev, holding all 32 CLASSIFICATION annotations) and
    #    is left untouched; egds gets a fresh one. This is the only row this
    #    migration creates.
    connection.execute(sa.text(f"""
        INSERT INTO labels (name, color, category_id, evaluation_type_id, taxonomy_version,
                            is_abstract, created_at)
        SELECT DISTINCT 'low_quality', '#FFFFFF', quality_cat.id, et.id, 1, false, now()
        FROM labels l
        JOIN categories own_cat ON own_cat.id = l.category_id
        JOIN categories quality_cat
          ON quality_cat.name = 'Quality' AND quality_cat.procedure_id = own_cat.procedure_id
        CROSS JOIN evaluation_types et
        WHERE l.name IN {WHOLE_FRAME_QUALITY}
          AND et.name = 'frame_classification'
          AND NOT EXISTS (
              SELECT 1 FROM labels existing
              JOIN categories existing_cat ON existing_cat.id = existing.category_id
              WHERE existing.name = 'low_quality'
                AND existing_cat.procedure_id = own_cat.procedure_id
          )
    """))

    # 3. Move the labels to frame_classification. Their category_id already
    #    points at their own procedure's Quality category, so only the
    #    evaluation type changes -- but set the category explicitly anyway, so
    #    the migration is correct where step 1 did create a category. Ids are
    #    preserved, and with them every annotation that references them.
    connection.execute(sa.text(f"""
        UPDATE labels l
        SET evaluation_type_id = (
                SELECT id FROM evaluation_types WHERE name = 'frame_classification'
            ),
            category_id = (
                SELECT quality_cat.id
                FROM categories quality_cat
                JOIN categories own ON own.id = l.category_id
                WHERE quality_cat.name = 'Quality'
                  AND quality_cat.procedure_id = own.procedure_id
                LIMIT 1
            )
        WHERE l.name IN {WHOLE_FRAME_QUALITY}
    """))

    # 4. Hang each moved label under the low_quality of its own procedure.
    connection.execute(sa.text(f"""
        UPDATE labels l
        SET parent_label_id = (
            SELECT parent.id
            FROM labels parent
            JOIN categories parent_cat ON parent_cat.id = parent.category_id
            JOIN categories own_cat ON own_cat.id = l.category_id
            WHERE parent.name = 'low_quality'
              AND parent_cat.procedure_id = own_cat.procedure_id
            LIMIT 1
        )
        WHERE l.name IN {WHOLE_FRAME_QUALITY}
    """))


def downgrade() -> None:
    connection = op.get_bind()

    connection.execute(sa.text(f"""
        UPDATE labels
        SET parent_label_id = NULL
        WHERE name IN {WHOLE_FRAME_QUALITY}
    """))

    # Return them to geometric. Their category does not change, for the same
    # reason it did not change on the way up.
    connection.execute(sa.text(f"""
        UPDATE labels
        SET evaluation_type_id = (SELECT id FROM evaluation_types WHERE name = 'geometric')
        WHERE name IN {WHOLE_FRAME_QUALITY}
    """))

    # Identify the low_quality rows this migration created: a procedure's
    # low_quality that has no annotations AND is not the oldest such row.
    # Ordering by created_at rather than id, since id ordering is an accident
    # of insert order rather than a fact about which row predates the migration.
    orphan_ids = [
        row[0]
        for row in connection.execute(sa.text("""
            SELECT l.id
            FROM labels l
            WHERE l.name = 'low_quality'
              AND l.created_at > (
                  SELECT min(created_at) FROM labels WHERE name = 'low_quality'
              )
        """))
    ]

    if not orphan_ids:
        return

    # Refuse to delete anything an annotator has since used. Silently deleting
    # annotated data on a downgrade is not acceptable; failing loudly is.
    annotated = connection.execute(
        sa.text("SELECT count(*) FROM annotations WHERE label_id = ANY(:ids)"),
        {"ids": orphan_ids},
    ).scalar()
    if annotated:
        raise RuntimeError(
            f"Refusing to downgrade: {annotated} annotation(s) reference a low_quality "
            "label this migration created. Reassign or delete them first."
        )

    connection.execute(
        sa.text("DELETE FROM labels WHERE id = ANY(:ids)"), {"ids": orphan_ids}
    )
```

- [ ] **Step 5: Apply to the test database and run the test**

```bash
cd backend && DATABASE_URL="postgresql+psycopg://endoscopy:endoscopy@localhost:5432/endoscopy_test" uv run alembic upgrade head
uv run pytest tests/test_quality_migration.py -v
```

Expected: PASS (5 tests).

- [ ] **Step 6: Verify the downgrade guard actually guards**

```bash
cd backend && DATABASE_URL="postgresql+psycopg://endoscopy:endoscopy@localhost:5432/endoscopy_test" uv run alembic downgrade -1
DATABASE_URL="postgresql+psycopg://endoscopy:endoscopy@localhost:5432/endoscopy_test" uv run alembic upgrade head
```

Expected: both succeed on a database whose created twin has no annotations. Confirm the labels are back to `frame_classification` afterwards by rerunning the test from Step 5.

- [ ] **Step 7: Apply to the dev database and verify against real data**

```bash
cd backend && uv run alembic upgrade head
docker compose exec postgres psql -U endoscopy -c "
SELECT l.id, l.name, p.name AS procedure, et.name AS eval, l.parent_label_id
FROM labels l
JOIN categories c ON c.id = l.category_id
JOIN procedures p ON p.id = c.procedure_id
JOIN evaluation_types et ON et.id = l.evaluation_type_id
WHERE l.name IN ('bad_picture','close_focus','dirty_optic','low_quality')
ORDER BY l.name, p.name;"

docker compose exec postgres psql -U endoscopy -c "
SELECT count(*) AS still_32 FROM annotations WHERE label_id = 2373;"
```

Expected: the three labels show `frame_classification` with a non-null `parent_label_id`; ids 2171, 2166, 2165, 2222 are unchanged; label 2373 still has exactly 32 annotations.

- [ ] **Step 8: Commit**

```bash
git add backend/alembic/versions/ backend/tests/test_quality_migration.py
git commit -m "feat: move whole-frame quality labels to frame_classification"
```

---

### Task 6: Hide abstract labels from annotation pickers

**Files:**
- Modify: `frontend/src/features/annotation/CascadingLabelPicker.tsx:23-31`
- Modify: `frontend/src/features/annotation/SequenceGridToolbar.tsx:58-72`
- Test: `frontend/src/features/annotation/CascadingLabelPicker.test.tsx` (append)
- Test: `frontend/src/features/annotation/SequenceGridToolbar.test.tsx` (append)

**Interfaces:**
- Consumes: `LabelRead.is_abstract` from Task 3, reaching the frontend through the regenerated `schema.d.ts`.
- Produces: no new exports — behaviour change only.

An abstract label is a grouping container. Letting an annotator pick `polyp` when a subtype was meant produces an orphan that no leaf-level export can place.

- [ ] **Step 1: Regenerate the API client**

```bash
cd frontend && npm run generate-api
grep -n "is_abstract" src/shared/api/generated/schema.d.ts | head -3
```

Expected: `is_abstract` appears. If not, `openapi.json` was not regenerated in Task 3 — go back and fix that first.

- [ ] **Step 2: Write the failing test for `CascadingLabelPicker`**

Append to `frontend/src/features/annotation/CascadingLabelPicker.test.tsx`, following the fixture shape already used at the top of that file (add `is_abstract: false` to the existing fixture labels, and one abstract label):

```tsx
it("does not offer abstract labels as tag options", async () => {
  const treeWithAbstractParent = [
    {
      category: { id: 1, name: "Findings", procedure_id: 1 },
      evaluation_types: [
        {
          evaluation_type: { id: 10, name: "geometric", annotation_scope: "region" },
          labels: [
            {
              id: 50,
              name: "polyp",
              color: "#FF0000",
              category_id: 1,
              evaluation_type_id: 10,
              taxonomy_version: 1,
              parent_label_id: null,
              is_abstract: true,
            },
            {
              id: 51,
              name: "sessile_polyp_0_Is",
              color: "#00FF00",
              category_id: 1,
              evaluation_type_id: 10,
              taxonomy_version: 1,
              parent_label_id: 50,
              is_abstract: false,
            },
          ],
        },
      ],
    },
  ];

  renderPicker(treeWithAbstractParent, { labelCategoryId: 1 });

  expect(await screen.findByRole("option", { name: "sessile_polyp_0_Is" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "polyp" })).not.toBeInTheDocument();
});
```

Reuse the file's existing render helper and mock setup rather than inventing a new one — read the top of the test file and match it. If the existing helper is not named `renderPicker`, use whatever the file already defines.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/features/annotation/CascadingLabelPicker.test.tsx`
Expected: FAIL — `polyp` is still offered as an option.

- [ ] **Step 4: Filter abstract labels in `CascadingLabelPicker`**

In `frontend/src/features/annotation/CascadingLabelPicker.tsx`, replace the `tagOptions` computation:

```tsx
  // Abstract labels are grouping containers for dataset export, not things an
  // annotator can put on a frame.
  const tagOptions = (
    labelClassification === null
      ? evaluationTypeOptions.flatMap((node) => node.labels)
      : (selectedEvaluationTypeNode?.labels ?? [])
  ).filter((label) => !label.is_abstract);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/features/annotation/CascadingLabelPicker.test.tsx`
Expected: PASS.

- [ ] **Step 6: Write the failing test for `SequenceGridToolbar`**

Append to `frontend/src/features/annotation/SequenceGridToolbar.test.tsx`, matching the file's existing render helper and taxonomy fixture shape:

```tsx
it("does not offer abstract labels in the classification dropdown", async () => {
  const tree = [
    {
      category: { id: 3, name: "Quality", procedure_id: 1 },
      evaluation_types: [
        {
          evaluation_type: { id: 9, name: "frame_classification", annotation_scope: "frame" },
          labels: [
            {
              id: 70,
              name: "quality_group",
              color: "#FFFFFF",
              category_id: 3,
              evaluation_type_id: 9,
              taxonomy_version: 1,
              parent_label_id: null,
              is_abstract: true,
            },
            {
              id: 71,
              name: "close_focus",
              color: "#FFFFFF",
              category_id: 3,
              evaluation_type_id: 9,
              taxonomy_version: 1,
              parent_label_id: 70,
              is_abstract: false,
            },
          ],
        },
      ],
    },
  ];

  renderToolbar({ taxonomyTree: tree, selectionMode: true });

  // Pick the category so its labels render.
  await userEvent.selectOptions(screen.getByLabelText(/category/i), "3");

  expect(await screen.findByRole("option", { name: "close_focus" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "quality_group" })).not.toBeInTheDocument();
});
```

Adjust the render call and the category-select query to whatever the file already uses.

- [ ] **Step 7: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/features/annotation/SequenceGridToolbar.test.tsx`
Expected: FAIL — `quality_group` is still offered.

- [ ] **Step 8: Filter abstract labels in `SequenceGridToolbar`**

In `frontend/src/features/annotation/SequenceGridToolbar.tsx`, inside the `classificationCategories` `useMemo`, filter the labels:

```tsx
          return {
            category: node.category,
            evaluationTypeId: evaluationTypeNode?.evaluation_type.id ?? null,
            labels: (evaluationTypeNode?.labels ?? []).filter((label) => !label.is_abstract),
          };
```

The existing `.filter((entry) => entry.labels.length > 0)` below then correctly drops a category whose only labels were abstract.

- [ ] **Step 9: Run the frontend suite**

Run: `cd frontend && npm test`
Expected: PASS across the suite.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/features/annotation/
git commit -m "feat: hide abstract labels from annotation pickers"
```

---

### Task 7: Show and edit a label's parent on the Tags screen

**Files:**
- Modify: `frontend/src/features/tags/TagForm.tsx`
- Test: `frontend/src/features/tags/TagForm.test.tsx` (append)

**Interfaces:**
- Consumes: `PATCH`/`POST /taxonomy/labels` accepting `parent_label_id` and `is_abstract` (Task 3).
- Produces: no new exports — the form gains a "Parent tag" select and an "Abstract" checkbox.

**Deliberate scope limit:** Tags gets *viewing and editing* of structure. It does **not** host the grouping decision — choosing what to collapse belongs next to the live balance panel on the Dataset screen, because the whole point is watching class balance while choosing. Editing hierarchy blind on Tags is what this design avoids.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/features/tags/TagForm.test.tsx`, matching the file's existing render helper, mocks and fixture shape:

```tsx
it("submits the selected parent tag and abstract flag", async () => {
  renderForm({
    editingLabel: {
      id: 51,
      name: "sessile_polyp_0_Is",
      color: "#00FF00",
      category_id: 1,
      evaluation_type_id: 10,
      taxonomy_version: 1,
      parent_label_id: null,
      is_abstract: false,
    },
  });

  await userEvent.selectOptions(screen.getByLabelText(/parent tag/i), "50");
  await userEvent.click(screen.getByLabelText(/abstract/i));
  await userEvent.click(screen.getByRole("button", { name: /save/i }));

  expect(apiClient.PATCH).toHaveBeenCalledWith(
    "/taxonomy/labels/{label_id}",
    expect.objectContaining({
      body: expect.objectContaining({ parent_label_id: 50, is_abstract: true }),
    }),
  );
});

it("offers only same-category tags as parent candidates", async () => {
  renderForm({
    editingLabel: {
      id: 51,
      name: "sessile_polyp_0_Is",
      color: "#00FF00",
      category_id: 1,
      evaluation_type_id: 10,
      taxonomy_version: 1,
      parent_label_id: null,
      is_abstract: false,
    },
  });

  // A label cannot parent itself, and a cross-procedure parent is rejected by
  // the backend with 422 -- so do not offer either.
  expect(screen.queryByRole("option", { name: "sessile_polyp_0_Is" })).not.toBeInTheDocument();
});
```

Read the existing test file first and reuse its `renderForm` helper, its `apiClient` mock and the exact PATCH path string it already asserts on; the names above are placeholders for whatever that file establishes.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/features/tags/TagForm.test.tsx`
Expected: FAIL — no "Parent tag" control exists.

- [ ] **Step 3: Add the controls to `TagForm`**

Add two pieces of state alongside the existing `categoryId`/`evaluationTypeId` state:

```tsx
  const [parentLabelId, setParentLabelId] = useState<string>(
    editingLabel?.parent_label_id != null ? String(editingLabel.parent_label_id) : "",
  );
  const [isAbstract, setIsAbstract] = useState<boolean>(editingLabel?.is_abstract ?? false);
```

Compute the candidate parents from the labels already available to the form, excluding the label being edited (a label cannot be its own parent) and restricting to the same category, which keeps candidates inside one procedure and one evaluation type — matching the backend's invariants so the user is never offered a choice the API will reject with 422:

```tsx
  const parentCandidates = (labelsInSelectedCategory ?? []).filter(
    (candidate) => candidate.id !== editingLabel?.id,
  );
```

Use whatever the file already calls its in-category label list; if it does not have one, derive it from the same taxonomy tree data the category select already uses.

Render the two controls next to the existing selects, matching their Tailwind classes exactly (dark theme only — copy the classes from a neighbouring `<select>`):

```tsx
      <label className="block text-xs text-gray-400">
        Parent tag
        <select
          className={SELECT_CLASSES}
          value={parentLabelId}
          onChange={(event) => setParentLabelId(event.target.value)}
        >
          <option value="">None</option>
          {parentCandidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-2 text-xs text-gray-400">
        <input
          type="checkbox"
          checked={isAbstract}
          onChange={(event) => setIsAbstract(event.target.checked)}
        />
        Abstract (grouping only, not annotatable)
      </label>
```

If `SELECT_CLASSES` is not already defined in this file, copy the literal class string from the neighbouring select instead of introducing a new constant.

Include both fields in the submit body alongside the existing ones:

```tsx
      parent_label_id: parentLabelId === "" ? null : Number(parentLabelId),
      is_abstract: isAbstract,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/features/tags/TagForm.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the frontend suite and typecheck**

```bash
cd frontend && npm test && npm run build
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/tags/
git commit -m "feat: edit a tag's parent and abstract flag on the Tags screen"
```

---

### Task 8: Real-browser verification and ROADMAP entry

**Files:**
- Modify: `ROADMAP.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing executable — a verification pass and the phase log entry.

Frontend unit tests mock `apiClient` wholesale and cannot observe that an abstract label still renders in a real picker against real data. This repository has already paid for that lesson three times (ROADMAP.md's Phase 1 deviation log: missing CORS middleware, auth state not persisting, a fresh clone failing to build).

- [ ] **Step 1: Start the full stack**

```bash
docker compose up -d
cd backend && uv run uvicorn app.main:app --reload   # :8000
cd frontend && npm run dev                            # :5173
```

- [ ] **Step 2: Verify the quality labels moved, in the real UI**

Log in as `manualcheck@example.com`. Open a sequence grid, enter Select mode, and open the "Category…" dropdown:
- `close_focus`, `dirty_optic` and `bad_picture` now appear as frame-level classification options under Quality.
- Open the frame editor's `CascadingLabelPicker` for the same procedure: those three no longer appear there.

- [ ] **Step 3: Verify the abstract flag end-to-end**

On the Tags screen, pick a Findings tag, set its Parent tag, save, and confirm the value survives a page reload. Then mark some label Abstract and confirm it disappears from both pickers — and that clearing the flag brings it back.

- [ ] **Step 4: Verify an invalid parent is refused**

Attempt (via the API directly, since the UI does not offer the choice) to set a cross-procedure parent:

```bash
curl -X PATCH http://localhost:8000/taxonomy/labels/<colono_label_id> \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"parent_label_id": <egds_label_id>}'
```

Expected: HTTP 422 with the "same procedure" message, not a 500 and not a silent success.

- [ ] **Step 5: Run both suites once more**

```bash
cd backend && uv run pytest -q
cd frontend && npm test
```

Expected: both green. Report actual output — if anything fails, say so rather than summarizing as passing.

- [ ] **Step 6: Add the ROADMAP entry**

Under Phase 2b in `ROADMAP.md`, replace the "now RESOLVED by … (approved 2026-08-15, not yet implemented)" wording with an entry recording what actually shipped: the two columns, the three invariants, `resolve_class`, the quality migration, the picker filtering and the Tags parent editor — plus anything that deviated from this plan during execution, in the deviation-log style the rest of the file uses.

- [ ] **Step 7: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: record label hierarchy implementation in ROADMAP"
```

---

## Deferred to the Dataset screen (not this plan)

Recorded so the boundary is explicit and nobody implements half of it here:

- `Dataset` / `DatasetItem` models, and `Dataset.grouping_overrides` (JSONB, `{"collapse": [label_id], "expand": [label_id]}`, empty meaning "as in the taxonomy").
- The live class-balance panel with per-group collapse toggles, computing its bars through `resolve_class` so the panel and the export can never disagree.
- Under-representation warnings computed over *resolved* classes rather than raw labels.
- Export writing the resolved class map — class names, their constituent `label_id`s and the `taxonomy_version` — into `data.yaml` and `balance_metrics`. No extra primitive is needed for this: mapping `resolve_class` over every label in the tree and grouping by the result yields the class map directly. It is deliberately not built here, because nothing would consume it yet.

## Known wrinkle, not fixed here

`test-polyp-label` exists in fifteen copies under `Findings` / `geometric` in the dev database, left by earlier test runs. They will clutter Task 7's parent-candidate dropdown. They are dev debris rather than taxonomy structure; cleaning them is out of scope, and deleting anything from the `endoscopy` database requires the user's explicit go-ahead.
