# Taxonomy Category/EvaluationType Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current `Label`/`LabelRelation` taxonomy model (where "category" is just any root label with no structural distinction from a real tag) with a fixed 4-level hierarchy — `Procedure → Category → EvaluationType → Tag` — matching [docs/superpowers/specs/2026-07-28-taxonomy-category-evaluation-type-design.md](../specs/2026-07-28-taxonomy-category-evaluation-type-design.md).

**Architecture:** `Category` (per-procedure) and `EvaluationType` (global) become first-class SQLAlchemy models with their own CRUD routes, replacing the recursive `LabelRelation` parent/child mechanism entirely. `Label` gets `category_id`/`evaluation_type_id` FKs instead of an enum `label_type` column. The frontend's `CascadingLabelPicker` keeps its existing 3-select UI shape but reads the new `/taxonomy/tree?procedure_id=...` response instead of deriving categories/classifications from a flat parent-child list.

**Tech Stack:** FastAPI, SQLAlchemy 2.0 (Mapped/mapped_column), Alembic, pytest + TestClient, React 19, TanStack Query, Zustand, Vitest + Testing Library.

## Global Constraints

- **Language:** English only in all code, comments, docstrings, UI copy (CLAUDE.md).
- **TDD:** every backend and frontend task with logic gets a failing test before the implementation (CLAUDE.md).
- **`taxonomy_version`:** any data referencing a `Label` must carry the `taxonomy_version` that `Label` had at creation time — copy it, never hardcode or re-derive it later (CLAUDE.md). This plan does not change that invariant; `Label.taxonomy_version` and its snapshot into `Annotation.taxonomy_version` in `backend/app/annotation/service.py` are untouched.
- **API contract:** never hand-roll an untyped `fetch()` — use `apiClient` from `frontend/src/shared/api/client.ts`, and regenerate `frontend/src/shared/api/generated/schema.d.ts` from the backend's `openapi.json` (via `npm run generate-api`, which `predev`/`prebuild`/`pretest` already run automatically) after backend routes change.
- **UI theme:** dark only, Tailwind `class` strategy — no light-background classes (CLAUDE.md). This plan doesn't add new screens, only adapts data flowing into `CascadingLabelPicker`'s existing markup.

---

## File Structure

