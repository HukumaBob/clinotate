# Sequence Grid Select-and-Delete-Frames Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sticky toolbar to the sequence grid page (`/sequences/:id`) showing the sequence's real name, with a "Select" mode that lets the user check individual frame thumbnails and batch-delete them (cascading their annotations) via a trash-icon action.

**Architecture:** One new backend batch-delete endpoint (`DELETE /media/sequences/{sequence_id}/frames`) that cascades annotation + frame storage cleanup in a single transaction. On the frontend, `SequenceGridPage` owns select-mode state (`isSelectMode`, `selectedFrameIds`) and renders a new sticky `SequenceGridToolbar` component plus passes selection props down into the existing `FrameThumbnail`.

**Tech Stack:** FastAPI + SQLAlchemy + boto3/MinIO (backend), React + TanStack Query + Tailwind (frontend), pytest (backend tests, real `TestClient` + real MinIO, no mocking), Vitest + Testing Library (frontend tests, `apiClient` mocked).

## Global Constraints

- Language: English only in code, comments, docstrings, UI copy — no Russian in committed content.
- UI theme: dark only — don't introduce light-background classes.
- API contract: use `apiClient` from `frontend/src/shared/api/client.ts`; never hand-roll `fetch()`. Don't hand-edit `frontend/src/shared/api/generated/`.
- TDD: every task writes a failing test before the implementation.
- Deleting a frame cascades its annotations (including their storage-key mask files) and the frame's own storage-key image — this is a deliberate design choice (see spec's Non-goals): no undo, no confirmation beyond the toolbar's own click-to-arm trash button.
- After the backend route is added, regenerate the committed `openapi.json` (`cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py` from repo root) before the frontend tasks can use the new generated types.

---

## Task 1: Backend batch-delete-frames endpoint

**Files:**
- Modify: `backend/app/media/schemas.py` (add `FrameBulkDelete`)
- Modify: `backend/app/media/router.py` (add route)
- Modify: `backend/tests/test_media.py` (add tests)

