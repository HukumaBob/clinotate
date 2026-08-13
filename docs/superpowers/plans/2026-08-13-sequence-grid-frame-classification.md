# Sequence grid frame classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an annotator select frames in the sequence grid and bulk-assign or bulk-clear a frame-level classification label (e.g. anatomical landmark, artifact, exam quality), reusing the existing `AnnotationType.CLASSIFICATION` machinery.

**Architecture:** Two new synchronous FastAPI endpoints (`bulk-classify`, `bulk-clear-classification`) in the existing `annotation` module perform plain multi-row `Annotation` writes inside one transaction — no Celery job, no new tables. The frontend adds a Category→Label control group to the existing `SequenceGridToolbar` Select-mode UI, wired to two new `useMutation` hooks that follow the existing `useDeleteFrames` pattern. `FrameThumbnail` already renders a badge per classification annotation with the label's color — no changes needed there.

**Tech Stack:** FastAPI, SQLAlchemy, Pydantic (backend); React, TanStack Query, `openapi-typescript`-generated client, Vitest + Testing Library (frontend).

**Spec:** [docs/superpowers/specs/2026-08-13-sequence-grid-frame-classification-design.md](../specs/2026-08-13-sequence-grid-frame-classification-design.md)

## Global Constraints

- No Russian anywhere in the repository (code, comments, docstrings, UI copy) — conversation with the user is fine, committed content is not.
- Object storage: not applicable here — classification annotations have no `storage_key`/mask.
- `taxonomy_version`: every new `Annotation` must copy `label.taxonomy_version` at creation time, exactly like `create_classification_annotation` already does.
- API contract: REST + OpenAPI. After any backend route change, regenerate `openapi.json` via `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`, then run the frontend's `generate-api` (auto-runs via `predev`/`pretest`, or `cd frontend && npm run generate-api` directly) before writing frontend code that references the new endpoints — the generated `apiClient` types won't exist until this is done.
- TDD: every backend task and every frontend task with logic gets a failing test before the implementation.
- Never hand-write an untyped `fetch()` — use `apiClient` from `frontend/src/shared/api/client.ts`.

---

### Task 1: Backend — `bulk_classify_frames` service function + endpoint

**Files:**
- Modify: `backend/app/annotation/service.py` (add `bulk_classify_frames`)
- Modify: `backend/app/annotation/schemas.py` (add `BulkClassifyRequest`, `BulkClassifyResult`)
- Modify: `backend/app/annotation/router.py` (add `POST /annotation/frames/bulk-classify`)
- Test: `backend/tests/test_annotation.py`

**Interfaces:**
- Consumes: `app.annotation.models.Annotation`, `app.annotation.models.AnnotationType.CLASSIFICATION` (existing), `app.taxonomy.models.Label` (existing, has `category_id`, `taxonomy_version`), `app.auth.models.User` (existing).
- Produces: `bulk_classify_frames(session: Session, frame_ids: list[int], label_id: int, created_by: User) -> list[int]` — returns the list of `frame_ids` processed. Router response model `BulkClassifyResult` with field `frame_ids: list[int]`. Endpoint: `POST /annotation/frames/bulk-classify`, request body `BulkClassifyRequest {frame_ids: list[int], label_id: int}`, `201 Created`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_annotation.py` (reuses the existing `_register_and_login`, `_create_frame`, `_headers` helpers already in that file; add a second label-creation helper that creates a label in a *different* category under the same evaluation type, needed to test cross-category independence):

```python
def _create_label_in_category(token: str, category_name: str, label_name: str) -> int:
    headers = _headers(token)

    procedures = client.get("/taxonomy/procedures", headers=headers).json()
    procedure = next((p for p in procedures if p["name"] == "annotation-test-procedure"), None)
    if procedure is None:
        procedure = client.post(
            "/taxonomy/procedures", json={"name": "annotation-test-procedure"}, headers=headers
        ).json()

    categories = client.get(
        f"/taxonomy/categories?procedure_id={procedure['id']}", headers=headers
    ).json()
    category = next((c for c in categories if c["name"] == category_name), None)
    if category is None:
        category = client.post(
            "/taxonomy/categories",
            json={"name": category_name, "procedure_id": procedure["id"]},
            headers=headers,
        ).json()

    evaluation_types = client.get("/taxonomy/evaluation-types", headers=headers).json()
    evaluation_type = next(
        (e for e in evaluation_types if e["name"] == "annotation-test-evaluation-type"), None
    )
    if evaluation_type is None:
        evaluation_type = client.post(
            "/taxonomy/evaluation-types", json={"name": "annotation-test-evaluation-type"}, headers=headers
        ).json()

    return client.post(
        "/taxonomy/labels",
        json={
            "name": label_name,
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=headers,
    ).json()["id"]


def test_bulk_classify_assigns_label_to_all_frames():
    token = _register_and_login("bulkclass1@example.com")
    frame_id_1 = _create_frame(token)
    frame_id_2 = _create_frame(token)
    label_id = _create_label_in_category(token, "bulk-classify-landmark", "antrum")

    response = client.post(
        "/annotation/frames/bulk-classify",
        json={"frame_ids": [frame_id_1, frame_id_2], "label_id": label_id},
        headers=_headers(token),
    )

    assert response.status_code == 201
    assert set(response.json()["frame_ids"]) == {frame_id_1, frame_id_2}

    for frame_id in (frame_id_1, frame_id_2):
        annotations = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token)).json()
        assert len(annotations) == 1
        assert annotations[0]["label_id"] == label_id
        assert annotations[0]["annotation_type"] == "classification"


