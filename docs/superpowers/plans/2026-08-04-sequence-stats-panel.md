# Sequence Statistics Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only statistics panel (frame count, resolution, per-label annotation counts) to `SequenceForm`'s edit mode, backed by a new `GET /media/sequences/{sequence_id}/stats` endpoint.

**Architecture:** One new backend aggregation endpoint following the existing `_sequence_read`/`annotation_count` query pattern in `backend/app/media/router.py`. One new frontend React Query hook and one new display component, wired into `SequenceForm.tsx`'s edit-mode branch only.

**Tech Stack:** FastAPI + SQLAlchemy (backend), React + TypeScript + TanStack Query + Vitest (frontend), existing `openapi-typescript` codegen pipeline.

## Global Constraints

- **Language:** English only in code, comments, docstrings, UI copy (CLAUDE.md).
- **TDD:** every backend task and every frontend task with logic gets a failing test before the implementation (CLAUDE.md).
- **API contract:** the frontend must consume the endpoint through the generated, typed `apiClient` — never a hand-rolled untyped `fetch()` (CLAUDE.md). This requires regenerating the committed `openapi.json` after the backend task, before the frontend task's `generate-api` hook can see the new endpoint.
- This feature only applies to `SequenceForm`'s edit mode (a `sequence` prop is present) — create mode never renders the stats panel (spec).
- `labels` in the stats response includes every `AnnotationType` (classification/mask/bbox) grouped by label name — not filtered to `MASK` only, per explicit design-review confirmation (spec).
- `frame_width`/`frame_height` come from the frame with the lowest `frame_index` in the sequence, or `null`/`null` if the sequence has zero frames (spec).
- Frontend density/typography tokens from `docs/specs/2026-08-01-frontend-design-system.md`: `caption` role is `text-xs text-gray-400`; `section-heading` role is `text-sm font-semibold text-gray-200`; a compact secondary table row uses `py-1 px-2` (tighter than the standard `py-1.5 px-3` table-row token, since this is a small secondary widget).

---

### Task 1: Backend `SequenceStats` schema and `GET /media/sequences/{sequence_id}/stats` endpoint

**Files:**
- Modify: `backend/app/media/schemas.py` (add `SequenceStatsLabel`, `SequenceStats`)
- Modify: `backend/app/media/router.py` (add the endpoint)
- Test: `backend/tests/test_media.py`