**Interfaces:**
- Produces: `DELETE /media/sequences/{sequence_id}/frames` accepting a JSON body `{"frame_ids": [1, 2, 3]}` (schema `FrameBulkDelete`), returning `200 OK` with `{"deleted_ids": [1, 2, 3]}` — only ids that were found under that `sequence_id` and actually deleted.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_media.py`:

```python
def _create_label_for_delete_tests(headers: dict[str, str], suffix: str) -> int:
    # Mirrors test_delete_video_derived_sequence_with_annotations_returns_409's
    # get-or-create pattern: Procedure/Category/EvaluationType creation 500s
    # on a unique-constraint collision instead of returning a JSON error, so
    # look each up first rather than assuming a fresh POST will succeed.
    procedures = client.get("/taxonomy/procedures", headers=headers).json()
    procedure = next((p for p in procedures if p["name"] == f"frame-delete-procedure-{suffix}"), None)
    if procedure is None:
        procedure = client.post(
            "/taxonomy/procedures", json={"name": f"frame-delete-procedure-{suffix}"}, headers=headers
        ).json()

    categories = client.get(f"/taxonomy/categories?procedure_id={procedure['id']}", headers=headers).json()
    category = next((c for c in categories if c["name"] == f"frame-delete-category-{suffix}"), None)
    if category is None:
        category = client.post(
            "/taxonomy/categories",
            json={"name": f"frame-delete-category-{suffix}", "procedure_id": procedure["id"]},
            headers=headers,
        ).json()

    evaluation_types = client.get("/taxonomy/evaluation-types", headers=headers).json()
    evaluation_type = next(
        (e for e in evaluation_types if e["name"] == f"frame-delete-evaluation-type-{suffix}"), None
    )
    if evaluation_type is None:
        evaluation_type = client.post(
            "/taxonomy/evaluation-types", json={"name": f"frame-delete-evaluation-type-{suffix}"}, headers=headers
        ).json()

    return client.post(
        "/taxonomy/labels",
        json={
            "name": f"Frame-delete label {suffix}",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=headers,
    ).json()["id"]


def test_bulk_delete_frame_removes_frame_and_cascades_mask_annotation():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "bulk-delete-frame-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos",
            files={"file": ("bulk_delete.mp4", f, "video/mp4")},
            data={"title": "Bulk delete source", "procedure_id": procedure_id},
            headers=headers,
        ).json()["id"]
    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "Bulk delete seq", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]
    frame_id = client.get(f"/media/sequences/{sequence_id}/frames", headers=headers).json()[0]["id"]
    label_id = _create_label_for_delete_tests(headers, "mask-cascade")

    # The API can only create CLASSIFICATION-type annotations (no storage_key
    # / mask file) -- create_classification_annotation in
    # app/annotation/service.py always sets storage_key=None. To exercise
    # the mask-file cleanup path this endpoint must perform, build a MASK
    # annotation with a real uploaded storage object directly via the ORM,
    # mirroring test_sequence_can_be_created_without_a_video's direct-session
    # pattern for state the HTTP API cannot produce.
    from app.annotation.models import Annotation, AnnotationType
    from app.db import SessionLocal
    from app.storage import get_storage_service

    storage = get_storage_service()
    mask_key = f"masks/test/{frame_id}-bulk-delete.png"
    storage.upload(mask_key, b"fake-mask-bytes", "image/png")

    session = SessionLocal()
    try:
        user_id = session.execute(
            __import__("sqlalchemy").text("SELECT id FROM users WHERE email = :email"),
            {"email": "media1@example.com"},
        ).scalar_one()
        annotation = Annotation(
            frame_id=frame_id,
            label_id=label_id,
            taxonomy_version=1,
            annotation_type=AnnotationType.MASK,
            payload={},
            storage_key=mask_key,
            created_by_id=user_id,
        )
        session.add(annotation)
        session.commit()
        annotation_id = annotation.id
    finally:
        session.close()

    response = client.request(
        "DELETE",
        f"/media/sequences/{sequence_id}/frames",
        json={"frame_ids": [frame_id]},
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json() == {"deleted_ids": [frame_id]}

    # Frame gone
    assert client.get(f"/media/frames/{frame_id}", headers=headers).status_code == 404

    # Annotation row gone
    session = SessionLocal()
    try:
        assert session.get(Annotation, annotation_id) is None
    finally:
        session.close()

    # Mask storage object gone
    import pytest
    from botocore.exceptions import ClientError

    with pytest.raises(ClientError):
        storage.download(mask_key)


def test_bulk_delete_frames_silently_skips_nonexistent_and_foreign_ids():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "bulk-delete-skip-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos",
            files={"file": ("bulk_delete_skip.mp4", f, "video/mp4")},
            data={"title": "Bulk delete skip source", "procedure_id": procedure_id},
            headers=headers,
        ).json()["id"]
    sequence_a = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "Skip seq A", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]
    sequence_b = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "Skip seq B", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]
    frame_a_id = client.get(f"/media/sequences/{sequence_a}/frames", headers=headers).json()[0]["id"]
    frame_b_id = client.get(f"/media/sequences/{sequence_b}/frames", headers=headers).json()[0]["id"]

    response = client.request(
        "DELETE",
        f"/media/sequences/{sequence_a}/frames",
        json={"frame_ids": [frame_a_id, frame_b_id, 999999999]},
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json() == {"deleted_ids": [frame_a_id]}
    # frame_b (different sequence) survives
    assert client.get(f"/media/frames/{frame_b_id}", headers=headers).status_code == 200


def test_bulk_delete_frame_with_no_annotations_succeeds():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "bulk-delete-no-annotation-procedure"}, headers=headers
    ).json()["id"]
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos",
            files={"file": ("bulk_delete_no_annotation.mp4", f, "video/mp4")},
            data={"title": "Bulk delete no-annotation source", "procedure_id": procedure_id},
            headers=headers,
        ).json()["id"]
    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "No-annotation seq", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]
    frame_id = client.get(f"/media/sequences/{sequence_id}/frames", headers=headers).json()[0]["id"]

    response = client.request(
        "DELETE",
        f"/media/sequences/{sequence_id}/frames",
        json={"frame_ids": [frame_id]},
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json() == {"deleted_ids": [frame_id]}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_media.py -k bulk_delete -v`
Expected: FAIL — `404 Not Found` (route doesn't exist yet) or similar, since `DELETE /media/sequences/{sequence_id}/frames` isn't registered.

- [ ] **Step 3: Add the `FrameBulkDelete` schema**

In `backend/app/media/schemas.py`, add (near `FrameRead` at the bottom of the file):

```python
class FrameBulkDelete(BaseModel):
    frame_ids: list[int]


class FrameBulkDeleteResult(BaseModel):
    deleted_ids: list[int]
```

- [ ] **Step 4: Add the route**

In `backend/app/media/router.py`, add near the other delete routes (after `delete_sequence`). First check the top-of-file imports already include `Annotation` — if not, add `from app.annotation.models import Annotation` (the existing `delete_sequence` route already imports and uses `Annotation` for its own annotation-count check, so this import should already be present; verify before adding a duplicate).

```python
@router.delete("/sequences/{sequence_id}/frames", response_model=FrameBulkDeleteResult)
def bulk_delete_frames(
    sequence_id: int,
    payload: FrameBulkDelete,
    session: Session = Depends(get_session),
    storage: StorageService = Depends(get_storage_service),
) -> FrameBulkDeleteResult:
    frames = (
        session.query(Frame)
        .filter(Frame.id.in_(payload.frame_ids), Frame.sequence_id == sequence_id)
        .all()
    )
    deleted_ids: list[int] = []
    for frame in frames:
        annotations = session.query(Annotation).filter(Annotation.frame_id == frame.id).all()
        for annotation in annotations:
            if annotation.storage_key:
                storage.delete(annotation.storage_key)
            session.delete(annotation)
        storage.delete(frame.storage_key)
        session.delete(frame)
        deleted_ids.append(frame.id)
    session.commit()
    return FrameBulkDeleteResult(deleted_ids=deleted_ids)
```

Add `FrameBulkDelete` and `FrameBulkDeleteResult` to the existing `from app.media.schemas import (...)` import block at the top of `router.py`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_media.py -k bulk_delete -v`
Expected: PASS (3 tests)

- [ ] **Step 6: Run the full backend test suite to confirm no regression**

Run: `cd backend && uv run pytest`
Expected: PASS across all files. If you see unrelated 409s or duplicate-row failures, per CLAUDE.md this may be pre-existing dev-DB state from prior runs, not a defect in this change — do not truncate the database yourself; report it instead of working around it silently.

- [ ] **Step 7: Regenerate the committed OpenAPI schema**

Run (from repo root): `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`
Then verify: `git diff --stat openapi.json` shows a change (the new route should appear).

- [ ] **Step 8: Commit**

```bash
git add backend/app/media/schemas.py backend/app/media/router.py backend/tests/test_media.py openapi.json
git commit -m "feat: add batch frame-delete endpoint that cascades annotation cleanup"
```

---

## Task 2: `useDeleteFrames` frontend hook

**Files:**
- Modify: `frontend/src/entities/useFrames.ts`
- Create: `frontend/src/entities/useFrames.test.tsx`

**Interfaces:**
- Consumes: the Task 1 endpoint `DELETE /media/sequences/{sequence_id}/frames` with body `{frame_ids: number[]}`, response `{deleted_ids: number[]}`. Requires `openapi.json`/generated types from Task 1 to already include this route — if `npm run generate-api` (run automatically by `pretest`) doesn't pick up the new route, re-run Task 1's Step 7 first.
- Produces: `useDeleteFrames(sequenceId: number)` — a `useMutation` whose `mutationFn` takes `frameIds: number[]` and returns `{deleted_ids: number[]} | undefined`. On success, invalidates the `["frames", sequenceId]` query key (the same key `useFrames` in this file already uses).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/entities/useFrames.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../shared/api/client";
import { useDeleteFrames } from "./useFrames";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), DELETE: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useDeleteFrames", () => {
  afterEach(() => vi.clearAllMocks());

  it("calls the bulk-delete endpoint with the sequence id and frame ids", async () => {
    vi.mocked(apiClient.DELETE).mockResolvedValue({
      data: { deleted_ids: [1, 2] },
      error: undefined,
    } as never);

    const { result } = renderHook(() => useDeleteFrames(9), { wrapper });

    result.current.mutate([1, 2]);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiClient.DELETE).toHaveBeenCalledWith(
      "/media/sequences/{sequence_id}/frames",
      expect.objectContaining({
        params: { path: { sequence_id: 9 } },
        body: { frame_ids: [1, 2] },
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/entities/useFrames.test.tsx`
Expected: FAIL — `useDeleteFrames` is not exported from `./useFrames`.

- [ ] **Step 3: Write minimal implementation**

Add to `frontend/src/entities/useFrames.ts` (after the existing `useFrame` function; add `useMutation` and `useQueryClient` to the existing `import { useQuery } from "@tanstack/react-query";` line, changing it to `import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";`):

```ts
export function useDeleteFrames(sequenceId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (frameIds: number[]) => {
      const result = await apiClient.DELETE("/media/sequences/{sequence_id}/frames", {
        params: { path: { sequence_id: sequenceId } },
        body: { frame_ids: frameIds },
      });
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["frames", sequenceId] });
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/entities/useFrames.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/entities/useFrames.ts frontend/src/entities/useFrames.test.tsx
git commit -m "feat: add useDeleteFrames mutation hook"
```

---

## Task 3: `FrameThumbnail` select-mode checkbox

**Files:**
- Modify: `frontend/src/features/annotation/FrameThumbnail.tsx`
- Modify: `frontend/src/features/annotation/FrameThumbnail.test.tsx`

**Interfaces:**
- Produces: `FrameThumbnail` gains three new props: `selectable: boolean`, `selected: boolean`, `onToggleSelect: () => void`. Existing props (`frameId`, `imageUrl`, `taxonomyTree`, `onClick`) are unchanged. Consumed by Task 5 (`SequenceGridPage`).

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/features/annotation/FrameThumbnail.test.tsx` (inside the existing `describe` block; note the existing tests all call `<FrameThumbnail ... onClick={() => {}} />` without the three new props — since they're being added as required props, update every existing render call in this file to also pass `selectable={false} selected={false} onToggleSelect={() => {}}`, otherwise TypeScript will fail to compile the existing tests once Step 3 lands):

```tsx
  it("in selectable mode, renders a checkbox reflecting the selected prop", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [], error: undefined } as never);

    render(
      <FrameThumbnail
        frameId={5}
        imageUrl="http://example.com/frame.png"
        taxonomyTree={TAXONOMY_TREE}
        onClick={() => {}}
        selectable
        selected
        onToggleSelect={() => {}}
      />,
      { wrapper },
    );

    await screen.findByAltText("Frame 5");
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeChecked();
  });

  it("in selectable mode, clicking the card calls onToggleSelect instead of onClick", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [], error: undefined } as never);
    const onClick = vi.fn();
    const onToggleSelect = vi.fn();

    render(
      <FrameThumbnail
        frameId={5}
        imageUrl="http://example.com/frame.png"
        taxonomyTree={TAXONOMY_TREE}
        onClick={onClick}
        selectable
        selected={false}
        onToggleSelect={onToggleSelect}
      />,
      { wrapper },
    );

    const img = await screen.findByAltText("Frame 5");
    img.closest("button")?.click();

    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("when not selectable, clicking the card calls onClick and renders no checkbox", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [], error: undefined } as never);
    const onClick = vi.fn();

    render(
      <FrameThumbnail
        frameId={5}
        imageUrl="http://example.com/frame.png"
        taxonomyTree={TAXONOMY_TREE}
        onClick={onClick}
        selectable={false}
        selected={false}
        onToggleSelect={() => {}}
      />,
      { wrapper },
    );

    const img = await screen.findByAltText("Frame 5");
    img.closest("button")?.click();

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/annotation/FrameThumbnail.test.tsx`
Expected: FAIL — TypeScript errors on missing required props on the pre-existing test calls, and the three new tests fail since `selectable`/`selected`/`onToggleSelect` aren't accepted/rendered yet.

- [ ] **Step 3: Write minimal implementation**

Replace `frontend/src/features/annotation/FrameThumbnail.tsx` with:

```tsx
import { useAnnotations } from "../../entities/useAnnotations";
import { resolveLabelFromTree } from "./resolveLabel";
import type { components } from "../../shared/api/generated/schema";