def test_bulk_classify_replaces_existing_label_in_same_category():
    token = _register_and_login("bulkclass2@example.com")
    frame_id = _create_frame(token)
    antrum_id = _create_label_in_category(token, "bulk-classify-replace", "antrum")
    ge_junction_id = _create_label_in_category(token, "bulk-classify-replace", "ge_junction")

    client.post(
        "/annotation/frames/bulk-classify",
        json={"frame_ids": [frame_id], "label_id": antrum_id},
        headers=_headers(token),
    )
    response = client.post(
        "/annotation/frames/bulk-classify",
        json={"frame_ids": [frame_id], "label_id": ge_junction_id},
        headers=_headers(token),
    )

    assert response.status_code == 201
    annotations = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token)).json()
    assert len(annotations) == 1
    assert annotations[0]["label_id"] == ge_junction_id


def test_bulk_classify_keeps_labels_in_different_categories_independent():
    token = _register_and_login("bulkclass3@example.com")
    frame_id = _create_frame(token)
    landmark_id = _create_label_in_category(token, "bulk-classify-landmark-axis", "antrum")
    quality_id = _create_label_in_category(token, "bulk-classify-quality-axis", "low_quality")

    client.post(
        "/annotation/frames/bulk-classify",
        json={"frame_ids": [frame_id], "label_id": landmark_id},
        headers=_headers(token),
    )
    response = client.post(
        "/annotation/frames/bulk-classify",
        json={"frame_ids": [frame_id], "label_id": quality_id},
        headers=_headers(token),
    )

    assert response.status_code == 201
    annotations = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token)).json()
    label_ids = {a["label_id"] for a in annotations}
    assert label_ids == {landmark_id, quality_id}


def test_bulk_classify_404s_for_unknown_label():
    token = _register_and_login("bulkclass4@example.com")
    frame_id = _create_frame(token)

    response = client.post(
        "/annotation/frames/bulk-classify",
        json={"frame_ids": [frame_id], "label_id": 999999999},
        headers=_headers(token),
    )

    assert response.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_annotation.py -k bulk_classify -v`
Expected: FAIL — `404 Not Found` for the new route (it doesn't exist yet), or `ImportError`/`AttributeError` depending on how far test collection gets.

- [ ] **Step 3: Add `BulkClassifyRequest`/`BulkClassifyResult` schemas**

In `backend/app/annotation/schemas.py`, add:

```python
class BulkClassifyRequest(BaseModel):
    frame_ids: list[int]
    label_id: int


class BulkClassifyResult(BaseModel):
    frame_ids: list[int]
```

- [ ] **Step 4: Implement `bulk_classify_frames` in `annotation/service.py`**

Add below `create_classification_annotation`:

```python
def bulk_classify_frames(
    session: Session, frame_ids: list[int], label_id: int, created_by: User
) -> list[int]:
    label = session.get(Label, label_id)
    if label is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Label not found")

    category_label_ids = {
        row.id
        for row in session.query(Label).filter(Label.category_id == label.category_id).all()
    }

    for frame_id in frame_ids:
        existing = (
            session.query(Annotation)
            .filter(
                Annotation.frame_id == frame_id,
                Annotation.annotation_type == AnnotationType.CLASSIFICATION,
                Annotation.label_id.in_(category_label_ids),
            )
            .all()
        )
        for annotation in existing:
            session.delete(annotation)

        session.add(
            Annotation(
                frame_id=frame_id,
                label_id=label_id,
                taxonomy_version=label.taxonomy_version,
                annotation_type=AnnotationType.CLASSIFICATION,
                payload={},
                created_by_id=created_by.id,
            )
        )

    session.commit()
    return frame_ids