**Interfaces:**
- Consumes: existing `Frame`, `Annotation` SQLAlchemy models (`backend/app/media/models.py`, `backend/app/annotation/models.py`); existing `Label` model (`backend/app/taxonomy/models.py`).
- Produces: `SequenceStats` Pydantic model (JSON shape `{frame_count: int, frame_width: int | None, frame_height: int | None, labels: [{label_name: str, count: int}]}`) at `GET /media/sequences/{sequence_id}/stats`. Task 2 (frontend hook) consumes this exact JSON shape and endpoint path.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_media.py` (near the existing `test_get_sequence_reports_actual_annotation_count`, which shows the label/category/evaluation-type/annotation setup this task's tests reuse):

```python
def test_sequence_stats_reports_zero_for_empty_sequence():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "stats-empty-procedure"}, headers=headers
    ).json()["id"]
    sequence_id = client.post(
        "/media/sequences",
        json={"procedure_id": procedure_id, "name": "stats empty sequence"},
        headers=headers,
    ).json()["id"]

    response = client.get(f"/media/sequences/{sequence_id}/stats", headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert body["frame_count"] == 0
    assert body["frame_width"] is None
    assert body["frame_height"] is None
    assert body["labels"] == []


def test_sequence_stats_reports_frame_count_and_resolution_from_first_frame():
    headers = _auth_headers()
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos", files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "stats resolution source"}, headers=headers,
        ).json()["id"]
    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "stats resolution sequence", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]
    frames = client.get(f"/media/sequences/{sequence_id}/frames", headers=headers).json()

    response = client.get(f"/media/sequences/{sequence_id}/stats", headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert body["frame_count"] == len(frames)
    first_frame = min(frames, key=lambda f: f["frame_index"])
    assert body["frame_width"] == first_frame["width"]
    assert body["frame_height"] == first_frame["height"]


def test_sequence_stats_groups_annotations_by_label_across_types():
    headers = _auth_headers()
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos", files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "stats label source"}, headers=headers,
        ).json()["id"]
    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "stats label sequence", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]
    frame_ids = [
        f["id"]
        for f in client.get(f"/media/sequences/{sequence_id}/frames", headers=headers).json()
    ]
    assert len(frame_ids) >= 2, "fixture must yield at least 2 frames for this test"

    procedures = client.get("/taxonomy/procedures", headers=headers).json()
    procedure = next((p for p in procedures if p["name"] == "stats-label-procedure"), None)
    if procedure is None:
        procedure = client.post(
            "/taxonomy/procedures", json={"name": "stats-label-procedure"}, headers=headers
        ).json()
    categories = client.get(
        f"/taxonomy/categories?procedure_id={procedure['id']}", headers=headers
    ).json()
    category = next((c for c in categories if c["name"] == "stats-label-category"), None)
    if category is None:
        category = client.post(
            "/taxonomy/categories",
            json={"name": "stats-label-category", "procedure_id": procedure["id"]},
            headers=headers,
        ).json()
    evaluation_types = client.get("/taxonomy/evaluation-types", headers=headers).json()
    evaluation_type = next(
        (e for e in evaluation_types if e["name"] == "stats-label-evaluation-type"), None
    )
    if evaluation_type is None:
        evaluation_type = client.post(
            "/taxonomy/evaluation-types",
            json={"name": "stats-label-evaluation-type"},
            headers=headers,
        ).json()

    def _get_or_create_label(name: str) -> int:
        # Labels have no list-by-name lookup endpoint, so create and rely on
        # this test's unique name to avoid needing a search.
        return client.post(
            "/taxonomy/labels",
            json={
                "name": name,
                "category_id": category["id"],
                "evaluation_type_id": evaluation_type["id"],
            },
            headers=headers,
        ).json()["id"]

    polyp_label_id = _get_or_create_label("stats-test-polyp")
    blood_label_id = _get_or_create_label("stats-test-blood")

    # Two annotations on "polyp" (across two different frames), one on "blood".
    client.post(
        f"/annotation/frames/{frame_ids[0]}/annotations",
        json={"label_id": polyp_label_id},
        headers=headers,
    )
    client.post(
        f"/annotation/frames/{frame_ids[1]}/annotations",
        json={"label_id": polyp_label_id},
        headers=headers,
    )
    client.post(
        f"/annotation/frames/{frame_ids[0]}/annotations",
        json={"label_id": blood_label_id},
        headers=headers,
    )

    response = client.get(f"/media/sequences/{sequence_id}/stats", headers=headers)

    assert response.status_code == 200
    labels_by_name = {entry["label_name"]: entry["count"] for entry in response.json()["labels"]}
    assert labels_by_name["stats-test-polyp"] == 2
    assert labels_by_name["stats-test-blood"] == 1


def test_sequence_stats_404_for_missing_sequence():
    headers = _auth_headers()
    response = client.get("/media/sequences/999999999/stats", headers=headers)
    assert response.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_media.py -k sequence_stats -v`
Expected: FAIL with 404s (route doesn't exist yet) for all four new tests.

- [ ] **Step 3: Add the `SequenceStats`/`SequenceStatsLabel` schemas**

In `backend/app/media/schemas.py`, add after the existing `SequenceRead` class (around line 83, right after its closing):

```python
class SequenceStatsLabel(BaseModel):
    label_name: str
    count: int


class SequenceStats(BaseModel):
    frame_count: int
    frame_width: int | None
    frame_height: int | None
    labels: list[SequenceStatsLabel]