type TaxonomyTreeNode = components["schemas"]["TaxonomyTreeNode"];

const DEFAULT_MASK_COLOR = "#22d3ee";

interface FrameThumbnailProps {
  frameId: number;
  imageUrl: string;
  taxonomyTree: TaxonomyTreeNode[];
  onClick: () => void;
  selectable: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}

export function FrameThumbnail({
  frameId,
  imageUrl,
  taxonomyTree,
  onClick,
  selectable,
  selected,
  onToggleSelect,
}: FrameThumbnailProps) {
  const annotationsQuery = useAnnotations(frameId);
  const annotations = annotationsQuery.data ?? [];
  const maskAnnotations = annotations.filter((annotation) => annotation.mask_url);

  return (
    <button
      type="button"
      onClick={selectable ? onToggleSelect : onClick}
      className="group relative aspect-square overflow-hidden rounded border border-gray-800 bg-gray-900"
    >
      <img src={imageUrl} alt={`Frame ${frameId}`} className="h-full w-full object-contain" />
      {selectable && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          onClick={(event) => event.stopPropagation()}
          className="absolute left-2 top-2 h-5 w-5 accent-blue-500"
        />
      )}
      {maskAnnotations.map((annotation) => {
        const resolved = resolveLabelFromTree(taxonomyTree, annotation.label_id);
        const color = resolved?.tag.color ?? DEFAULT_MASK_COLOR;
        return (
          <div
            key={annotation.id}
            data-testid="mask-overlay"
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundColor: color,
              maskImage: `url(${annotation.mask_url})`,
              WebkitMaskImage: `url(${annotation.mask_url})`,
              maskMode: "luminance",
              WebkitMaskMode: "luminance" as never,
              maskSize: "contain",
              WebkitMaskSize: "contain",
              maskRepeat: "no-repeat",
              WebkitMaskRepeat: "no-repeat",
              maskPosition: "center",
              WebkitMaskPosition: "center",
              opacity: 0.45,
            }}
          />
        );
      })}
      {annotations.length > 0 && (
        <div className="absolute inset-x-0 bottom-0 flex flex-wrap gap-1 truncate bg-gray-950/80 px-1 py-0.5 text-xs text-gray-200">
          {annotations.map((annotation) => {
            const resolved = resolveLabelFromTree(taxonomyTree, annotation.label_id);
            const label = resolved ? `${resolved.categoryName} / ${resolved.tag.name}` : `label ${annotation.label_id}`;
            const color = resolved?.tag.color ?? "#666";
            return (
              <span key={annotation.id} className="flex items-center gap-1">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                {label}
              </span>
            );
          })}
        </div>
      )}
    </button>
  );
}
```

Note on the checkbox's `onClick` stopping propagation: the checkbox is a native `<input>` nested inside a `<button>`. In real browsers a checkbox click already toggles its own checked state and fires `onChange`; letting the click also bubble to the outer `<button>` would additionally fire the button's own `onClick` (double-toggling in the parent's state). `event.stopPropagation()` on the checkbox's `onClick` prevents that double-fire while still letting `onChange` run normally.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/annotation/FrameThumbnail.test.tsx`
Expected: PASS (9 tests total: 6 pre-existing + 3 new)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/annotation/FrameThumbnail.tsx frontend/src/features/annotation/FrameThumbnail.test.tsx
git commit -m "feat: add selectable checkbox mode to FrameThumbnail"
```

Note: this commit temporarily breaks `SequenceGridPage.tsx`'s call site (it renders `<FrameThumbnail>` without the three new required props) — fixed in Task 5, same transient-breakage situation as this plan's predecessor (the label-resolution plan's Task 2/Task 4 split).

---

## Task 4: `SequenceGridToolbar` component

**Files:**
- Create: `frontend/src/features/annotation/SequenceGridToolbar.tsx`
- Create: `frontend/src/features/annotation/SequenceGridToolbar.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  interface SequenceGridToolbarProps {
    sequenceName: string;
    isSelectMode: boolean;
    onToggleSelectMode: () => void;
    selectedCount: number;
    onDeleteSelected: () => void;
    onCancel: () => void;
  }
  export function SequenceGridToolbar(props: SequenceGridToolbarProps): JSX.Element
  ```
  Consumed by Task 5 (`SequenceGridPage`). This component owns only the click-to-arm confirmation state for the trash button internally — it does not know about frame ids or mutations; `onDeleteSelected` is called only once the user has confirmed (second click).

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/features/annotation/SequenceGridToolbar.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { SequenceGridToolbar } from "./SequenceGridToolbar";

describe("SequenceGridToolbar", () => {
  it("shows the sequence name, not a numeric id placeholder", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Colonoscopy run 4"
        isSelectMode={false}
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText("Colonoscopy run 4")).toBeInTheDocument();
  });

  it("hides select-mode controls (trash, cancel, count) when not in select mode", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode={false}
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
  });

  it("shows select-mode controls and the selected count when in select mode", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={3}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText(/3 selected/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("disables the delete button when selectedCount is 0", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /delete/i })).toBeDisabled();
  });

  it("requires two clicks on delete before calling onDeleteSelected (click-to-arm)", () => {
    const onDeleteSelected = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={2}
        onDeleteSelected={onDeleteSelected}
        onCancel={() => {}}
      />,
    );

    const deleteButton = screen.getByRole("button", { name: /delete/i });
    deleteButton.click();
    expect(onDeleteSelected).not.toHaveBeenCalled();

    screen.getByRole("button", { name: /confirm/i }).click();
    expect(onDeleteSelected).toHaveBeenCalledTimes(1);
  });

  it("calls onToggleSelectMode when the Select button is clicked", () => {
    const onToggleSelectMode = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode={false}
        onToggleSelectMode={onToggleSelectMode}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
      />,
    );

    screen.getByRole("button", { name: /select/i }).click();
    expect(onToggleSelectMode).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when the Cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={1}
        onDeleteSelected={() => {}}
        onCancel={onCancel}
      />,
    );

    screen.getByRole("button", { name: /cancel/i }).click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/annotation/SequenceGridToolbar.test.tsx`