```

(`Label` and `HTTPException`/`status` are already imported in this file.)

- [ ] **Step 5: Add the router endpoint**

In `backend/app/annotation/router.py`, import `BulkClassifyRequest`, `BulkClassifyResult`, and `bulk_classify_frames`, then add:

```python
@router.post(
    "/frames/bulk-classify", response_model=BulkClassifyResult, status_code=status.HTTP_201_CREATED
)
def bulk_classify(
    payload: BulkClassifyRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> BulkClassifyResult:
    frame_ids = bulk_classify_frames(session, payload.frame_ids, payload.label_id, current_user)
    return BulkClassifyResult(frame_ids=frame_ids)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_annotation.py -k bulk_classify -v`
Expected: PASS (4 tests)

- [ ] **Step 7: Run the full annotation test suite to check for regressions**

Run: `cd backend && uv run pytest tests/test_annotation.py -v`
Expected: PASS (all tests, including the pre-existing ones)

- [ ] **Step 8: Commit**

```bash
git add backend/app/annotation/service.py backend/app/annotation/schemas.py backend/app/annotation/router.py backend/tests/test_annotation.py
git commit -m "feat: add bulk-classify endpoint for frame-level classification"
```

---

### Task 2: Backend — `bulk_clear_classification` service function + endpoint

**Files:**
- Modify: `backend/app/annotation/service.py` (add `bulk_clear_classification`)
- Modify: `backend/app/annotation/schemas.py` (add `BulkClearClassificationRequest`)
- Modify: `backend/app/annotation/router.py` (add `POST /annotation/frames/bulk-clear-classification`)
- Test: `backend/tests/test_annotation.py`

**Interfaces:**
- Consumes: same models as Task 1, plus `bulk_classify_frames` (Task 1) to set up fixture state in tests.
- Produces: `bulk_clear_classification(session: Session, frame_ids: list[int], category_id: int) -> list[int]`. Router response model reuses `BulkClassifyResult` (`{frame_ids: list[int]}`) — no new response schema needed. Endpoint: `POST /annotation/frames/bulk-clear-classification`, request body `BulkClearClassificationRequest {frame_ids: list[int], category_id: int}`, `200 OK`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_annotation.py`:

```python
def test_bulk_clear_classification_removes_label_in_that_category_only():
    token = _register_and_login("bulkclear1@example.com")
    frame_id = _create_frame(token)
    landmark_id = _create_label_in_category(token, "bulk-clear-landmark", "antrum")
    quality_id = _create_label_in_category(token, "bulk-clear-quality", "low_quality")
    landmark_label = client.get("/taxonomy/labels", headers=_headers(token)).json()
    landmark_category_id = next(l for l in landmark_label if l["id"] == landmark_id)["category_id"]

    client.post(
        "/annotation/frames/bulk-classify",
        json={"frame_ids": [frame_id], "label_id": landmark_id},
        headers=_headers(token),
    )
    client.post(
        "/annotation/frames/bulk-classify",
        json={"frame_ids": [frame_id], "label_id": quality_id},
        headers=_headers(token),
    )

    response = client.post(
        "/annotation/frames/bulk-clear-classification",
        json={"frame_ids": [frame_id], "category_id": landmark_category_id},
        headers=_headers(token),
    )

    assert response.status_code == 200
    annotations = client.get(f"/annotation/frames/{frame_id}/annotations", headers=_headers(token)).json()
    label_ids = {a["label_id"] for a in annotations}
    assert label_ids == {quality_id}


def test_bulk_clear_classification_is_a_no_op_when_nothing_to_clear():
    token = _register_and_login("bulkclear2@example.com")
    frame_id = _create_frame(token)
    label_id = _create_label_in_category(token, "bulk-clear-empty", "some_label")
    labels = client.get("/taxonomy/labels", headers=_headers(token)).json()
    category_id = next(l for l in labels if l["id"] == label_id)["category_id"]

    response = client.post(
        "/annotation/frames/bulk-clear-classification",
        json={"frame_ids": [frame_id], "category_id": category_id},
        headers=_headers(token),
    )

    assert response.status_code == 200
    assert response.json()["frame_ids"] == [frame_id]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_annotation.py -k bulk_clear -v`
Expected: FAIL — `404 Not Found` for the new route.

- [ ] **Step 3: Add `BulkClearClassificationRequest` schema**

In `backend/app/annotation/schemas.py`:

```python
class BulkClearClassificationRequest(BaseModel):
    frame_ids: list[int]
    category_id: int
```

- [ ] **Step 4: Implement `bulk_clear_classification` in `annotation/service.py`**

```python
def bulk_clear_classification(session: Session, frame_ids: list[int], category_id: int) -> list[int]:
    category_label_ids = {
        row.id for row in session.query(Label).filter(Label.category_id == category_id).all()
    }

    if category_label_ids:
        session.query(Annotation).filter(
            Annotation.frame_id.in_(frame_ids),
            Annotation.annotation_type == AnnotationType.CLASSIFICATION,
            Annotation.label_id.in_(category_label_ids),
        ).delete(synchronize_session=False)
        session.commit()

    return frame_ids
```

- [ ] **Step 5: Add the router endpoint**

In `backend/app/annotation/router.py`, import `BulkClearClassificationRequest` and `bulk_clear_classification`, then add:

```python
@router.post("/frames/bulk-clear-classification", response_model=BulkClassifyResult)
def bulk_clear_classification_endpoint(
    payload: BulkClearClassificationRequest,
    session: Session = Depends(get_session),
) -> BulkClassifyResult:
    frame_ids = bulk_clear_classification(session, payload.frame_ids, payload.category_id)
    return BulkClassifyResult(frame_ids=frame_ids)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_annotation.py -k "bulk_clear or bulk_classify" -v`
Expected: PASS (6 tests total)

- [ ] **Step 7: Run the full backend test suite**

Run: `cd backend && uv run pytest -v`
Expected: PASS (no regressions). If you hit unrelated 409s/duplicate-row failures from shared dev-DB fixtures, see `CLAUDE.md`'s note on that — don't truncate tables without asking the user first.

- [ ] **Step 8: Commit**

```bash
git add backend/app/annotation/service.py backend/app/annotation/schemas.py backend/app/annotation/router.py backend/tests/test_annotation.py
git commit -m "feat: add bulk-clear-classification endpoint"
```

---

### Task 3: Regenerate OpenAPI schema and frontend generated client

**Files:**
- Modify: `openapi.json` (repo root, regenerated)
- Modify (generated, gitignored, not committed): `frontend/src/shared/api/generated/schema.d.ts`

**Interfaces:**
- Consumes: the two endpoints added in Task 1 and Task 2.
- Produces: `apiClient.POST("/annotation/frames/bulk-classify", ...)` and `apiClient.POST("/annotation/frames/bulk-clear-classification", ...)` become callable with generated types in frontend code — required before Task 4/5 can compile.

- [ ] **Step 1: Regenerate `openapi.json`**

Run: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`

- [ ] **Step 2: Verify it changed**

Run: `git diff --stat openapi.json`
Expected: shows changes (new paths `/annotation/frames/bulk-classify` and `/annotation/frames/bulk-clear-classification`, new schemas `BulkClassifyRequest`, `BulkClassifyResult`, `BulkClearClassificationRequest`).

- [ ] **Step 3: Regenerate the frontend client**

Run: `cd frontend && npm run generate-api`
Expected: `frontend/src/shared/api/generated/schema.d.ts` is rewritten (gitignored, not committed) and now contains `BulkClassifyRequest`/`BulkClassifyResult`/`BulkClearClassificationRequest` types and the two new paths.

- [ ] **Step 4: Commit the OpenAPI schema change**

```bash
git add openapi.json
git commit -m "chore: regenerate openapi.json for bulk-classify endpoints"
```

---

### Task 4: Frontend — `useBulkClassifyFrames`/`useBulkClearClassification` hooks

**Files:**
- Modify: `frontend/src/entities/useAnnotations.ts` (add the two new mutation hooks)
- Test: `frontend/src/entities/useAnnotations.test.tsx` (create — no existing test file for this entity; follow the pattern in `frontend/src/entities/useFrames.test.tsx`)

**Interfaces:**
- Consumes: `apiClient` from `frontend/src/shared/api/client.ts` (existing); the `/annotation/frames/bulk-classify` and `/annotation/frames/bulk-clear-classification` generated paths (Task 3).
- Produces: `useBulkClassifyFrames(sequenceId: number)` returning a `useMutation` whose `mutate`/`mutateAsync` takes `{ frameIds: number[]; labelId: number }` and invalidates `["annotations", frameId]` for every affected frame plus `["frames", sequenceId]`. `useBulkClearClassification(sequenceId: number)` returning a `useMutation` whose `mutate`/`mutateAsync` takes `{ frameIds: number[]; categoryId: number }`, same invalidation. Both used by Task 5's `SequenceGridPage`.

- [ ] **Step 1: Read the existing `useFrames.test.tsx` to confirm the test harness pattern**

Run: `cat frontend/src/entities/useFrames.test.tsx` — note how it wraps hooks in a `QueryClientProvider` and mocks `apiClient`. Reuse the same wrapper/mock setup in the new test file.

- [ ] **Step 2: Write the failing test**

Create `frontend/src/entities/useAnnotations.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../shared/api/client";
import { useBulkClassifyFrames, useBulkClearClassification } from "./useAnnotations";

vi.mock("../shared/api/client", () => ({
  apiClient: {
    POST: vi.fn(),
  },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useBulkClassifyFrames", () => {
  it("posts frame_ids and label_id to the bulk-classify endpoint", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({ data: { frame_ids: [1, 2] } } as never);

    const { result } = renderHook(() => useBulkClassifyFrames(10), { wrapper });
    result.current.mutate({ frameIds: [1, 2], labelId: 5 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiClient.POST).toHaveBeenCalledWith("/annotation/frames/bulk-classify", {
      body: { frame_ids: [1, 2], label_id: 5 },
    });
  });
});

describe("useBulkClearClassification", () => {
  it("posts frame_ids and category_id to the bulk-clear-classification endpoint", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({ data: { frame_ids: [1, 2] } } as never);

    const { result } = renderHook(() => useBulkClearClassification(10), { wrapper });
    result.current.mutate({ frameIds: [1, 2], categoryId: 3 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiClient.POST).toHaveBeenCalledWith("/annotation/frames/bulk-clear-classification", {
      body: { frame_ids: [1, 2], category_id: 3 },
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/entities/useAnnotations.test.tsx`
Expected: FAIL — `useBulkClassifyFrames`/`useBulkClearClassification` are not exported.

- [ ] **Step 4: Implement the two hooks**

Add to `frontend/src/entities/useAnnotations.ts`:

```ts
export function useBulkClassifyFrames(sequenceId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ frameIds, labelId }: { frameIds: number[]; labelId: number }) => {
      const result = await apiClient.POST("/annotation/frames/bulk-classify", {
        body: { frame_ids: frameIds, label_id: labelId },
      });
      return result.data;
    },
    onSuccess: (_data, variables) => {
      for (const frameId of variables.frameIds) {
        queryClient.invalidateQueries({ queryKey: ["annotations", frameId] });
      }
      queryClient.invalidateQueries({ queryKey: ["frames", sequenceId] });
    },
  });
}

export function useBulkClearClassification(sequenceId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ frameIds, categoryId }: { frameIds: number[]; categoryId: number }) => {
      const result = await apiClient.POST("/annotation/frames/bulk-clear-classification", {
        body: { frame_ids: frameIds, category_id: categoryId },
      });
      return result.data;
    },
    onSuccess: (_data, variables) => {
      for (const frameId of variables.frameIds) {
        queryClient.invalidateQueries({ queryKey: ["annotations", frameId] });
      }
      queryClient.invalidateQueries({ queryKey: ["frames", sequenceId] });
    },
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/entities/useAnnotations.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/entities/useAnnotations.ts frontend/src/entities/useAnnotations.test.tsx
git commit -m "feat: add bulk classify/clear mutation hooks"
```

---

### Task 5: Frontend — toolbar Category/Label controls

**Files:**
- Modify: `frontend/src/features/annotation/SequenceGridToolbar.tsx`
- Test: `frontend/src/features/annotation/SequenceGridToolbar.test.tsx`

**Interfaces:**
- Consumes: `components["schemas"]["TaxonomyTreeNode"]` (existing generated type, shape: `{ category: {id, name, procedure_id}, evaluation_types: [{ evaluation_type: {id, name}, labels: [{id, name, color, category_id, evaluation_type_id, taxonomy_version, created_at}] }] }`).
- Produces: new props on `SequenceGridToolbarProps`: `taxonomyTree: TaxonomyTreeNode[]`, `frameClassificationEvaluationTypeName: string` (the name to filter by — `"Frame classification"`, passed as a prop rather than hardcoded so the component stays taxonomy-name-agnostic and testable), `onAssignClassification: (labelId: number) => void`, `onClearClassification: (categoryId: number) => void`. Used by Task 6's `SequenceGridPage`.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/features/annotation/SequenceGridToolbar.test.tsx`:

```tsx
const sampleTaxonomyTree = [
  {
    category: { id: 1, name: "Landmark", procedure_id: 1 },
    evaluation_types: [
      {
        evaluation_type: { id: 9, name: "Frame classification" },
        labels: [
          { id: 101, name: "antrum", color: "#ff0000", category_id: 1, evaluation_type_id: 9, taxonomy_version: 1, created_at: "2026-01-01T00:00:00Z" },
          { id: 102, name: "ge_junction", color: "#00ff00", category_id: 1, evaluation_type_id: 9, taxonomy_version: 1, created_at: "2026-01-01T00:00:00Z" },
        ],
      },
    ],
  },
  {
    category: { id: 2, name: "Quality", procedure_id: 1 },
    evaluation_types: [
      {
        evaluation_type: { id: 9, name: "Frame classification" },
        labels: [
          { id: 201, name: "low_quality", color: "#0000ff", category_id: 2, evaluation_type_id: 9, taxonomy_version: 1, created_at: "2026-01-01T00:00:00Z" },
        ],
      },
    ],
  },
];

describe("SequenceGridToolbar classification controls", () => {
  it("hides classification controls when not in select mode", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode={false}
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        taxonomyTree={sampleTaxonomyTree}
        frameClassificationEvaluationTypeName="Frame classification"
        onAssignClassification={() => {}}
        onClearClassification={() => {}}
      />,
    );

    expect(screen.queryByLabelText("Classification category")).not.toBeInTheDocument();
  });

  it("populates the label select from the chosen category", async () => {
    const user = userEvent.setup();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={2}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        taxonomyTree={sampleTaxonomyTree}
        frameClassificationEvaluationTypeName="Frame classification"
        onAssignClassification={() => {}}
        onClearClassification={() => {}}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Classification category"), "1");

    expect(screen.getByRole("option", { name: "antrum" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "ge_junction" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "low_quality" })).not.toBeInTheDocument();
  });

  it("calls onAssignClassification with the chosen label id when Assign is clicked", async () => {
    const user = userEvent.setup();
    const onAssignClassification = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={2}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        taxonomyTree={sampleTaxonomyTree}
        frameClassificationEvaluationTypeName="Frame classification"
        onAssignClassification={onAssignClassification}
        onClearClassification={() => {}}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Classification category"), "1");
    await user.selectOptions(screen.getByLabelText("Classification label"), "102");
    await user.click(screen.getByRole("button", { name: "Assign" }));

    expect(onAssignClassification).toHaveBeenCalledWith(102);
  });

  it("disables Assign until both a category and a label are chosen", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={2}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        taxonomyTree={sampleTaxonomyTree}
        frameClassificationEvaluationTypeName="Frame classification"
        onAssignClassification={() => {}}
        onClearClassification={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Assign" })).toBeDisabled();
  });

  it("calls onClearClassification with the chosen category id when Clear is clicked", async () => {
    const user = userEvent.setup();
    const onClearClassification = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={2}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        taxonomyTree={sampleTaxonomyTree}
        frameClassificationEvaluationTypeName="Frame classification"
        onAssignClassification={() => {}}
        onClearClassification={onClearClassification}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Classification category"), "2");
    await user.click(screen.getByRole("button", { name: "Clear" }));

    expect(onClearClassification).toHaveBeenCalledWith(2);
  });

  it("disables Assign and Clear when there is no selection", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        taxonomyTree={sampleTaxonomyTree}
        frameClassificationEvaluationTypeName="Frame classification"
        onAssignClassification={() => {}}
        onClearClassification={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Assign" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/annotation/SequenceGridToolbar.test.tsx`
Expected: FAIL — `taxonomyTree`/`onAssignClassification`/etc. are not recognized props, "Classification category" label not found.

- [ ] **Step 3: Implement the toolbar controls**

Modify `frontend/src/features/annotation/SequenceGridToolbar.tsx`:

```tsx
import { useMemo, useState } from "react";

import type { components } from "../../shared/api/generated/schema";

type TaxonomyTreeNode = components["schemas"]["TaxonomyTreeNode"];

interface SequenceGridToolbarProps {
  sequenceName: string;
  isSelectMode: boolean;
  onToggleSelectMode: () => void;
  selectedCount: number;
  onDeleteSelected: () => void;
  onCancel: () => void;
  qualityPercent?: number;
  onQualityPercentChange?: (value: number) => void;
  onRankQuality?: () => void;
  isRankQualityRunning?: boolean;
  similarityPercent?: number;
  onSimilarityPercentChange?: (value: number) => void;
  onFindSimilar?: () => void;
  isFindSimilarRunning?: boolean;
  hasAutoMarks?: boolean;
  onClearMarks?: () => void;
  taxonomyTree?: TaxonomyTreeNode[];
  frameClassificationEvaluationTypeName?: string;
  onAssignClassification?: (labelId: number) => void;
  onClearClassification?: (categoryId: number) => void;
}

export function SequenceGridToolbar({
  sequenceName,
  isSelectMode,
  onToggleSelectMode,
  selectedCount,
  onDeleteSelected,
  onCancel,
  qualityPercent = 20,
  onQualityPercentChange = () => {},
  onRankQuality = () => {},
  isRankQualityRunning = false,
  similarityPercent = 85,
  onSimilarityPercentChange = () => {},
  onFindSimilar = () => {},
  isFindSimilarRunning = false,
  hasAutoMarks = false,
  onClearMarks = () => {},
  taxonomyTree = [],
  frameClassificationEvaluationTypeName = "Frame classification",
  onAssignClassification = () => {},
  onClearClassification = () => {},
}: SequenceGridToolbarProps) {
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [selectedLabelId, setSelectedLabelId] = useState<number | null>(null);

  const classificationCategories = useMemo(
    () =>
      taxonomyTree
        .map((node) => ({
          category: node.category,
          labels: node.evaluation_types.find(
            (evaluationTypeNode) =>
              evaluationTypeNode.evaluation_type.name === frameClassificationEvaluationTypeName,
          )?.labels ?? [],
        }))
        .filter((entry) => entry.labels.length > 0),
    [taxonomyTree, frameClassificationEvaluationTypeName],
  );

  const labelsForSelectedCategory =
    classificationCategories.find((entry) => entry.category.id === selectedCategoryId)?.labels ?? [];

  function handleCategoryChange(rawValue: string) {
    const parsed = Number(rawValue);
    setSelectedCategoryId(Number.isFinite(parsed) && rawValue !== "" ? parsed : null);
    setSelectedLabelId(null);
  }

  function handleLabelChange(rawValue: string) {
    const parsed = Number(rawValue);
    setSelectedLabelId(Number.isFinite(parsed) && rawValue !== "" ? parsed : null);
  }

  function handleAssignClick() {
    if (selectedLabelId !== null) {
      onAssignClassification(selectedLabelId);
    }
  }

  function handleClearClassificationClick() {
    if (selectedCategoryId !== null) {
      onClearClassification(selectedCategoryId);
    }
  }

  function handleDeleteClick() {
    if (deleteArmed) {
      onDeleteSelected();
      setDeleteArmed(false);
    } else {
      setDeleteArmed(true);
    }
  }

  function handleCancelClick() {
    setDeleteArmed(false);
    onCancel();
  }

  function handleQualityPercentChange(rawValue: string) {
    const parsed = Number(rawValue);
    const clamped = Math.min(99, Math.max(1, Number.isFinite(parsed) ? parsed : 1));
    onQualityPercentChange(clamped);
  }

  function handleSimilarityPercentChange(rawValue: string) {
    const parsed = Number(rawValue);
    const clamped = Math.min(99, Math.max(1, Number.isFinite(parsed) ? parsed : 1));
    onSimilarityPercentChange(clamped);
  }

  return (
    <div className="flex items-center gap-4 border-b border-gray-800 px-8 py-4">
      <h1 className="text-xl font-semibold">{sequenceName}</h1>
      <div className="ml-auto flex items-center gap-3">
        {isSelectMode && (
          <>
            <select
              aria-label="Classification category"
              value={selectedCategoryId ?? ""}
              onChange={(event) => handleCategoryChange(event.target.value)}
              className="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-200"
            >
              <option value="">Category…</option>
              {classificationCategories.map((entry) => (
                <option key={entry.category.id} value={entry.category.id}>
                  {entry.category.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Classification label"
              value={selectedLabelId ?? ""}
              onChange={(event) => handleLabelChange(event.target.value)}
              disabled={selectedCategoryId === null}
              className="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-200 disabled:opacity-40"
            >
              <option value="">Label…</option>
              {labelsForSelectedCategory.map((label) => (
                <option key={label.id} value={label.id}>
                  {label.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label="Assign"
              onClick={handleAssignClick}
              disabled={selectedLabelId === null || selectedCount === 0}
              className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-40"
            >
              Assign
            </button>
            <button
              type="button"
              aria-label="Clear"
              onClick={handleClearClassificationClick}
              disabled={selectedCategoryId === null || selectedCount === 0}
              className="rounded px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 disabled:opacity-40"
            >
              Clear
            </button>
            <input
              type="number"
              aria-label="Quality percent"
              min={1}
              max={99}
              value={qualityPercent}
              onChange={(event) => handleQualityPercentChange(event.target.value)}
              className="w-16 rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-200"
            />
            <button
              type="button"
              aria-label="Rank Quality"
              onClick={onRankQuality}
              disabled={isRankQualityRunning}
              className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-40"
            >
              {isRankQualityRunning ? "Ranking…" : "Rank Quality"}
            </button>
            <input
              type="number"
              aria-label="Similarity percent"
              min={1}
              max={99}
              value={similarityPercent}
              onChange={(event) => handleSimilarityPercentChange(event.target.value)}
              className="w-16 rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-200"
            />
            <button
              type="button"
              aria-label="Find Similar"
              onClick={onFindSimilar}
              disabled={isFindSimilarRunning}
              className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-40"
            >
              {isFindSimilarRunning ? "Finding…" : "Find Similar"}
            </button>
            {hasAutoMarks && (
              <button
                type="button"
                aria-label="Clear marks"
                onClick={onClearMarks}
                className="rounded px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200"
              >
                Clear marks
              </button>
            )}
            <span className="text-sm text-gray-400">{selectedCount} selected</span>
            <button
              type="button"
              aria-label={deleteArmed ? "Confirm delete" : "Delete selected"}
              onClick={handleDeleteClick}
              disabled={selectedCount === 0}
              className={`rounded px-3 py-1.5 text-sm ${
                deleteArmed
                  ? "bg-red-700 text-white"
                  : "bg-gray-800 text-gray-200 hover:bg-gray-700 disabled:opacity-40"
              }`}
            >
              {deleteArmed ? "Confirm" : "🗑 Delete"}
            </button>
            <button
              type="button"
              aria-label="Cancel"
              onClick={handleCancelClick}
              className="rounded px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200"
            >
              ✕ Cancel
            </button>
          </>
        )}
        {!isSelectMode && (
          <button
            type="button"
            aria-label="Select"
            onClick={onToggleSelectMode}
            className="rounded bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700"
          >
            Select
          </button>
        )}
      </div>
    </div>
  );
}
```

Note: the `aria-label`s use "Assign"/"Clear" as both the label and the visible button text — the tests above query by `getByRole("button", { name: "Assign" })`, which matches on accessible name (text content), so the explicit `aria-label` is redundant with the button text but kept for consistency with the rest of this file's button style.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/annotation/SequenceGridToolbar.test.tsx`
Expected: PASS (all tests, old and new)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/annotation/SequenceGridToolbar.tsx frontend/src/features/annotation/SequenceGridToolbar.test.tsx
git commit -m "feat: add classification category/label controls to sequence grid toolbar"
```

---

### Task 6: Frontend — wire `SequenceGridPage` to the new toolbar controls and mutations

**Files:**
- Modify: `frontend/src/features/annotation/SequenceGridPage.tsx`
- Test: `frontend/src/features/annotation/SequenceGridPage.test.tsx`

**Interfaces:**
- Consumes: `useBulkClassifyFrames`/`useBulkClearClassification` (Task 4), the new `SequenceGridToolbar` props (Task 5), the existing `taxonomyTree` (already loaded in this file via `useTaxonomyTree`), existing `selectedFrameIds`.
- Produces: none further downstream — this is the top-level integration task.

- [ ] **Step 1: Read the existing `SequenceGridPage.test.tsx` to confirm the test harness/mocking pattern**

Run: `cat frontend/src/features/annotation/SequenceGridPage.test.tsx` — note how `useFrames`/`useSequence`/`useTaxonomyTree`/`useDeleteFrames` etc. are mocked with `vi.mock`.

- [ ] **Step 2: Write the failing test**

Add to `frontend/src/features/annotation/SequenceGridPage.test.tsx` (adapt the existing mock setup at the top of that file to also mock `useBulkClassifyFrames`/`useBulkClearClassification` from `../../entities/useAnnotations`, and to have `useTaxonomyTree` return a tree with a "Frame classification" evaluation type node, following the same shape used in Task 5's `sampleTaxonomyTree`):

```tsx
it("calls bulk-classify with the current selection when Assign is used", async () => {
  const user = userEvent.setup();
  const mutateAssign = vi.fn();
  vi.mocked(useBulkClassifyFrames).mockReturnValue({
    mutate: mutateAssign,
    isPending: false,
  } as never);

  render(<SequenceGridPage />, { wrapper: RouterWrapper });

  await user.click(screen.getByRole("button", { name: "Select" }));
  // select two frame checkboxes -- reuse whatever selector the existing
  // "selects frames" test in this file uses for locating a thumbnail checkbox
  const checkboxes = screen.getAllByRole("checkbox");
  await user.click(checkboxes[0]);
  await user.click(checkboxes[1]);

  await user.selectOptions(screen.getByLabelText("Classification category"), "1");
  await user.selectOptions(screen.getByLabelText("Classification label"), "101");
  await user.click(screen.getByRole("button", { name: "Assign" }));

  expect(mutateAssign).toHaveBeenCalledWith(
    expect.objectContaining({ labelId: 101 }),
    expect.anything(),
  );
});
```

Adjust the exact mocked-frame-list/checkbox-lookup details to match whatever fixture data the existing test file already sets up for `useFrames` — this file's existing tests already exercise checkbox selection for the Delete flow, so mirror that setup rather than inventing new fixture frames.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/features/annotation/SequenceGridPage.test.tsx`
Expected: FAIL — `Classification category` control not rendered (toolbar not receiving `taxonomyTree`/handlers yet), or `useBulkClassifyFrames` not called.

- [ ] **Step 4: Wire up `SequenceGridPage.tsx`**

Modify `frontend/src/features/annotation/SequenceGridPage.tsx`:

1. Add the import:

```ts
import { useBulkClassifyFrames, useBulkClearClassification } from "../../entities/useAnnotations";
```

2. Inside the component, alongside the other mutation hooks:

```ts
const bulkClassifyFrames = useBulkClassifyFrames(sequenceIdNumber);
const bulkClearClassification = useBulkClearClassification(sequenceIdNumber);
```

3. Add two handlers, near `handleDeleteSelected`:

```ts
function handleAssignClassification(labelId: number) {
  bulkClassifyFrames.mutate({ frameIds: Array.from(selectedFrameIds), labelId });
}

function handleClearClassification(categoryId: number) {
  bulkClearClassification.mutate({ frameIds: Array.from(selectedFrameIds), categoryId });
}
```

4. Pass the new props to `<SequenceGridToolbar>`:

```tsx
<SequenceGridToolbar
  sequenceName={sequenceName}
  isSelectMode={isSelectMode}
  onToggleSelectMode={() => setIsSelectMode((current) => !current)}
  selectedCount={selectedFrameIds.size}
  onDeleteSelected={handleDeleteSelected}
  onCancel={handleCancelSelectMode}
  qualityPercent={qualityPercent}
  onQualityPercentChange={setQualityPercent}
  onRankQuality={handleRankQuality}
  isRankQualityRunning={activeJobKind === "quality"}
  similarityPercent={similarityPercent}
  onSimilarityPercentChange={setSimilarityPercent}
  onFindSimilar={handleFindSimilar}
  isFindSimilarRunning={activeJobKind === "similarity"}
  hasAutoMarks={autoCheckedFrameIds.size > 0}
  onClearMarks={handleClearMarks}
  taxonomyTree={taxonomyTree}
  frameClassificationEvaluationTypeName="Frame classification"
  onAssignClassification={handleAssignClassification}
  onClearClassification={handleClearClassification}
/>
```

(`taxonomyTree` is already computed in this file at line 30 as `taxonomyTreeQuery.data ?? []` — no new query needed.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/features/annotation/SequenceGridPage.test.tsx`
Expected: PASS (all tests, old and new)

- [ ] **Step 6: Run the full frontend test suite**

Run: `cd frontend && npm run test`
Expected: PASS (no regressions)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/annotation/SequenceGridPage.tsx frontend/src/features/annotation/SequenceGridPage.test.tsx
git commit -m "feat: wire sequence grid page to bulk classify/clear mutations"
```

---

### Task 7: Real-stack manual verification

**Files:** none (verification only, per `CLAUDE.md`'s testing philosophy — backend `TestClient` and mocked frontend unit tests can't catch cross-origin, persistence, or real-taxonomy-data issues).

**Interfaces:** none — this task consumes the finished feature end-to-end.

- [ ] **Step 1: Start the full stack**

```bash
docker compose up -d
cd backend && uv run uvicorn app.main:app --reload
cd frontend && npm run dev
```

- [ ] **Step 2: Create the taxonomy via the Tags screen**

Log in (per memory: `manualcheck@example.com` is the standing manual-verification login, or register a fresh account). In the Tags screen, create:
- An `EvaluationType` named exactly `Frame classification`.
- A `Category` named `Landmark` with labels `antrum`, `ge_junction` (distinct colors).
- A `Category` named `Quality` with labels `low_quality`, `good_quality` (distinct colors).

- [ ] **Step 3: Exercise Assign across two categories on the same frames**

Open a sequence with frames, click Select, check 2-3 frames, choose Category=`Landmark`, Label=`antrum`, click Assign. Confirm the badge appears on those thumbnails with the `antrum` label's color. Without unchecking, choose Category=`Quality`, Label=`low_quality`, click Assign. Confirm each of those frames now shows *two* badges (Landmark + Quality) simultaneously.

- [ ] **Step 4: Exercise same-category replace**

With the same frames still checked, choose Category=`Landmark`, Label=`ge_junction`, click Assign. Confirm the `antrum` badge is replaced by `ge_junction` on those frames, and the `low_quality` badge from Step 3 is untouched.

- [ ] **Step 5: Exercise Clear**

Choose Category=`Landmark` (no label needed), click Clear. Confirm the `ge_junction` badge disappears from the selected frames while the `low_quality` badge remains.

- [ ] **Step 6: Confirm persistence across reload**

Reload the page. Confirm all remaining badges (from Step 5) are still present, proving they're read from the database via `GET /annotation/frames/{frame_id}/annotations`, not just client-side state.

- [ ] **Step 7: Report results**

Summarize pass/fail for each step above in the final report to the user — do not claim the feature works without having completed Steps 1-6 against the real running stack.