```

- [ ] **Step 4: Add the endpoint**

In `backend/app/media/router.py`:

1. Add `SequenceStats`, `SequenceStatsLabel` to the existing `from app.media.schemas import (...)` block (alongside `FrameRead`, `MediaLibraryItem`, etc. — keep the import list alphabetically consistent with the existing style).
2. Add `from app.taxonomy.models import Label` near the top (this router doesn't currently import `Label` — check the existing import block first; if `Label` is already imported for some other purpose, don't duplicate the import).
3. Add this endpoint immediately after `get_sequence` (after line 392's closing, before `update_sequence` at line 395):

```python
@router.get("/sequences/{sequence_id}/stats", response_model=SequenceStats)
def get_sequence_stats(sequence_id: int, session: Session = Depends(get_session)) -> SequenceStats:
    sequence = session.get(Sequence, sequence_id)
    if sequence is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sequence not found")

    frame_count = session.query(Frame).filter(Frame.sequence_id == sequence_id).count()

    first_frame = (
        session.query(Frame)
        .filter(Frame.sequence_id == sequence_id)
        .order_by(Frame.frame_index.asc())
        .first()
    )

    label_rows = (
        session.query(Label.name, func.count(Annotation.id))
        .join(Annotation, Annotation.label_id == Label.id)
        .join(Frame, Annotation.frame_id == Frame.id)
        .filter(Frame.sequence_id == sequence_id)
        .group_by(Label.name)
        .order_by(func.count(Annotation.id).desc())
        .all()
    )

    return SequenceStats(
        frame_count=frame_count,
        frame_width=first_frame.width if first_frame else None,
        frame_height=first_frame.height if first_frame else None,
        labels=[SequenceStatsLabel(label_name=name, count=count) for name, count in label_rows],
    )
```

`func` is already imported at the top of this router file (`from sqlalchemy import func`) — verify this before adding a duplicate import.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_media.py -k sequence_stats -v`
Expected: PASS, all 4 new tests green.

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && uv run pytest -q`
Expected: PASS, no regressions in the rest of the suite.

- [ ] **Step 7: Regenerate the committed OpenAPI spec**

Run: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`