- Modify `backend/app/taxonomy/models.py` — remove `LabelType` enum and `LabelRelation`; add `Category`, `EvaluationType`; change `Label.label_type` to `category_id`/`evaluation_type_id` FKs.
- Modify `backend/app/taxonomy/schemas.py` — remove `LabelRelationCreate`, `LabelTreeNode`; add `CategoryCreate/Read/Update`, `EvaluationTypeCreate/Read/Update`; change `LabelCreate/Read`; add `TaxonomyTreeNode` (the new tree shape).
- Modify `backend/app/taxonomy/service.py` — remove `get_label_descendants`, `get_label_tree`; add `get_taxonomy_tree(session, procedure_id)`.
- Modify `backend/app/taxonomy/router.py` — remove label-relation/descendants/tree routes; add categories/evaluation-types CRUD; add `/taxonomy/tree`.
- Create `backend/alembic/versions/<hash>_taxonomy_category_evaluation_type.py` — the schema migration.
- Rewrite `backend/app/taxonomy/import_taxonomy.py` — import against the new schema.
- Modify `backend/app/media/router.py` — add `GET /media/sequences/{sequence_id}` (needed by the frontend to resolve a frame's `procedure_id`; doesn't exist today).
- Modify `backend/app/media/schemas.py` — no new schema needed, `SequenceRead` already has every field the new endpoint returns.
- Rewrite `backend/tests/test_taxonomy.py` — drop relation/descendants/tree tests, add category/evaluation-type/tree tests.
- Modify `backend/tests/test_media.py` — add a test for the new single-sequence GET.
- Modify `backend/tests/test_import_taxonomy.py` — rewrite for the new `import_taxonomy` signature/behavior.
- Create `frontend/src/entities/useSequence.ts` — new hook, mirrors `useFrame` in `useFrames.ts`.
- Create `frontend/src/entities/useTaxonomyTree.ts` — replaces `useLabelTree.ts` (deleted).
- Modify `frontend/src/features/annotation/labelColors.ts` — `buildLabelColorMap` reads the new tree shape (`category → evaluation_types[] → labels[]`) instead of `category → children[]`.
- Modify `frontend/src/features/annotation/CascadingLabelPicker.tsx` — read the new tree shape; add a `procedureId` prop.
- Modify `frontend/src/features/annotation/ToolsPanel.tsx` — thread `procedureId` prop through to `CascadingLabelPicker`.
- Modify `frontend/src/features/annotation/FrameEditor.tsx` — replace its existing (already-present, from yesterday's mask-coloring work) `useLabelTree()` call with `useSequence` + `useTaxonomyTree`, so `labelColorById` and `CascadingLabelPicker` read the same per-procedure tree instead of two separate, differently-shaped queries.
- Create `frontend/tests/useTaxonomyTree.test.ts`, `frontend/tests/CascadingLabelPicker.test.tsx` (new, since none exists for this component today — confirmed by search).
- Modify `frontend/tests/labelColors.test.ts` — update fixtures to the new tree shape.

---

### Task 1: `Category` and `EvaluationType` models replace `LabelType`/`LabelRelation`

**Files:**
- Modify: `backend/app/taxonomy/models.py`
- Create: `backend/alembic/versions/<hash>_taxonomy_category_evaluation_type.py`

**Interfaces:**
- Produces: `Category(id, name, procedure_id)`, `EvaluationType(id, name)`, `Label(id, name, color, category_id, evaluation_type_id, taxonomy_version, created_at)` — consumed by every later backend task.

- [ ] **Step 1: Rewrite `backend/app/taxonomy/models.py`**

```python
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Procedure(Base):
    __tablename__ = "procedures"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)


class Category(Base):
    __tablename__ = "categories"
    __table_args__ = (UniqueConstraint("name", "procedure_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    procedure_id: Mapped[int] = mapped_column(ForeignKey("procedures.id"))


class EvaluationType(Base):
    __tablename__ = "evaluation_types"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)


class Label(Base):
    __tablename__ = "labels"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    color: Mapped[str] = mapped_column(String(7), default="#FFFFFF")
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id"))
    evaluation_type_id: Mapped[int] = mapped_column(ForeignKey("evaluation_types.id"))
    taxonomy_version: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
```

- [ ] **Step 2: Generate the Alembic migration**

Run: `cd backend && uv run alembic revision --autogenerate -m "taxonomy category evaluation type"`

This creates a new file under `backend/alembic/versions/`. Autogenerate will produce `create_table` for `categories`/`evaluation_types`, `add_column`/`drop_column` for `labels`, a `drop_table` for `label_relations`, and a mention of dropping the `labeltype` Postgres enum. Autogenerate does NOT reliably detect enum-type drops or column-type-narrowing constraints (adding a NOT NULL FK to a table it doesn't know is empty) — the generated file needs manual adjustment in the next step. Find the new file (its name starts with a fresh Alembic hash) before continuing.

- [ ] **Step 3: Adjust the generated migration to guarantee data-loss safety and column ordering**

Open the newly generated file. Its `upgrade()` must do, in this exact order (adjust the autogenerated body to match if it differs — table/column creation order matters because of FK dependencies):

```python
def upgrade() -> None:
    op.create_table(
        "evaluation_types",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_table(
        "categories",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("procedure_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["procedure_id"], ["procedures.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name", "procedure_id"),
    )
    # labels/label_relations are wiped before this migration runs (see Task 2's
    # accompanying manual step) -- safe to add NOT NULL FK columns directly,
    # no backfill needed.
    op.execute("TRUNCATE labels, label_relations, annotations CASCADE")
    op.drop_table("label_relations")
    op.add_column("labels", sa.Column("category_id", sa.Integer(), nullable=False))
    op.add_column("labels", sa.Column("evaluation_type_id", sa.Integer(), nullable=False))
    op.create_foreign_key(None, "labels", "categories", ["category_id"], ["id"])
    op.create_foreign_key(None, "labels", "evaluation_types", ["evaluation_type_id"], ["id"])
    op.drop_column("labels", "label_type")
    op.execute("DROP TYPE labeltype")


def downgrade() -> None:
    op.add_column(
        "labels",
        sa.Column(
            "label_type",
            sa.Enum("GEOMETRIC", "MORPHOLOGICAL", "QUALITY", name="labeltype"),
            nullable=True,
        ),
    )
    op.drop_column("labels", "evaluation_type_id")
    op.drop_column("labels", "category_id")
    op.create_table(
        "label_relations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("parent_id", sa.Integer(), nullable=False),
        sa.Column("child_id", sa.Integer(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.ForeignKeyConstraint(["child_id"], ["labels.id"]),
        sa.ForeignKeyConstraint(["parent_id"], ["labels.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.drop_table("categories")
    op.drop_table("evaluation_types")
```

The `TRUNCATE ... CASCADE` line is intentional and matches the user's explicit decision to wipe today's test taxonomy/annotation data rather than migrate it (see the spec's "Migration and data plan" section) — this is the one place in the codebase that statement is safe to hardcode, since it's a one-time schema migration, not a repeatable test-cleanup command. Do NOT run any manual `TRUNCATE` outside this migration — running one against the dev DB by hand was exactly the mistake made earlier in this session.

- [ ] **Step 4: Apply the migration**

Run: `cd backend && uv run alembic upgrade head`
Expected: migration applies with no errors; `\d labels` in psql shows `category_id`, `evaluation_type_id` columns and no `label_type` column.

- [ ] **Step 5: Commit**

```bash
git add backend/app/taxonomy/models.py backend/alembic/versions/
git commit -m "feat: replace Label.label_type/LabelRelation with Category/EvaluationType models"
```

---

### Task 2: Taxonomy schemas and service layer

**Files:**
- Modify: `backend/app/taxonomy/schemas.py`
- Modify: `backend/app/taxonomy/service.py`
- Test: `backend/tests/test_taxonomy.py` (rewritten in Task 3, not this task — this task only needs the service function importable; its behavior is exercised end-to-end through the router tests in Task 3, since `get_taxonomy_tree` has no independent unit test file today and CLAUDE.md's TDD note doesn't require inventing one where the existing pattern tests services through their routes)

**Interfaces:**
- Consumes: `Category`, `EvaluationType`, `Label` from Task 1.
- Produces: `CategoryCreate`, `CategoryRead`, `CategoryUpdate`, `EvaluationTypeCreate`, `EvaluationTypeRead`, `EvaluationTypeUpdate`, `LabelCreate`, `LabelRead`, `TaxonomyTreeNode` (Pydantic schemas); `get_taxonomy_tree(session: Session, procedure_id: int) -> list[dict]` (service function) — consumed by Task 3's router.

- [ ] **Step 1: Rewrite `backend/app/taxonomy/schemas.py`**

```python
from pydantic import BaseModel, ConfigDict


class ProcedureCreate(BaseModel):
    name: str


class ProcedureRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str


class CategoryCreate(BaseModel):
    name: str
    procedure_id: int


class CategoryUpdate(BaseModel):
    name: str | None = None


class CategoryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    procedure_id: int


class EvaluationTypeCreate(BaseModel):
    name: str


class EvaluationTypeUpdate(BaseModel):
    name: str | None = None


class EvaluationTypeRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str


class LabelCreate(BaseModel):
    name: str
    color: str = "#FFFFFF"
    category_id: int
    evaluation_type_id: int


class LabelUpdate(BaseModel):
    name: str | None = None
    color: str | None = None
    category_id: int | None = None
    evaluation_type_id: int | None = None


class LabelRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    color: str
    category_id: int
    evaluation_type_id: int
    taxonomy_version: int


class TaxonomyTreeEvaluationTypeNode(BaseModel):
    evaluation_type: EvaluationTypeRead
    labels: list[LabelRead]


class TaxonomyTreeNode(BaseModel):
    category: CategoryRead
    evaluation_types: list[TaxonomyTreeEvaluationTypeNode]
```

- [ ] **Step 2: Rewrite `backend/app/taxonomy/service.py`**

```python
from sqlalchemy.orm import Session

from app.taxonomy.models import Category, EvaluationType, Label


def get_taxonomy_tree(session: Session, procedure_id: int) -> list[dict]:
    categories = (
        session.query(Category)
        .filter(Category.procedure_id == procedure_id)
        .order_by(Category.name)
        .all()
    )
    all_evaluation_types = session.query(EvaluationType).order_by(EvaluationType.name).all()
    category_ids = [c.id for c in categories]
    labels = (
        session.query(Label).filter(Label.category_id.in_(category_ids)).all()
        if category_ids
        else []
    )
    labels_by_category_and_type: dict[tuple[int, int], list[Label]] = {}
    for label in labels:
        key = (label.category_id, label.evaluation_type_id)
        labels_by_category_and_type.setdefault(key, []).append(label)

    tree = []
    for category in categories:
        evaluation_type_nodes = []
        for evaluation_type in all_evaluation_types:
            matching = labels_by_category_and_type.get((category.id, evaluation_type.id), [])
            if not matching:
                continue
            evaluation_type_nodes.append(
                {"evaluation_type": evaluation_type, "labels": matching}
            )
        tree.append({"category": category, "evaluation_types": evaluation_type_nodes})
    return tree
```

Note: an `EvaluationType` with no labels under a given `Category` is omitted from that category's `evaluation_types` list (mirrors the spec's `/taxonomy/tree` example, where each category only lists the evaluation types it actually has tagged labels under).

- [ ] **Step 3: Commit**

```bash
git add backend/app/taxonomy/schemas.py backend/app/taxonomy/service.py
git commit -m "feat: add Category/EvaluationType schemas and get_taxonomy_tree service"
```

---

### Task 3: Taxonomy router — categories, evaluation types, labels, tree

**Files:**
- Modify: `backend/app/taxonomy/router.py`
- Rewrite: `backend/tests/test_taxonomy.py`

**Interfaces:**
- Consumes: everything from Task 2.
- Produces: `POST/GET /taxonomy/categories`, `PATCH/DELETE /taxonomy/categories/{id}`, `POST/GET /taxonomy/evaluation-types`, `PATCH/DELETE /taxonomy/evaluation-types/{id}`, `POST/GET/PATCH/DELETE /taxonomy/labels(/{id})`, `GET /taxonomy/tree?procedure_id=...` — consumed by Task 5's `import_taxonomy` rewrite and Task 7's frontend hook.

- [ ] **Step 1: Write the failing tests**

Replace `backend/tests/test_taxonomy.py` entirely with:

```python
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _register_and_login(email: str) -> str:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "admin"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return response.json()["access_token"]


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_create_procedure_and_list_it():
    token = _auth_headers(_register_and_login("tax1@example.com"))

    create_response = client.post("/taxonomy/procedures", json={"name": "tax1-gastroscopy"}, headers=token)
    assert create_response.status_code == 201

    list_response = client.get("/taxonomy/procedures", headers=token)
    assert list_response.status_code == 200
    names = [p["name"] for p in list_response.json()]
    assert "tax1-gastroscopy" in names


def test_create_category_requires_auth():
    response = client.post("/taxonomy/categories", json={"name": "Anatomy", "procedure_id": 1})
    assert response.status_code == 401


def test_create_and_list_categories_for_a_procedure():
    token = _auth_headers(_register_and_login("tax2@example.com"))
    procedure = client.post("/taxonomy/procedures", json={"name": "tax2-colono"}, headers=token).json()

    create_response = client.post(
        "/taxonomy/categories", json={"name": "Anatomy", "procedure_id": procedure["id"]}, headers=token
    )
    assert create_response.status_code == 201
    body = create_response.json()
    assert body["name"] == "Anatomy"
    assert body["procedure_id"] == procedure["id"]

    list_response = client.get(f"/taxonomy/categories?procedure_id={procedure['id']}", headers=token)
    assert list_response.status_code == 200
    assert any(c["name"] == "Anatomy" for c in list_response.json())


def test_update_and_delete_category():
    token = _auth_headers(_register_and_login("tax3@example.com"))
    procedure = client.post("/taxonomy/procedures", json={"name": "tax3-colono"}, headers=token).json()
    category = client.post(
        "/taxonomy/categories", json={"name": "Findings", "procedure_id": procedure["id"]}, headers=token
    ).json()

    update_response = client.patch(
        f"/taxonomy/categories/{category['id']}", json={"name": "Findings renamed"}, headers=token
    )
    assert update_response.status_code == 200
    assert update_response.json()["name"] == "Findings renamed"

    delete_response = client.delete(f"/taxonomy/categories/{category['id']}", headers=token)
    assert delete_response.status_code == 204


def test_delete_category_with_labels_returns_409():
    token = _auth_headers(_register_and_login("tax4@example.com"))
    procedure = client.post("/taxonomy/procedures", json={"name": "tax4-colono"}, headers=token).json()
    category = client.post(
        "/taxonomy/categories", json={"name": "Anatomy", "procedure_id": procedure["id"]}, headers=token
    ).json()
    evaluation_type = client.post(
        "/taxonomy/evaluation-types", json={"name": "tax4-geometric"}, headers=token
    ).json()
    client.post(
        "/taxonomy/labels",
        json={
            "name": "pharynx",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=token,
    )

    delete_response = client.delete(f"/taxonomy/categories/{category['id']}", headers=token)
    assert delete_response.status_code == 409


def test_create_and_list_evaluation_types():
    token = _auth_headers(_register_and_login("tax5@example.com"))

    create_response = client.post("/taxonomy/evaluation-types", json={"name": "tax5-geometric"}, headers=token)
    assert create_response.status_code == 201

    list_response = client.get("/taxonomy/evaluation-types", headers=token)
    assert list_response.status_code == 200
    assert any(e["name"] == "tax5-geometric" for e in list_response.json())


def test_delete_evaluation_type_with_labels_returns_409():
    token = _auth_headers(_register_and_login("tax6@example.com"))
    procedure = client.post("/taxonomy/procedures", json={"name": "tax6-colono"}, headers=token).json()
    category = client.post(
        "/taxonomy/categories", json={"name": "Anatomy", "procedure_id": procedure["id"]}, headers=token
    ).json()
    evaluation_type = client.post(
        "/taxonomy/evaluation-types", json={"name": "tax6-geometric"}, headers=token
    ).json()
    client.post(
        "/taxonomy/labels",
        json={
            "name": "pharynx",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=token,
    )

    delete_response = client.delete(f"/taxonomy/evaluation-types/{evaluation_type['id']}", headers=token)
    assert delete_response.status_code == 409


def test_create_and_list_labels():
    token = _auth_headers(_register_and_login("tax7@example.com"))
    procedure = client.post("/taxonomy/procedures", json={"name": "tax7-colono"}, headers=token).json()
    category = client.post(
        "/taxonomy/categories", json={"name": "Anatomy", "procedure_id": procedure["id"]}, headers=token
    ).json()
    evaluation_type = client.post(
        "/taxonomy/evaluation-types", json={"name": "tax7-geometric"}, headers=token
    ).json()

    response = client.post(
        "/taxonomy/labels",
        json={
            "name": "pharynx",
            "color": "#FF0000",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=token,
    )
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "pharynx"
    assert body["taxonomy_version"] == 1

    list_response = client.get(f"/taxonomy/labels?category_id={category['id']}", headers=token)
    assert any(label["name"] == "pharynx" for label in list_response.json())


def test_taxonomy_tree_groups_labels_by_category_and_evaluation_type():
    token = _auth_headers(_register_and_login("tax8@example.com"))
    procedure = client.post("/taxonomy/procedures", json={"name": "tax8-colono"}, headers=token).json()
    anatomy = client.post(
        "/taxonomy/categories", json={"name": "Anatomy", "procedure_id": procedure["id"]}, headers=token
    ).json()
    findings = client.post(
        "/taxonomy/categories", json={"name": "Findings", "procedure_id": procedure["id"]}, headers=token
    ).json()
    geometric = client.post(
        "/taxonomy/evaluation-types", json={"name": "tax8-geometric"}, headers=token
    ).json()
    morphological = client.post(
        "/taxonomy/evaluation-types", json={"name": "tax8-morphological"}, headers=token
    ).json()

    client.post(
        "/taxonomy/labels",
        json={"name": "pharynx", "category_id": anatomy["id"], "evaluation_type_id": geometric["id"]},
        headers=token,
    )
    client.post(
        "/taxonomy/labels",
        json={"name": "colon_adenoma", "category_id": findings["id"], "evaluation_type_id": morphological["id"]},
        headers=token,
    )

    response = client.get(f"/taxonomy/tree?procedure_id={procedure['id']}", headers=token)

    assert response.status_code == 200
    tree = response.json()
    assert len(tree) == 2

    anatomy_node = next(node for node in tree if node["category"]["id"] == anatomy["id"])
    assert len(anatomy_node["evaluation_types"]) == 1
    assert anatomy_node["evaluation_types"][0]["evaluation_type"]["id"] == geometric["id"]
    assert [label["name"] for label in anatomy_node["evaluation_types"][0]["labels"]] == ["pharynx"]

    findings_node = next(node for node in tree if node["category"]["id"] == findings["id"])
    assert findings_node["evaluation_types"][0]["evaluation_type"]["id"] == morphological["id"]


def test_taxonomy_tree_only_returns_categories_for_the_given_procedure():
    token = _auth_headers(_register_and_login("tax9@example.com"))
    procedure_a = client.post("/taxonomy/procedures", json={"name": "tax9-colono"}, headers=token).json()
    procedure_b = client.post("/taxonomy/procedures", json={"name": "tax9-egds"}, headers=token).json()
    client.post(
        "/taxonomy/categories", json={"name": "Anatomy", "procedure_id": procedure_a["id"]}, headers=token
    )
    client.post(
        "/taxonomy/categories", json={"name": "Anatomy", "procedure_id": procedure_b["id"]}, headers=token
    )

    response = client.get(f"/taxonomy/tree?procedure_id={procedure_a['id']}", headers=token)

    assert response.status_code == 200
    assert len(response.json()) == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_taxonomy.py -v`
Expected: FAIL — `/taxonomy/categories`, `/taxonomy/evaluation-types`, `/taxonomy/tree` routes don't exist yet (404s), and `test_create_procedure_and_list_it`/existing procedure tests may still pass since `Procedure` is unchanged.

- [ ] **Step 3: Rewrite `backend/app/taxonomy/router.py`**

```python
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.db import get_session
from app.taxonomy.models import Category, EvaluationType, Label, Procedure
from app.taxonomy.schemas import (
    CategoryCreate,
    CategoryRead,
    CategoryUpdate,
    EvaluationTypeCreate,
    EvaluationTypeRead,
    EvaluationTypeUpdate,
    LabelCreate,
    LabelRead,
    LabelUpdate,
    ProcedureCreate,
    ProcedureRead,
    TaxonomyTreeNode,
)
from app.taxonomy.service import get_taxonomy_tree

router = APIRouter(prefix="/taxonomy", tags=["taxonomy"], dependencies=[Depends(get_current_user)])


@router.post("/procedures", response_model=ProcedureRead, status_code=status.HTTP_201_CREATED)
def create_procedure(payload: ProcedureCreate, session: Session = Depends(get_session)) -> Procedure:
    procedure = Procedure(name=payload.name)
    session.add(procedure)
    session.commit()
    session.refresh(procedure)
    return procedure


@router.get("/procedures", response_model=list[ProcedureRead])
def list_procedures(session: Session = Depends(get_session)) -> list[Procedure]:
    return session.query(Procedure).all()


@router.post("/categories", response_model=CategoryRead, status_code=status.HTTP_201_CREATED)
def create_category(payload: CategoryCreate, session: Session = Depends(get_session)) -> Category:
    category = Category(**payload.model_dump())
    session.add(category)
    session.commit()
    session.refresh(category)
    return category


@router.get("/categories", response_model=list[CategoryRead])
def list_categories(procedure_id: int | None = None, session: Session = Depends(get_session)) -> list[Category]:
    query = session.query(Category)
    if procedure_id is not None:
        query = query.filter(Category.procedure_id == procedure_id)
    return query.all()


@router.patch("/categories/{category_id}", response_model=CategoryRead)
def update_category(
    category_id: int, payload: CategoryUpdate, session: Session = Depends(get_session)
) -> Category:
    category = session.get(Category, category_id)
    if category is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(category, field, value)
    session.commit()
    session.refresh(category)
    return category


@router.delete("/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_category(category_id: int, session: Session = Depends(get_session)) -> None:
    category = session.get(Category, category_id)
    if category is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    session.delete(category)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Category still has labels referencing it"
        ) from None


@router.post("/evaluation-types", response_model=EvaluationTypeRead, status_code=status.HTTP_201_CREATED)
def create_evaluation_type(
    payload: EvaluationTypeCreate, session: Session = Depends(get_session)
) -> EvaluationType:
    evaluation_type = EvaluationType(**payload.model_dump())
    session.add(evaluation_type)
    session.commit()
    session.refresh(evaluation_type)
    return evaluation_type


@router.get("/evaluation-types", response_model=list[EvaluationTypeRead])
def list_evaluation_types(session: Session = Depends(get_session)) -> list[EvaluationType]:
    return session.query(EvaluationType).all()


@router.patch("/evaluation-types/{evaluation_type_id}", response_model=EvaluationTypeRead)
def update_evaluation_type(
    evaluation_type_id: int, payload: EvaluationTypeUpdate, session: Session = Depends(get_session)
) -> EvaluationType:
    evaluation_type = session.get(EvaluationType, evaluation_type_id)
    if evaluation_type is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evaluation type not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(evaluation_type, field, value)
    session.commit()
    session.refresh(evaluation_type)
    return evaluation_type


@router.delete("/evaluation-types/{evaluation_type_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_evaluation_type(evaluation_type_id: int, session: Session = Depends(get_session)) -> None:
    evaluation_type = session.get(EvaluationType, evaluation_type_id)
    if evaluation_type is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evaluation type not found")
    session.delete(evaluation_type)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Evaluation type still has labels referencing it"
        ) from None


@router.post("/labels", response_model=LabelRead, status_code=status.HTTP_201_CREATED)
def create_label(payload: LabelCreate, session: Session = Depends(get_session)) -> Label:
    label = Label(**payload.model_dump())
    session.add(label)
    session.commit()
    session.refresh(label)
    return label


@router.get("/labels", response_model=list[LabelRead])
def list_labels(
    category_id: int | None = None,
    evaluation_type_id: int | None = None,
    session: Session = Depends(get_session),
) -> list[Label]:
    query = session.query(Label)
    if category_id is not None:
        query = query.filter(Label.category_id == category_id)
    if evaluation_type_id is not None:
        query = query.filter(Label.evaluation_type_id == evaluation_type_id)
    return query.all()


@router.patch("/labels/{label_id}", response_model=LabelRead)
def update_label(label_id: int, payload: LabelUpdate, session: Session = Depends(get_session)) -> Label:
    label = session.get(Label, label_id)
    if label is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Label not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(label, field, value)
    session.commit()
    session.refresh(label)
    return label


@router.delete("/labels/{label_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_label(label_id: int, session: Session = Depends(get_session)) -> None:
    label = session.get(Label, label_id)
    if label is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Label not found")
    session.delete(label)
    session.commit()


@router.get("/tree", response_model=list[TaxonomyTreeNode])
def taxonomy_tree(procedure_id: int, session: Session = Depends(get_session)) -> list[dict]:
    return get_taxonomy_tree(session, procedure_id)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_taxonomy.py -v`
Expected: PASS (11 tests)

- [ ] **Step 5: Regenerate the OpenAPI schema**

Run: `cd backend && uv run python scripts/export_openapi.py`
Expected: `openapi.json` at repo root is rewritten with the new taxonomy routes/schemas and without the removed label-relations/descendants/labels-tree routes.

- [ ] **Step 6: Commit**

```bash
git add backend/app/taxonomy/router.py backend/tests/test_taxonomy.py openapi.json
git commit -m "feat: add Category/EvaluationType CRUD routes and /taxonomy/tree endpoint"
```

---

### Task 4: `GET /media/sequences/{sequence_id}` endpoint

**Files:**
- Modify: `backend/app/media/router.py`
- Modify: `backend/tests/test_media.py`

**Interfaces:**
- Produces: `GET /media/sequences/{sequence_id}` returning `SequenceRead` — consumed by Task 7's `useSequence` frontend hook.

**Context:** No single-sequence GET exists today — only `POST /media/sequences` (create), `GET /videos/{video_id}/sequences`, `GET /procedures/{procedure_id}/sequences`. The frontend needs to resolve a frame's `procedure_id` (via its `sequence_id`) to fetch the right taxonomy tree, and there's currently no way to fetch one `Sequence` by id.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_media.py` (append at the end of the file):

```python
def test_get_sequence_by_id():
    headers = _auth_headers()
    procedure_response = client.post("/taxonomy/procedures", json={"name": "media-seq-test"}, headers=headers)
    procedure_id = procedure_response.json()["id"]

    create_response = client.post(
        "/media/sequences", json={"procedure_id": procedure_id}, headers=headers
    )
    sequence_id = create_response.json()["id"]

    response = client.get(f"/media/sequences/{sequence_id}", headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == sequence_id
    assert body["procedure_id"] == procedure_id


def test_get_sequence_404_for_missing_sequence():
    headers = _auth_headers()
    response = client.get("/media/sequences/999999999", headers=headers)
    assert response.status_code == 404
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_media.py::test_get_sequence_by_id -v`
Expected: FAIL — 404 or 405, route doesn't exist yet (FastAPI's route ordering means `/sequences/{sequence_id}` could also collide with `/sequences/{sequence_id}/frames` if added carelessly; adding it as a sibling route in the next step avoids that since FastAPI matches the more specific path first).

- [ ] **Step 3: Add the route**

In `backend/app/media/router.py`, add this route near `get_frame` (after `list_frames`, before `list_sequences_for_video` — exact position doesn't matter for FastAPI's routing, only readability):

```python
@router.get("/sequences/{sequence_id}", response_model=SequenceRead)
def get_sequence(sequence_id: int, session: Session = Depends(get_session)) -> Sequence:
    sequence = session.get(Sequence, sequence_id)
    if sequence is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sequence not found")
    return sequence
```

Confirm `Sequence` is already imported at the top of the file (it is — used by `create_sequence`/`create_standalone_sequence`); confirm `SequenceRead` is already imported too (it is, used as `response_model` elsewhere in the file).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_media.py -v`
Expected: PASS (all tests, including the 2 new ones)

- [ ] **Step 5: Regenerate the OpenAPI schema**

Run: `cd backend && uv run python scripts/export_openapi.py`

- [ ] **Step 6: Commit**

```bash
git add backend/app/media/router.py backend/tests/test_media.py openapi.json
git commit -m "feat: add GET /media/sequences/{sequence_id} endpoint"
```

---

### Task 5: Rewrite `import_taxonomy` for the new schema

**Files:**
- Modify: `backend/app/taxonomy/import_taxonomy.py`
- Modify: `backend/tests/test_import_taxonomy.py`

**Interfaces:**
- Consumes: `Category`, `EvaluationType`, `Label`, `Procedure` from Task 1; the existing `backend/app/taxonomy/data/imported_taxonomy.json` (unchanged file — still has `category`/`label_type`/`procedure` string fields per label entry from yesterday's sqlite export, plus a `relations` list this rewrite ignores).
- Produces: `import_taxonomy(session: Session, data: dict) -> None` (same name/signature as today, different internal behavior) — consumed by `backend/scripts/import_taxonomy.py` (Task 6).

**Context:** Yesterday's `imported_taxonomy.json` has entries shaped like `{"key": "pharynx::egds", "name": "pharynx", "procedure": "egds", "color": "#2E81DA", "label_type": "geometric", "category": ...}` — wait, check the actual file: yesterday's synthetic category-root entries used `category::anatomy::egds` as their `key` and had `label_type: "geometric"` hardcoded for all category roots, but the underlying per-tag `category` string field (`"anatomy"`, `"findings"`, etc.) was captured during export before being folded into the old `LabelRelation`-based tree — confirm its presence by inspection before writing this task's code.

- [ ] **Step 1: Inspect the actual JSON shape**

Run: `cd backend && python3 -c "import json; d = json.load(open('app/taxonomy/data/imported_taxonomy.json')); print(json.dumps(d['labels'][:3], indent=2)); print(json.dumps([l for l in d['labels'] if not l['key'].startswith('category::')][:3], indent=2))"`

This prints the first 3 category-root entries and the first 3 real-tag entries. Confirm each real-tag entry has `name`, `procedure`, `color`, `label_type` fields (it does, per yesterday's export script) — but note it does NOT have a `category` string field on the tag entries themselves (only the synthetic `category::X::Y` root entries carry the category name, in their own `name` field, e.g. `"Anatomy"`). The relations list (`{"parent_key": "category::anatomy::egds", "child_key": "pharynx::egds"}`) is what currently encodes "this tag belongs to this category" — Step 2 below must read `relations` to recover each tag's category, since the flat `labels` list alone doesn't carry it per-tag.

- [ ] **Step 2: Rewrite `backend/app/taxonomy/import_taxonomy.py`**

```python
from sqlalchemy.orm import Session

from app.taxonomy.models import Category, EvaluationType, Label, Procedure


def import_taxonomy(session: Session, data: dict) -> None:
    procedure_by_name: dict[str, Procedure] = {}
    for name in data["procedures"]:
        procedure = session.query(Procedure).filter_by(name=name).one_or_none()
        if procedure is None:
            procedure = Procedure(name=name)
            session.add(procedure)
            session.flush()
        procedure_by_name[name] = procedure

    label_entries_by_key = {entry["key"]: entry for entry in data["labels"]}

    # Yesterday's export encoded "tag belongs to category" as a
    # LabelRelation edge (category-root -> tag), not as a field on the tag
    # entry itself. Recover it here: any relation whose parent_key starts
    # with "category::" tells us which category-root each tag hangs off.
    category_key_by_tag_key: dict[str, str] = {}
    for relation in data["relations"]:
        if relation["parent_key"].startswith("category::"):
            category_key_by_tag_key[relation["child_key"]] = relation["parent_key"]

    category_by_key: dict[str, Category] = {}
    evaluation_type_by_name: dict[str, EvaluationType] = {}
    label_by_key: dict[str, Label] = {}

    for key, entry in label_entries_by_key.items():
        if key.startswith("category::"):
            continue  # synthetic category-root entries are not imported as Label rows anymore

        category_key = category_key_by_tag_key.get(key)
        if category_key is None:
            continue  # a tag with no category relation (shouldn't happen in yesterday's data, but skip defensively rather than crash)
        category_entry = label_entries_by_key[category_key]
        procedure = procedure_by_name[entry["procedure"]]

        if category_key not in category_by_key:
            category = (
                session.query(Category)
                .filter_by(name=category_entry["name"], procedure_id=procedure.id)
                .one_or_none()
            )
            if category is None:
                category = Category(name=category_entry["name"], procedure_id=procedure.id)
                session.add(category)
                session.flush()
            category_by_key[category_key] = category
        category = category_by_key[category_key]

        evaluation_type_name = entry["label_type"]
        if evaluation_type_name not in evaluation_type_by_name:
            evaluation_type = (
                session.query(EvaluationType).filter_by(name=evaluation_type_name).one_or_none()
            )
            if evaluation_type is None:
                evaluation_type = EvaluationType(name=evaluation_type_name)
                session.add(evaluation_type)
                session.flush()
            evaluation_type_by_name[evaluation_type_name] = evaluation_type
        evaluation_type = evaluation_type_by_name[evaluation_type_name]

        label = (
            session.query(Label)
            .filter_by(name=entry["name"], category_id=category.id, evaluation_type_id=evaluation_type.id)
            .one_or_none()
        )
        if label is None:
            label = Label(
                name=entry["name"],
                color=entry["color"],
                category_id=category.id,
                evaluation_type_id=evaluation_type.id,
            )
            session.add(label)
            session.flush()
        label_by_key[key] = label

    session.commit()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_import_taxonomy.py -v`
Expected: FAIL — the existing tests in this file assert on `LabelRelation`/root-`Label` behavior that no longer applies; they need rewriting in the next step, not fixing to pass against old assumptions.

- [ ] **Step 3: Rewrite `backend/tests/test_import_taxonomy.py`**

```python
import app.main  # noqa: F401 -- registers every model on Base.metadata for test_engine's create_all/drop_all
from app.taxonomy.import_taxonomy import import_taxonomy
from app.taxonomy.models import Category, EvaluationType, Label, Procedure


def _sample_data() -> dict:
    return {
        "procedures": ["egds"],
        "labels": [
            {
                "key": "category::anatomy::egds",
                "name": "Anatomy",
                "procedure": "egds",
                "color": "#FFFFFF",
                "label_type": "geometric",
            },
            {
                "key": "pharynx::egds",
                "name": "pharynx",
                "procedure": "egds",
                "color": "#2E81DA",
                "label_type": "geometric",
            },
        ],
        "relations": [{"parent_key": "category::anatomy::egds", "child_key": "pharynx::egds"}],
    }


def test_creates_procedure_category_evaluation_type_and_label(db_session):
    import_taxonomy(db_session, _sample_data())

    procedure = db_session.query(Procedure).filter_by(name="egds").one()
    category = db_session.query(Category).filter_by(name="Anatomy", procedure_id=procedure.id).one()
    evaluation_type = db_session.query(EvaluationType).filter_by(name="geometric").one()
    label = db_session.query(Label).filter_by(name="pharynx").one()

    assert label.category_id == category.id
    assert label.evaluation_type_id == evaluation_type.id
    assert label.color == "#2E81DA"


def test_does_not_import_synthetic_category_root_entries_as_labels(db_session):
    import_taxonomy(db_session, _sample_data())

    assert db_session.query(Label).filter_by(name="Anatomy").count() == 0


def test_is_idempotent_when_run_twice(db_session):
    data = _sample_data()

    import_taxonomy(db_session, data)
    import_taxonomy(db_session, data)

    assert db_session.query(Procedure).filter_by(name="egds").count() == 1
    assert db_session.query(Category).filter_by(name="Anatomy").count() == 1
    assert db_session.query(EvaluationType).filter_by(name="geometric").count() == 1
    assert db_session.query(Label).filter_by(name="pharynx").count() == 1


def test_reuses_existing_procedure_across_multiple_calls(db_session):
    db_session.add(Procedure(name="egds"))
    db_session.commit()

    import_taxonomy(db_session, _sample_data())

    assert db_session.query(Procedure).filter_by(name="egds").count() == 1
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_import_taxonomy.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/app/taxonomy/import_taxonomy.py backend/tests/test_import_taxonomy.py
git commit -m "fix: rewrite import_taxonomy for Category/EvaluationType schema"
```

---

### Task 6: Re-run the taxonomy import against the migrated dev DB

**Files:**
- None (operational task, no code changes)

**Interfaces:**
- Consumes: `import_taxonomy` from Task 5, `backend/scripts/import_taxonomy.py` (unchanged from yesterday — reads the same JSON file, calls the same function name).

**Context:** Task 1's migration already truncates `labels`/`label_relations`/`annotations` as part of `upgrade()`. This task re-populates `labels`/`categories`/`evaluation_types` from the existing JSON export.

- [ ] **Step 1: Confirm the dev DB is on the new migration**

Run: `cd backend && uv run alembic current`
Expected: shows the revision ID from Task 1's migration file as the current head.

- [ ] **Step 2: Run the import script**

Run: `cd backend && uv run python -m scripts.import_taxonomy`
Expected: prints `Imported 149 labels and 160 relations across 2 procedures from .../imported_taxonomy.json` (same counts as yesterday's first run — the `relations` count in the printed message is just `len(data["relations"])` from the JSON file, unrelated to whether `LabelRelation` rows get created now; the script's print statement doesn't need to change since it's just describing the input file's shape).

- [ ] **Step 3: Verify via the API**

Run:
```bash
cd backend
TOKEN=$(uv run python -c "
import httpx
client = httpx.Client(base_url='http://localhost:8000')
client.post('/auth/register', json={'email': 'verify-import@example.com', 'password': 'pass1234', 'role': 'admin'})
resp = client.post('/auth/login', json={'email': 'verify-import@example.com', 'password': 'pass1234'})
print(resp.json()['access_token'])
")
curl -s "http://localhost:8000/taxonomy/procedures" -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```
Expected: `egds` and `colono` procedures are present. Then, using one procedure's id:
```bash
curl -s "http://localhost:8000/taxonomy/tree?procedure_id=<egds-procedure-id>" -H "Authorization: Bearer $TOKEN" | python3 -c "
import json, sys
tree = json.load(sys.stdin)
print('categories:', [n['category']['name'] for n in tree])
for node in tree:
    print(node['category']['name'], '->', [(et['evaluation_type']['name'], len(et['labels'])) for et in node['evaluation_types']])
"
```
Expected: 5 categories for egds (Anatomy, Findings, Artifacts, Quality, Imaging mode), each showing its evaluation types and label counts — no `jobs-test-label`/`Landmark`/`GI Tract` noise, since those were test-created `Annotation`-less `Label` rows wiped by Task 1's migration and never re-created (they were backend-test artifacts, not part of `imported_taxonomy.json`).

This task has no commit step — it's a data operation, not a code change.

---

### Task 7: Frontend — `useSequence` and `useTaxonomyTree` hooks

**Files:**
- Create: `frontend/src/entities/useSequence.ts`
- Create: `frontend/src/entities/useTaxonomyTree.ts`
- Delete: `frontend/src/entities/useLabelTree.ts`
- Test: `frontend/tests/useTaxonomyTree.test.ts` (new)

**Interfaces:**
- Consumes: `GET /media/sequences/{sequence_id}` (Task 4), `GET /taxonomy/tree?procedure_id=...` (Task 3) — both already reflected in `frontend/src/shared/api/generated/schema.d.ts` once `npm run generate-api` re-runs against the updated `openapi.json` (this happens automatically via `predev`/`pretest`, no manual step needed as long as backend tasks committed their `openapi.json` changes).
- Produces: `useSequence(sequenceId: number)` returning `{data: SequenceRead | undefined, ...}`; `useTaxonomyTree(procedureId: number | null)` returning `{data: TaxonomyTreeNode[] | undefined, ...}` — consumed by Task 8's `FrameEditor`/`CascadingLabelPicker` changes.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/useTaxonomyTree.test.ts`:

```typescript
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { apiClient } from "../src/shared/api/client";
import { useTaxonomyTree } from "../src/entities/useTaxonomyTree";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useTaxonomyTree", () => {
  it("fetches the tree for the given procedure id", async () => {
    const treeData = [
      {
        category: { id: 1, name: "Anatomy", procedure_id: 5 },
        evaluation_types: [
          {
            evaluation_type: { id: 1, name: "geometric" },
            labels: [{ id: 10, name: "pharynx", color: "#2E81DA", category_id: 1, evaluation_type_id: 1, taxonomy_version: 1 }],
          },
        ],
      },
    ];
    vi.spyOn(apiClient, "GET").mockResolvedValue({ data: treeData, error: undefined, response: new Response() } as never);

    const { result } = renderHook(() => useTaxonomyTree(5), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(treeData));
    expect(apiClient.GET).toHaveBeenCalledWith(
      "/taxonomy/tree",
      expect.objectContaining({ params: { query: { procedure_id: 5 } } }),
    );
  });

  it("does not fetch when procedureId is null", () => {
    const spy = vi.spyOn(apiClient, "GET").mockResolvedValue({ data: [], error: undefined, response: new Response() } as never);

    renderHook(() => useTaxonomyTree(null), { wrapper });

    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/useTaxonomyTree.test.ts`
Expected: FAIL — module `../src/entities/useTaxonomyTree` doesn't exist.

- [ ] **Step 3: Create `frontend/src/entities/useSequence.ts`**

```typescript
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useSequence(sequenceId: number) {
  return useQuery({
    queryKey: ["sequence", sequenceId],
    queryFn: async () => {
      const result = await apiClient.GET("/media/sequences/{sequence_id}", {
        params: { path: { sequence_id: sequenceId } },
      });
      return result.data;
    },
    enabled: Number.isFinite(sequenceId),
  });
}
```

- [ ] **Step 4: Create `frontend/src/entities/useTaxonomyTree.ts`**

```typescript
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useTaxonomyTree(procedureId: number | null) {
  return useQuery({
    queryKey: ["taxonomy", "tree", procedureId],
    queryFn: async () => {
      const result = await apiClient.GET("/taxonomy/tree", {
        params: { query: { procedure_id: procedureId as number } },
      });
      return result.data ?? [];
    },
    enabled: procedureId !== null,
  });
}
```

- [ ] **Step 5: Delete `frontend/src/entities/useLabelTree.ts`**

Run: `rm frontend/src/entities/useLabelTree.ts`

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/useTaxonomyTree.test.ts`
Expected: PASS (2 tests)

Also run the full suite to confirm nothing else references the deleted file yet (it will — `CascadingLabelPicker.tsx` still imports it; that's fixed in Task 8, so an import error here is expected and resolved next task, not a regression to chase down now):

Run: `cd frontend && npx tsc --noEmit 2>&1 | head -20`
Expected: one error, `Cannot find module './useLabelTree'` (or similar) from `CascadingLabelPicker.tsx` — confirms Task 5's deletion propagated correctly and Task 8 is the next required step, not a sign something's broken.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/entities/useSequence.ts frontend/src/entities/useTaxonomyTree.ts frontend/tests/useTaxonomyTree.test.ts
git rm frontend/src/entities/useLabelTree.ts
git commit -m "feat: add useSequence and useTaxonomyTree hooks, remove useLabelTree"
```

---

### Task 8: `CascadingLabelPicker` reads the new tree shape

**Files:**
- Modify: `frontend/src/features/annotation/CascadingLabelPicker.tsx`
- Modify: `frontend/src/features/annotation/ToolsPanel.tsx`
- Modify: `frontend/src/features/annotation/FrameEditor.tsx`
- Test: `frontend/tests/CascadingLabelPicker.test.tsx` (new)

**Interfaces:**
- Consumes: `useTaxonomyTree` (Task 7), `useSequence` (Task 7), `frameEditorStore`'s existing `labelCategoryId`/`labelClassification`/`labelTagId`/`setLabelSelection` (unchanged names/shape — only `labelClassification`'s runtime meaning shifts from a `LabelType` string to an `EvaluationType` id number, which is transparent to the store itself since it's typed as `LabelClassification` — check `frameEditorStore.ts`'s current type for that field before this task, since renaming its TypeScript type (not just its runtime values) may be needed).
- Produces: no new exports — `CascadingLabelPicker` gains a `procedureId: number | null` prop; `ToolsPanel` and `FrameEditor` pass it through.

- [ ] **Step 1: Change `LabelClassification`'s type in `frameEditorStore.ts`**

Confirmed today: `frontend/src/features/annotation/frameEditorStore.ts:5` has
`export type LabelClassification = "geometric" | "morphological" | "quality";`,
used at lines 28 and 44 as `labelClassification: LabelClassification | null`.
It's not imported anywhere else in the codebase (confirmed by search), so
this change is self-contained to this one file.

Change line 5 to:

```typescript
export type LabelClassification = number;
```

Lines 28 and 44 (`labelClassification: LabelClassification | null`) don't
need to change — they already wrap it in `| null`, and `LabelClassification`
now resolves to `number` instead of a string union, giving
`labelClassification: number | null` at both sites.

- [ ] **Step 2: Write the failing test**

Create `frontend/tests/CascadingLabelPicker.test.tsx`:

```typescript
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { createFrameEditorStore } from "../src/features/annotation/frameEditorStore";
import { CascadingLabelPicker } from "../src/features/annotation/CascadingLabelPicker";

const TREE = [
  {
    category: { id: 1, name: "Anatomy", procedure_id: 5 },
    evaluation_types: [
      {
        evaluation_type: { id: 100, name: "geometric" },
        labels: [{ id: 10, name: "pharynx", color: "#2E81DA", category_id: 1, evaluation_type_id: 100, taxonomy_version: 1 }],
      },
    ],
  },
  {
    category: { id: 2, name: "Findings", procedure_id: 5 },
    evaluation_types: [
      {
        evaluation_type: { id: 200, name: "morphological" },
        labels: [{ id: 20, name: "colon_adenoma", color: "#DA352E", category_id: 2, evaluation_type_id: 200, taxonomy_version: 1 }],
      },
    ],
  },
];

function renderPicker(procedureId: number | null = 5) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(apiClient, "GET").mockResolvedValue({ data: TREE, error: undefined, response: new Response() } as never);
  const store = createFrameEditorStore();
  render(
    <QueryClientProvider client={queryClient}>
      <CascadingLabelPicker store={store} procedureId={procedureId} />
    </QueryClientProvider>,
  );
  return store;
}

describe("CascadingLabelPicker", () => {
  it("lists categories from the taxonomy tree", async () => {
    renderPicker();

    expect(await screen.findByRole("option", { name: "Anatomy" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Findings" })).toBeInTheDocument();
  });

  it("selecting a category populates evaluation type options from the tree, not derived label_type strings", async () => {
    renderPicker();
    const user = userEvent.setup();

    await screen.findByRole("option", { name: "Anatomy" });
    await user.selectOptions(screen.getByLabelText("Category"), "1");

    expect(screen.getByRole("option", { name: "geometric" })).toBeInTheDocument();
  });

  it("selecting category and evaluation type populates tag options from that branch's labels", async () => {
    renderPicker();
    const user = userEvent.setup();

    await screen.findByRole("option", { name: "Anatomy" });
    await user.selectOptions(screen.getByLabelText("Category"), "1");
    await user.selectOptions(screen.getByLabelText("Classification"), "100");

    expect(screen.getByRole("option", { name: "pharynx" })).toBeInTheDocument();
  });

  it("does not fetch the tree when procedureId is null", () => {
    const store = createFrameEditorStore();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(apiClient, "GET").mockResolvedValue({ data: [], error: undefined, response: new Response() } as never);

    render(
      <QueryClientProvider client={queryClient}>
        <CascadingLabelPicker store={store} procedureId={null} />
      </QueryClientProvider>,
    );

    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/CascadingLabelPicker.test.tsx`
Expected: FAIL — `CascadingLabelPicker` doesn't accept a `procedureId` prop yet, and still imports the deleted `useLabelTree`.

- [ ] **Step 4: Rewrite `frontend/src/features/annotation/CascadingLabelPicker.tsx`**

```typescript
import { useStore } from "zustand/react";

import { useTaxonomyTree } from "../../entities/useTaxonomyTree";
import type { FrameEditorStore } from "./frameEditorStore";

interface CascadingLabelPickerProps {
  store: FrameEditorStore;
  procedureId: number | null;
}

const SELECT_CLASSES =
  "mt-1 w-full rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50";

export function CascadingLabelPicker({ store, procedureId }: CascadingLabelPickerProps) {
  const treeQuery = useTaxonomyTree(procedureId);
  const tree = treeQuery.data ?? [];

  const labelCategoryId = useStore(store, (state) => state.labelCategoryId);
  const labelClassification = useStore(store, (state) => state.labelClassification);
  const labelTagId = useStore(store, (state) => state.labelTagId);
  const setLabelSelection = useStore(store, (state) => state.setLabelSelection);

  const selectedCategory = tree.find((node) => node.category.id === labelCategoryId);
  const evaluationTypeOptions = selectedCategory?.evaluation_types ?? [];
  const selectedEvaluationTypeNode = evaluationTypeOptions.find(
    (node) => node.evaluation_type.id === labelClassification,
  );
  const tagOptions = labelClassification === null
    ? evaluationTypeOptions.flatMap((node) => node.labels)
    : (selectedEvaluationTypeNode?.labels ?? []);

  return (
    <div className="space-y-2">
      <label className="block text-xs text-gray-400">
        Category
        <select
          className={SELECT_CLASSES}
          value={labelCategoryId ?? ""}
          onChange={(event) =>
            setLabelSelection({
              labelCategoryId: event.target.value ? Number(event.target.value) : null,
              labelClassification: null,
              labelTagId: null,
            })
          }
        >
          <option value="">Select category</option>
          {tree.map((node) => (
            <option key={node.category.id} value={node.category.id}>
              {node.category.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block text-xs text-gray-400">
        Classification
        <select
          className={SELECT_CLASSES}
          value={labelClassification ?? ""}
          disabled={!selectedCategory}
          onChange={(event) =>
            setLabelSelection({
              labelClassification: event.target.value ? Number(event.target.value) : null,
              labelTagId: null,
            } as never)
          }
        >
          <option value="">All</option>
          {evaluationTypeOptions.map(({ evaluation_type: evaluationType }) => (
            <option key={evaluationType.id} value={evaluationType.id}>
              {evaluationType.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block text-xs text-gray-400">
        Tag
        <select
          className={SELECT_CLASSES}
          value={labelTagId ?? ""}
          disabled={!selectedCategory}
          onChange={(event) =>
            setLabelSelection({ labelTagId: event.target.value ? Number(event.target.value) : null })
          }
        >
          <option value="">Select tag</option>
          {tagOptions.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
```

Note the `as never` cast on `labelClassification` mirrors the existing pattern already in this file (was already there for the old string-enum case) — needed because `setLabelSelection`'s partial-update type is a discriminated shape that TypeScript can't narrow across the two fields being set together; this is pre-existing, not new.

- [ ] **Step 5: Update `frontend/src/features/annotation/ToolsPanel.tsx`**

Change the `ToolsPanelProps` interface (lines 11-16 today) to add `procedureId`:

```typescript
interface ToolsPanelProps {
  store: FrameEditorStore;
  annotations: Annotation[];
  frameId: number;
  onTrack: () => void;
  procedureId: number | null;
}
```

Change the component signature (line 22 today) to destructure it:

```typescript
export function ToolsPanel({ store, annotations, frameId, onTrack, procedureId }: ToolsPanelProps) {
```

Change the `<CascadingLabelPicker store={store} />` call (line 91 today) to:

```typescript
<CascadingLabelPicker store={store} procedureId={procedureId} />
```

- [ ] **Step 6: Update `frontend/src/features/annotation/FrameEditor.tsx`**

This file already has (from an earlier session's mask-coloring feature,
confirmed present today) a `useLabelTree()` call at line 49 and a
`buildLabelColorMap(labelTreeQuery.data ?? [])` call at line 54, both of
which break once Task 7 deletes `useLabelTree.ts`. Rather than patch them
now and re-patch again in a later task, fix them fully here in one pass —
this is the one place in the plan `FrameEditor.tsx` is touched.

Change the import block: remove line 7 (`import { useLabelTree } from
"../../entities/useLabelTree";`) and line 12 (`import { buildLabelColorMap
} from "./labelColors";` stays — only its input type changes, not the
import itself), adding two new imports in their place:

```typescript
import { useSequence } from "../../entities/useSequence";
import { useTaxonomyTree } from "../../entities/useTaxonomyTree";
```

Change line 49 (was `const labelTreeQuery = useLabelTree();`) to:

```typescript
  const sequenceQuery = useSequence(frameQuery.data?.sequence_id ?? Number.NaN);
  const taxonomyTreeQuery = useTaxonomyTree(sequenceQuery.data?.procedure_id ?? null);
```

(`Number.NaN` as the fallback keeps `useSequence`'s `enabled:
Number.isFinite(sequenceId)` guard from firing a request before
`frameQuery.data` resolves — mirrors how `frameQuery.data?.sequence_id` is
already used elsewhere in this file, e.g. `handleTrack`'s `sequence_id:
frameQuery.data?.sequence_id ?? 0` fallback, just using `NaN` instead of
`0` here since `0` would be a truthy-looking but wrong sequence id to
actually request.)

Change line 54 (was `const labelColorById = useMemo(() =>
buildLabelColorMap(labelTreeQuery.data ?? []), [labelTreeQuery.data]);`) to:

```typescript
  const labelColorById = useMemo(() => buildLabelColorMap(taxonomyTreeQuery.data ?? []), [taxonomyTreeQuery.data]);
```

Then update the `<ToolsPanel ... />` call to add:

```typescript
          procedureId={sequenceQuery.data?.procedure_id ?? null}
```

Both `labelColorById` and `CascadingLabelPicker` now read the same
procedure-scoped `useTaxonomyTree` query — deduplicated automatically by
TanStack Query's query-key caching, since both call sites use the
identical `["taxonomy", "tree", procedureId]` key. This also means the
`buildLabelColorMap` rewrite (new tree shape, and no longer mapping
`Category` ids since `CategoryRead` has no `color` field in the new
schema) has to land in this same step, not a separate task — see Step
6a below.

- [ ] **Step 6a: Rewrite `buildLabelColorMap` for the new tree shape**

Replace `frontend/src/features/annotation/labelColors.ts` entirely:

```typescript
import type { components } from "../../shared/api/generated/schema";

type TaxonomyTreeNode = components["schemas"]["TaxonomyTreeNode"];

export function buildLabelColorMap(tree: TaxonomyTreeNode[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const categoryNode of tree) {
    for (const evaluationTypeNode of categoryNode.evaluation_types) {
      for (const label of evaluationTypeNode.labels) {
        map.set(label.id, label.color);
      }
    }
  }
  return map;
}
```

Replace `frontend/tests/labelColors.test.ts` entirely:

```typescript
import { describe, expect, it } from "vitest";

import { buildLabelColorMap } from "../src/features/annotation/labelColors";
import type { components } from "../src/shared/api/generated/schema";

type TaxonomyTreeNode = components["schemas"]["TaxonomyTreeNode"];

function label(overrides: Partial<components["schemas"]["LabelRead"]> = {}): components["schemas"]["LabelRead"] {
  return {
    id: 1,
    name: "lesion",
    color: "#ffffff",
    category_id: 1,
    evaluation_type_id: 1,
    taxonomy_version: 1,
    ...overrides,
  };
}

describe("buildLabelColorMap", () => {
  it("maps a label id to its own color", () => {
    const tree: TaxonomyTreeNode[] = [
      {
        category: { id: 1, name: "Anatomy", procedure_id: 5 },
        evaluation_types: [
          {
            evaluation_type: { id: 1, name: "geometric" },
            labels: [label({ id: 10, color: "#ff0000" })],
          },
        ],
      },
    ];
    const map = buildLabelColorMap(tree);
    expect(map.get(10)).toBe("#ff0000");
  });

  it("does not map the category id itself, since categories have no color in this schema", () => {
    const tree: TaxonomyTreeNode[] = [
      {
        category: { id: 1, name: "Anatomy", procedure_id: 5 },
        evaluation_types: [
          {
            evaluation_type: { id: 1, name: "geometric" },
            labels: [label({ id: 10, color: "#ff0000" })],
          },
        ],
      },
    ];
    const map = buildLabelColorMap(tree);
    expect(map.has(1)).toBe(false);
  });

  it("covers labels across multiple categories and evaluation types", () => {
    const tree: TaxonomyTreeNode[] = [
      {
        category: { id: 1, name: "Anatomy", procedure_id: 5 },
        evaluation_types: [
          { evaluation_type: { id: 1, name: "geometric" }, labels: [label({ id: 10, color: "#ff0000" })] },
        ],
      },
      {
        category: { id: 2, name: "Findings", procedure_id: 5 },
        evaluation_types: [
          { evaluation_type: { id: 2, name: "morphological" }, labels: [label({ id: 20, color: "#00ff00" })] },
        ],
      },
    ];
    const map = buildLabelColorMap(tree);
    expect(map.get(10)).toBe("#ff0000");
    expect(map.get(20)).toBe("#00ff00");
  });

  it("returns an empty map for an empty tree", () => {
    const map = buildLabelColorMap([]);
    expect(map.size).toBe(0);
  });
});
```

- [ ] **Step 7: Update `FrameEditor.test.tsx`'s mock to cover the new sequence/tree routes**

`frontend/tests/FrameEditor.test.tsx` currently mocks `/taxonomy/labels/tree`
(line 41) with a `LABEL_TREE` fixture in the old `{category, children}`
shape (lines 9-16) — both need replacing, and a new mock branch for
`/media/sequences/{sequence_id}` (not mocked at all today) needs adding,
or `sequenceQuery.data` stays `undefined` throughout every test in this
file and `procedureId` stays `null`.

Replace lines 9-16 (`const LABEL_TREE = [...]`) with:

```typescript
const TAXONOMY_TREE = [
  {
    category: { id: 1, name: "lesion", procedure_id: 9 },
    evaluation_types: [
      {
        evaluation_type: { id: 1, name: "geometric" },
        labels: [{ id: 2, name: "0-Ip", color: "#f00", category_id: 1, evaluation_type_id: 1, taxonomy_version: 1 }],
      },
    ],
  },
];
```

Replace the `if (path === "/taxonomy/labels/tree")` branch (lines 41-43) with:

```typescript
    if (path === "/taxonomy/tree") {
      return { data: TAXONOMY_TREE, error: undefined, response: new Response() };
    }
    if (path === "/media/sequences/{sequence_id}") {
      return { data: { id: 9, procedure_id: 9, video_id: null, start_time: 0, duration: 0 }, error: undefined, response: new Response() };
    }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/CascadingLabelPicker.test.tsx tests/FrameEditor.test.tsx`
Expected: PASS — every existing `FrameEditor.test.tsx` test still passes (none of them assert on label-tree/category contents directly, per today's file), plus the new `CascadingLabelPicker.test.tsx` tests from Step 2.

- [ ] **Step 9: Run the full frontend suite and typecheck**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: 0 TypeScript errors, all tests pass — including `labelColors.test.ts` (Step 6a) and `FrameEditor.test.tsx` (Step 7).

- [ ] **Step 10: Commit**

```bash
git add frontend/src/features/annotation/CascadingLabelPicker.tsx frontend/src/features/annotation/ToolsPanel.tsx frontend/src/features/annotation/FrameEditor.tsx frontend/src/features/annotation/labelColors.ts frontend/tests/CascadingLabelPicker.test.tsx frontend/tests/FrameEditor.test.tsx frontend/tests/labelColors.test.ts
git commit -m "feat: CascadingLabelPicker and mask coloring read the Category/EvaluationType taxonomy tree"
```

---

### Task 9: Manual verification in the browser

**Files:** none

- [ ] **Step 1: Confirm the stack is running**

Per CLAUDE.md's "Running the stack" section: `docker compose up -d`, backend (`uv run uvicorn app.main:app --reload`), frontend (`npm run dev`).

- [ ] **Step 2: Register/login, create a sequence, open the frame editor**

Register a test user via `/auth/register` + `/auth/login` (or the login page at `http://localhost:5173/login` if a user already exists), then navigate to a frame in the editor.

- [ ] **Step 3: Verify the label picker**

In the frame editor's tools panel: confirm the Category `<select>` shows exactly the imported categories for that frame's sequence's procedure (e.g. for a `colono` sequence: Anatomy, Artifacts, Findings, Quality — no `Imaging mode`, since colono has no tags under it per the imported data; no `jobs-test-label`/`Landmark`/`GI Tract`). Pick a category, confirm the Classification dropdown shows evaluation types (geometric/morphological) with real label counts, pick one, confirm the Tag dropdown shows real tag names (e.g. `pharynx`, `colon_adenoma`) — not synthetic category-root names.

- [ ] **Step 4: Confirm no console errors**

Check the browser console for errors during this flow (network 404s on `/taxonomy/labels/tree`, `/media/sequences/{id}` failures, etc.) — there should be none, since every route the frontend now calls exists per Tasks 3-4.

This task has no commit step.

---

## Self-Review Notes

- **Spec coverage:** data model (Task 1), API contract (Tasks 3-4), migration/data plan (Tasks 1, 6), frontend changes (Tasks 7-8), testing (every task has its own TDD cycle) — all covered. The spec's "Out of scope" section (no admin UI, no annotation-row migration, no re-upload of the two lost sequences) has correspondingly no task — correct.
- **Type consistency:** `Category`/`EvaluationType`/`Label` field names match between Task 1 (models), Task 2 (schemas/service), Task 3 (router), Task 5 (import script) — `category_id`/`evaluation_type_id` used consistently, never `categoryId`/`evaluationTypeId` mixed in on the Python side. Frontend: `procedureId` (camelCase prop) vs. `procedure_id` (snake_case API field) is the deliberate, existing convention boundary already used throughout this codebase (e.g. `frame_id` API field vs. no camelCase equivalent needed since it's not a prop) — Task 7/8 keep this boundary consistent.
- **No placeholders:** every step has runnable code. Task 5's Step 1 (inspect the JSON) is genuinely an inspection step, not a placeholder — its output determines nothing conditional in the plan (the code in Step 2 is written either way, based on the already-known shape from yesterday's implementation), it's there so the implementer double-checks a specific assumption before trusting it.
- **Pre-existing code the spec didn't mention:** `FrameEditor.tsx` already had a `useLabelTree()`/`buildLabelColorMap()` call pair from an earlier session's mask-coloring feature, which the original spec draft didn't account for (it assumed `CascadingLabelPicker` was the only consumer of the label tree). Caught during this plan's self-review by grepping the actual file rather than trusting the spec's file list — folded into Task 8 as Steps 6/6a rather than left as a dangling compile error for whoever runs Task 7's deletion. This is exactly the kind of gap a plan review is supposed to catch: the spec's "Frontend changes" section only mentioned `CascadingLabelPicker.tsx`, `frameEditorStore.ts`, and a new `useTaxonomyTree` hook — not `labelColors.ts` or `FrameEditor.tsx`'s existing tree consumption.
- **Task 8 sizing:** originally drafted as two tasks (picker changes, then a separate "fix labelColors/FrameEditor" task), merged into one after review — both touch `FrameEditor.tsx` in ways that depend on each other (the same `sequenceQuery`/`taxonomyTreeQuery` variables), and splitting them would have meant either a broken intermediate commit (FrameEditor.tsx referencing a deleted module) or an awkward "don't stage this file yet" instruction. One task, one working commit at the end, per this skill's task-sizing guidance ("split only where a reviewer could meaningfully reject one task while approving its neighbor" — these two halves can't be independently accepted, since neither compiles without the other).