Expected: FAIL — `SequenceGridToolbar.tsx` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/features/annotation/SequenceGridToolbar.tsx`:

```tsx
import { useState } from "react";

interface SequenceGridToolbarProps {
  sequenceName: string;
  isSelectMode: boolean;
  onToggleSelectMode: () => void;
  selectedCount: number;
  onDeleteSelected: () => void;
  onCancel: () => void;
}

export function SequenceGridToolbar({
  sequenceName,
  isSelectMode,
  onToggleSelectMode,
  selectedCount,
  onDeleteSelected,
  onCancel,
}: SequenceGridToolbarProps) {
  const [deleteArmed, setDeleteArmed] = useState(false);

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

  return (
    <div className="flex items-center gap-4 border-b border-gray-800 px-8 py-4">
      <h1 className="text-xl font-semibold">{sequenceName}</h1>
      <div className="ml-auto flex items-center gap-3">
        {isSelectMode && (
          <>
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/annotation/SequenceGridToolbar.test.tsx`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/annotation/SequenceGridToolbar.tsx frontend/src/features/annotation/SequenceGridToolbar.test.tsx
git commit -m "feat: add SequenceGridToolbar component with select-mode and click-to-arm delete"
```

---

## Task 5: Wire select mode into `SequenceGridPage`

**Files:**
- Modify: `frontend/src/features/annotation/SequenceGridPage.tsx`
- Modify: `frontend/src/features/annotation/SequenceGridPage.test.tsx`

**Interfaces:**
- Consumes (from Task 2): `useDeleteFrames(sequenceId: number)` from `../../entities/useFrames`, a mutation with `.mutate(frameIds: number[])`.
- Consumes (from Task 3): `FrameThumbnail`'s new required props `selectable`, `selected`, `onToggleSelect`.
- Consumes (from Task 4): `SequenceGridToolbar` with the props interface defined in Task 4.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/features/annotation/SequenceGridPage.test.tsx` (inside the existing `describe` block; the existing test's mock `apiClient.GET` implementation already returns a sequence object with `name: "Seq"` for `/media/sequences/{sequence_id}` — reuse that same mock shape). Also add `apiClient.DELETE` to the module mock at the top of the file, changing:

```ts
vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn() },
}));
```

to:

```ts
vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), DELETE: vi.fn() },
}));
```

Then add this test:

```tsx
  it("selecting frames and confirming delete calls the bulk-delete mutation with the checked frame ids", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path: string) => {
      if (path === "/media/sequences/{sequence_id}") {
        return {
          data: {
            id: 9,
            name: "Seq",
            video_id: null,
            procedure_id: 7,
            start_time: 0,
            duration: 0,
            annotation_count: 0,
            crop_box: null,
          },
          error: undefined,
        } as never;
      }
      if (path === "/annotation/frames/{frame_id}/annotations") {
        return { data: [], error: undefined } as never;
      }
      if (path.includes("/frames")) {
        return {
          data: [
            { id: 1, sequence_id: 9, storage_key: "k1", frame_index: 0, width: 10, height: 10, image_url: "http://x/1.png" },
            { id: 2, sequence_id: 9, storage_key: "k2", frame_index: 1, width: 10, height: 10, image_url: "http://x/2.png" },
          ],
          error: undefined,
        } as never;
      }
      if (path === "/taxonomy/tree") {
        return { data: [], error: undefined } as never;
      }
      return { data: [], error: undefined } as never;
    });
    vi.mocked(apiClient.DELETE).mockResolvedValue({
      data: { deleted_ids: [1, 2] },
      error: undefined,
    } as never);

    renderAtSequence("9");

    screen.getByRole("button", { name: /select/i }).click();

    const images = await screen.findAllByAltText(/Frame \d/);
    images.forEach((img) => img.closest("button")?.click());

    screen.getByRole("button", { name: /delete/i }).click();
    screen.getByRole("button", { name: /confirm/i }).click();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(apiClient.DELETE).toHaveBeenCalledWith(
      "/media/sequences/{sequence_id}/frames",
      expect.objectContaining({
        params: { path: { sequence_id: 9 } },
        body: { frame_ids: [1, 2] },
      }),
    );
  });

  it("shows the sequence name in the toolbar instead of a numeric id placeholder", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path: string) => {
      if (path === "/media/sequences/{sequence_id}") {
        return {
          data: {
            id: 9,
            name: "Colonoscopy run 4",
            video_id: null,
            procedure_id: 7,
            start_time: 0,
            duration: 0,
            annotation_count: 0,
            crop_box: null,
          },
          error: undefined,
        } as never;
      }
      return { data: [], error: undefined } as never;
    });

    renderAtSequence("9");

    expect(await screen.findByText("Colonoscopy run 4")).toBeInTheDocument();
    expect(screen.queryByText(/Sequence #9/)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/annotation/SequenceGridPage.test.tsx`
Expected: FAIL — `SequenceGridPage` doesn't render `SequenceGridToolbar` yet, still shows `Sequence #{id}`, and `FrameThumbnail` isn't selectable.

- [ ] **Step 3: Write minimal implementation**

Replace `frontend/src/features/annotation/SequenceGridPage.tsx` with:

```tsx
import { useState } from "react";
import { useParams } from "react-router-dom";

import { useDeleteFrames, useFrames } from "../../entities/useFrames";
import { useSequence } from "../../entities/useSequence";
import { useTaxonomyTree } from "../../entities/useTaxonomyTree";
import { FrameEditor } from "./FrameEditor";
import { FrameThumbnail } from "./FrameThumbnail";
import { SequenceGridToolbar } from "./SequenceGridToolbar";

export function SequenceGridPage() {
  const { sequenceId } = useParams<{ sequenceId: string }>();
  const sequenceIdNumber = Number(sequenceId);
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedFrameIds, setSelectedFrameIds] = useState<Set<number>>(new Set());

  const framesQuery = useFrames(sequenceIdNumber);
  const sequenceQuery = useSequence(sequenceIdNumber);
  const taxonomyTreeQuery = useTaxonomyTree(sequenceQuery.data?.procedure_id ?? null);
  const taxonomyTree = taxonomyTreeQuery.data ?? [];
  const deleteFrames = useDeleteFrames(sequenceIdNumber);

  if (selectedFrameId !== null) {
    return (
      <FrameEditor
        frameId={selectedFrameId}
        frames={framesQuery.data ?? []}
        onClose={() => setSelectedFrameId(null)}
        onFrameChange={setSelectedFrameId}
      />
    );
  }

  function toggleFrameSelected(frameId: number) {
    setSelectedFrameIds((current) => {
      const next = new Set(current);
      if (next.has(frameId)) {
        next.delete(frameId);
      } else {
        next.add(frameId);
      }
      return next;
    });
  }

  function handleDeleteSelected() {
    deleteFrames.mutate(Array.from(selectedFrameIds), {
      onSuccess: () => setSelectedFrameIds(new Set()),
    });
  }

  function handleCancelSelectMode() {
    setIsSelectMode(false);
    setSelectedFrameIds(new Set());
  }

  const sequenceName = sequenceQuery.data?.name ?? `Sequence #${sequenceId}`;

  return (
    <div className="min-h-full bg-gray-950 text-gray-100">
      <div className="sticky top-0 z-10 bg-gray-950">
        <SequenceGridToolbar
          sequenceName={sequenceName}
          isSelectMode={isSelectMode}
          onToggleSelectMode={() => setIsSelectMode((current) => !current)}
          selectedCount={selectedFrameIds.size}
          onDeleteSelected={handleDeleteSelected}
          onCancel={handleCancelSelectMode}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 p-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {(framesQuery.data ?? []).map((frame) => (
          <FrameThumbnail
            key={frame.id}
            frameId={frame.id}
            imageUrl={frame.image_url}
            taxonomyTree={taxonomyTree}
            onClick={() => setSelectedFrameId(frame.id)}
            selectable={isSelectMode}
            selected={selectedFrameIds.has(frame.id)}
            onToggleSelect={() => toggleFrameSelected(frame.id)}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/annotation/SequenceGridPage.test.tsx`
Expected: PASS

- [ ] **Step 5: Run the full frontend test suite to confirm no regression**

Run: `cd frontend && npm run test -- --run`
Expected: PASS across all suites. The `pretest` hook regenerates the API client from the committed `openapi.json` — this should already include the Task 1 route from that task's Step 7.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/annotation/SequenceGridPage.tsx frontend/src/features/annotation/SequenceGridPage.test.tsx
git commit -m "feat: wire select-and-delete-frames toolbar into the sequence grid page"
```

---

## Task 6: Manual browser verification

**Files:** none (verification only, no code changes).

Per CLAUDE.md's testing philosophy, backend `TestClient` tests and frontend unit tests (which mock `apiClient` entirely) have both previously missed real bugs. This feature also has two properties no automated test in this plan can verify: (a) CSS `position: sticky` actually pinning the toolbar to the viewport top while the grid scrolls underneath it in a real browser, and (b) the real end-to-end delete flow against real Postgres + MinIO.

- [ ] **Step 1: Start the stack**

```bash
docker compose up -d
cd backend && uv run uvicorn app.main:app --reload &
cd backend && uv run celery -A app.worker.celery_app worker --loglevel=info -Q video_transcode &
cd frontend && npm run dev &
```

- [ ] **Step 2: Log in and navigate to a sequence with several frames**

Use the `manualcheck@example.com` login (see project memory `reference_manual_check_login_and_taxonomy_reimport`). Navigate to any sequence's grid page (`/sequences/:id`) with at least 10+ frames (enough to scroll).

- [ ] **Step 3: Verify in the browser**

- The toolbar shows the sequence's actual name, not `Sequence #<id>`.
- Scroll the frame grid down: the toolbar stays pinned to the top of the viewport (sticky), the grid content scrolls underneath it, and the toolbar's background is opaque (frame thumbnails don't show through it).
- Click "Select": every thumbnail grows a checkbox; clicking a thumbnail now toggles its checkbox instead of opening the frame editor.
- Check 2-3 frames; the toolbar shows the correct "N selected" count.
- Click the trash button once: it visually arms (turns into a "Confirm" state) without deleting anything yet.
- Click "Confirm": the selected frames disappear from the grid, and reloading the page confirms they're actually gone (not just hidden client-side).
- If any of the deleted frames had a mask annotation, confirm in the browser devtools Network tab (or by checking MinIO directly, e.g. via `docker compose exec minio ...` or the MinIO console) that the mask's storage object is also gone, not just the DB row.
- Click "✕ Cancel" while some frames are checked: selection clears and checkboxes disappear; nothing was deleted.
- Open browser devtools console: no errors logged.

- [ ] **Step 4: Report result**

If anything above doesn't match, treat it as a bug in this feature (not a pre-existing issue) and fix before considering the plan done — do not just note it and move on.

---

## Self-Review Notes

- **Spec coverage:** sequence name in toolbar (Task 5), sticky toolbar (Task 5's CSS + Task 6's manual check), Select mode toggle + checkboxes (Tasks 3-5), trash icon with click-to-arm confirm (Task 4), Cancel action (Task 4-5), batch cascade-delete backend (Task 1), real-browser verification per CLAUDE.md's testing philosophy (Task 6) — every spec section has a corresponding task.
- **Non-goals respected:** no "Find similar"/"Rank quality" controls anywhere in Task 4's toolbar; no undo mechanism added anywhere.
- **Placeholders:** none — every step has runnable code and exact commands.
- **Type consistency:** `FrameThumbnail`'s `selectable`/`selected`/`onToggleSelect` (Task 3) are the exact prop names `SequenceGridPage` passes in Task 5. `SequenceGridToolbar`'s prop interface (Task 4) matches exactly how Task 5 instantiates it (`sequenceName`, `isSelectMode`, `onToggleSelectMode`, `selectedCount`, `onDeleteSelected`, `onCancel`). `useDeleteFrames`'s mutation signature (Task 2: `.mutate(frameIds: number[])`) matches Task 5's `deleteFrames.mutate(Array.from(selectedFrameIds), ...)` call.