Then verify it actually changed: `git diff --stat openapi.json` — expect it to show changes (the new `/media/sequences/{sequence_id}/stats` path and the two new schema components). If `git diff --stat` shows no changes, STOP — something is wrong (the route or schema isn't registered) and must be fixed before continuing; do not proceed to commit an unchanged `openapi.json`.

- [ ] **Step 8: Commit**

```bash
git add backend/app/media/schemas.py backend/app/media/router.py backend/tests/test_media.py openapi.json
git commit -m "feat: add GET /media/sequences/{sequence_id}/stats endpoint"
```

---

### Task 2: Frontend `useSequenceStats` hook

**Files:**
- Create: `frontend/src/entities/useSequenceStats.ts`
- Test: `frontend/src/entities/useSequenceStats.test.ts`

**Interfaces:**
- Consumes: the `GET /media/sequences/{sequence_id}/stats` endpoint from Task 1, via the typed `apiClient` (regenerated in Task 1 Step 7 — this task's implementer must run `npm run generate-api` in `frontend/` first, or simply run `npm run dev`/`npm test` once, since those commands auto-run `generate-api` via `predev`/`pretest` hooks per this repo's `package.json`, before writing code that references the new endpoint's types).
- Produces: `useSequenceStats(sequenceId: number)` — a React Query hook returning `{ data, isLoading, ... }` where `data` (once loaded) has the shape `{ frame_count: number; frame_width: number | null; frame_height: number | null; labels: { label_name: string; count: number }[] }`. Task 3 (`SequenceStatsPanel.tsx`) consumes this hook directly by name.

**Design notes for the implementer:** follow the exact pattern of `frontend/src/entities/useSuggestSequenceName.ts` (already in this codebase — read it first): a `useQuery` wrapping a single `apiClient.GET` call, `queryKey` including the id, `queryFn` returning `result.data`. This endpoint takes no query params (just a path param), so it's slightly simpler than the reference — no `enabled` gating needed since `SequenceStatsPanel` is only ever rendered with a real, known `sequenceId`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/entities/useSequenceStats.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../shared/api/client";
import { useSequenceStats } from "./useSequenceStats";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useSequenceStats", () => {
  it("fetches stats for the given sequence id and returns the response data", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: {
        frame_count: 42,
        frame_width: 720,
        frame_height: 480,
        labels: [{ label_name: "polyp", count: 5 }],
      },
      error: undefined,
    } as never);

    const { result } = renderHook(() => useSequenceStats(9), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());

    expect(apiClient.GET).toHaveBeenCalledWith(
      "/media/sequences/{sequence_id}/stats",
      expect.objectContaining({ params: { path: { sequence_id: 9 } } })
    );
    expect(result.current.data).toEqual({
      frame_count: 42,
      frame_width: 720,
      frame_height: 480,
      labels: [{ label_name: "polyp", count: 5 }],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/entities/useSequenceStats.test.ts`
Expected: FAIL with "Cannot find module './useSequenceStats'" (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `frontend/src/entities/useSequenceStats.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useSequenceStats(sequenceId: number) {
  return useQuery({
    queryKey: ["sequence-stats", sequenceId],
    queryFn: async () => {
      const result = await apiClient.GET("/media/sequences/{sequence_id}/stats", {
        params: { path: { sequence_id: sequenceId } },
      });
      return result.data;
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/entities/useSequenceStats.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd frontend
git add src/entities/useSequenceStats.ts src/entities/useSequenceStats.test.ts
git commit -m "feat: add useSequenceStats hook"
```

---

### Task 3: `SequenceStatsPanel` component

**Files:**
- Create: `frontend/src/features/media/SequenceStatsPanel.tsx`
- Test: `frontend/src/features/media/SequenceStatsPanel.test.tsx`

**Interfaces:**
- Consumes: `useSequenceStats` from Task 2 (`frontend/src/entities/useSequenceStats.ts`).
- Produces: `SequenceStatsPanel({ sequenceId }: { sequenceId: number })` component. Task 4 (`SequenceForm.tsx` wiring) renders `<SequenceStatsPanel sequenceId={sequence!.id} />` directly.

**Design notes for the implementer:**
- Renders nothing (returns `null`) while `data` is undefined (no skeleton needed — matches this codebase's existing pattern for lightweight queries, see the design spec's "Testing" section).
- The frame count/resolution line: `"{frame_count} frames"` when `frame_width`/`frame_height` are both `null`, or `"{frame_count} frames · {frame_width}×{frame_height}"` when both are present (they're always both-null or both-present per Task 1's schema, so no need to handle a mixed case).
- `caption` typography role (`text-xs text-gray-400`) for that line.
- A `section-heading` role (`text-sm font-semibold text-gray-200`) label "Labels" above the table.
- If `labels` is an empty array: render `<p className="text-xs text-gray-400">No annotations yet</p>` instead of a table.
- Otherwise render a compact table: one row per label, two cells (name, count right-aligned), `py-1 px-2` per cell, wrapped in a scrollable container `<div className="max-h-32 overflow-y-auto">`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/features/media/SequenceStatsPanel.test.tsx`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { SequenceStatsPanel } from "./SequenceStatsPanel";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("SequenceStatsPanel", () => {
  afterEach(() => vi.clearAllMocks());

  it("shows frame count and resolution once loaded", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { frame_count: 42, frame_width: 720, frame_height: 480, labels: [] },
      error: undefined,
    } as never);

    render(<SequenceStatsPanel sequenceId={9} />, { wrapper });

    expect(await screen.findByText("42 frames · 720×480")).toBeInTheDocument();
  });

  it("omits the resolution when frame_width/frame_height are null", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { frame_count: 0, frame_width: null, frame_height: null, labels: [] },
      error: undefined,
    } as never);

    render(<SequenceStatsPanel sequenceId={9} />, { wrapper });

    expect(await screen.findByText("0 frames")).toBeInTheDocument();
  });

  it("renders a row per label with its count", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: {
        frame_count: 10,
        frame_width: 100,
        frame_height: 100,
        labels: [
          { label_name: "polyp", count: 5 },
          { label_name: "blood", count: 2 },
        ],
      },
      error: undefined,
    } as never);

    render(<SequenceStatsPanel sequenceId={9} />, { wrapper });

    expect(await screen.findByText("polyp")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("blood")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("shows an empty-state message when there are no labels", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { frame_count: 10, frame_width: 100, frame_height: 100, labels: [] },
      error: undefined,
    } as never);

    render(<SequenceStatsPanel sequenceId={9} />, { wrapper });

    expect(await screen.findByText(/no annotations yet/i)).toBeInTheDocument();
  });

  it("renders nothing before data has loaded", () => {
    vi.mocked(apiClient.GET).mockReturnValue(new Promise(() => {}) as never);

    const { container } = render(<SequenceStatsPanel sequenceId={9} />, { wrapper });

    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/media/SequenceStatsPanel.test.tsx`
Expected: FAIL with "Cannot find module './SequenceStatsPanel'".

- [ ] **Step 3: Write the implementation**

Create `frontend/src/features/media/SequenceStatsPanel.tsx`:

```typescript
import { useSequenceStats } from "../../entities/useSequenceStats";

export function SequenceStatsPanel({ sequenceId }: { sequenceId: number }) {
  const statsQuery = useSequenceStats(sequenceId);
  const stats = statsQuery.data;

  if (!stats) return null;

  const summaryLine =
    stats.frame_width !== null && stats.frame_height !== null
      ? `${stats.frame_count} frames · ${stats.frame_width}×${stats.frame_height}`
      : `${stats.frame_count} frames`;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-gray-400">{summaryLine}</p>
      <p className="text-sm font-semibold text-gray-200">Labels</p>
      {stats.labels.length === 0 ? (
        <p className="text-xs text-gray-400">No annotations yet</p>
      ) : (
        <div className="max-h-32 overflow-y-auto">
          <table className="w-full text-xs">
            <tbody>
              {stats.labels.map((label) => (
                <tr key={label.label_name}>
                  <td className="py-1 px-2 text-gray-100">{label.label_name}</td>
                  <td className="py-1 px-2 text-right text-gray-100">{label.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/media/SequenceStatsPanel.test.tsx`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Commit**

```bash
cd frontend
git add src/features/media/SequenceStatsPanel.tsx src/features/media/SequenceStatsPanel.test.tsx
git commit -m "feat: add SequenceStatsPanel component"
```

---

### Task 4: Wire `SequenceStatsPanel` into `SequenceForm`'s edit mode

**Files:**
- Modify: `frontend/src/features/media/SequenceForm.tsx`
- Test: `frontend/src/features/media/SequenceForm.test.tsx`

**Interfaces:**
- Consumes: `SequenceStatsPanel` from Task 3.
- Produces: nothing new consumed by later tasks — this is the final integration task.

**Design notes for the implementer:**
- Read the current `frontend/src/features/media/SequenceForm.tsx` in full before starting. The `isEdit` branch currently returns a single `<form>` element with `flex flex-col gap-2` layout; the `!isEdit` (create-mode) branch is untouched by this task.
- Add `import { SequenceStatsPanel } from "./SequenceStatsPanel";` to the top of the file.
- Wrap the existing edit-mode `<form>` and a new `<SequenceStatsPanel>` in an outer `flex` row: the form becomes the primary (`flex-1`) column, `SequenceStatsPanel` a fixed-width `w-48` column to its right. The exact restructure:

  The current edit-mode return is:
  ```typescript
  if (isEdit) {
    return (
      <form onSubmit={handleEditSubmit} className="flex flex-col gap-2 rounded border border-gray-800 bg-gray-900 p-4">
        {/* ...existing fields... */}
      </form>
    );
  }
  ```

  Change it to:
  ```typescript
  if (isEdit) {
    return (
      <div className="flex gap-3">
        <form onSubmit={handleEditSubmit} className="flex flex-1 flex-col gap-2 rounded border border-gray-800 bg-gray-900 p-4">
          {/* ...existing fields, completely unchanged... */}
        </form>
        <div className="w-48 shrink-0 rounded border border-gray-800 bg-gray-900 p-3">
          <SequenceStatsPanel sequenceId={sequence!.id} />
        </div>
      </div>
    );
  }
  ```

  Every field/button inside the `<form>` stays exactly as it is today — only the outer wrapper changes, adding a sibling `<div>` next to the form.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/features/media/SequenceForm.test.tsx`, inside the existing `describe("SequenceForm edit mode ...)` block, after its last existing `it`:

```typescript
  it("renders the stats panel for the sequence being edited", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path) => {
      if (path === "/media/sequences/{sequence_id}/stats") {
        return {
          data: { frame_count: 7, frame_width: 640, frame_height: 480, labels: [] },
          error: undefined,
        } as never;
      }
      return { data: undefined, error: undefined } as never;
    });

    render(
      <SequenceForm
        sequence={sequence}
        videoId={5}
        markStart={0}
        markEnd={20}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    expect(await screen.findByText("7 frames · 640×480")).toBeInTheDocument();
  });
```

Also add, inside the existing `describe("SequenceForm create mode ...)` block, after its last existing `it`:

```typescript
  it("does not render a stats panel in create mode", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path) => {
      if (path === "/taxonomy/procedures") {
        return { data: [{ id: 1, name: "EGD" }], error: undefined } as never;
      }
      if (path === "/media/sequences/suggest-name") {
        return { data: { name: "EGD 2026-07-29 #1" }, error: undefined } as never;
      }
      return { data: undefined, error: undefined } as never;
    });

    render(
      <SequenceForm
        videoId={5}
        markStart={10}
        markEnd={30}
        procedureId={1}
        onCropChange={vi.fn()}
        existingSequences={[]}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    await screen.findByRole("button", { name: /create sequence/i });
    expect(screen.queryByText(/frames/i)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify the edit-mode test fails**

Run: `cd frontend && npx vitest run src/features/media/SequenceForm.test.tsx`
Expected: FAIL on the new edit-mode test ("7 frames · 640×480" never appears, since `SequenceStatsPanel` isn't wired in yet). The create-mode test should already PASS (nothing renders "frames" text today) — if it doesn't, note that as unexpected before proceeding.

- [ ] **Step 3: Wire the panel into edit mode**

Apply the restructure described in the design notes above to `frontend/src/features/media/SequenceForm.tsx`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/media/SequenceForm.test.tsx`
Expected: PASS, all 20 tests green (18 from Tasks 1-2 of the prior plan + 2 new from this task).

- [ ] **Step 5: Run the full frontend suite**

Run: `cd frontend && npx vitest run`
Expected: PASS, all tests green, zero failures.

- [ ] **Step 6: Commit**

```bash
cd frontend
git add src/features/media/SequenceForm.tsx src/features/media/SequenceForm.test.tsx
git commit -m "feat: wire SequenceStatsPanel into SequenceForm's edit mode"
```

---

## Manual Verification (after all tasks complete)

Per CLAUDE.md's testing philosophy, exercise this for real in a browser before trusting the test suite alone.

1. Start the stack per `CLAUDE.md`'s "Running the stack" section (backend, frontend; the transcode worker isn't needed for this feature).
2. Open a video with at least one existing sequence that has annotated frames.
3. Click the sequence's body on the timeline to open edit mode; confirm the stats panel appears to the right of the form showing the correct frame count, resolution, and label breakdown.
4. Open edit mode on a sequence with zero annotations; confirm it shows "No annotations yet" instead of an empty table.
5. If any sequence has many distinct labels (or annotate a test sequence with several different labels to check), confirm the label table scrolls internally instead of growing the whole panel.
6. Open create mode (click empty timeline background); confirm no stats panel appears anywhere.
7. Confirm nothing else in the edit-mode form (crop fields, FPS, Name, Procedure, Save/Close/Confirm/Cancel) changed position or behavior beyond gaining the new sibling panel.
