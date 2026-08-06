# Media Library Filter/Search/Sort/Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-side search, type/procedure filters, sortable columns,
and page-number pagination to the media library table.

**Architecture:** `GET /media/library` gains optional query params
(`search`, `type`, `procedure_id`, `sort`, `order`, `page`, `page_size`)
and returns a pagination envelope (`{items, total, page, page_size}`)
instead of a bare array. The existing two-loop Python assembly of
`MediaLibraryItem` rows is kept as-is; filtering, sorting, and paging are
applied to the assembled `list[MediaLibraryItem]` before it's returned.
`MediaLibraryTable` owns filter/sort/page state, debounces the search
input, and a new `MediaLibraryPagination` component renders page controls
below the table.

**Tech Stack:** FastAPI + Pydantic (backend), React + TanStack Query +
`openapi-fetch` generated client (frontend), pytest (backend tests),
Vitest + Testing Library (frontend tests).

## Global Constraints

- Language: English only in code, comments, docstrings, UI copy. No
  Russian anywhere in the repo.
- API contract: REST + OpenAPI. Never write a hand-rolled untyped
  `fetch()` — use `apiClient` from `frontend/src/shared/api/client.ts`.
  After any backend schema/route change, regenerate `openapi.json`:
  `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`,
  then verify with `git diff --stat openapi.json` that it changed.
- TDD: every task gets a failing test before the implementation.
- Dark UI theme only — don't introduce light-background Tailwind classes.
- `npm run dev`/`build`/`test` auto-regenerate the frontend's generated
  API types from the committed `openapi.json` (via `predev`/`prebuild`/
  `pretest` hooks) — never hand-edit
  `frontend/src/shared/api/generated/schema.d.ts`.

---

## File Structure

- Modify: `backend/app/media/schemas.py` — add `MediaLibraryPage`
  envelope model.
- Modify: `backend/app/media/router.py` — `get_media_library` gains query
  params, filter/sort/page logic, `response_model=MediaLibraryPage`.
- Modify: `backend/tests/test_media.py` — existing library test updated
  for the envelope shape; new tests for each filter, each sort key/order,
  and paging.
- Modify: `openapi.json` — regenerated after the backend schema change.
- Modify: `frontend/src/entities/useMediaLibrary.ts` — `useMediaLibrary`
  takes a params object, includes it in the query key, returns the full
  page envelope (not just `items`).
- Create: `frontend/src/features/media/useDebouncedValue.ts` — small
  generic debounce hook (no existing debounce utility in the codebase).
- Create: `frontend/src/features/media/useDebouncedValue.test.ts` — test
  for the debounce hook.
- Create: `frontend/src/features/media/MediaLibraryPagination.tsx` — page
  number + Previous/Next controls.
- Create: `frontend/src/features/media/MediaLibraryPagination.test.tsx`.
- Modify: `frontend/src/features/media/MediaLibraryTable.tsx` — owns
  filter/sort/page state, renders search box, Type/Procedure selects,
  sortable column headers, and `MediaLibraryPagination`.
- Modify: `frontend/src/features/media/MediaLibraryTable.test.tsx` —
  existing tests updated for the envelope response shape; new tests for
  search, filters, sort, and pagination interactions.

---

## Task 1: Backend — pagination envelope + query params on `/media/library`

**Files:**
- Modify: `backend/app/media/schemas.py` (add after `MediaLibraryItem`,
  currently ending at line 110)
- Modify: `backend/app/media/router.py:131-194` (`get_media_library`)
- Modify: `backend/tests/test_media.py:595-690`
  (`test_media_library_lists_videos_and_photo_sequences`)
- Test: `backend/tests/test_media.py`

**Interfaces:**
- Produces: `MediaLibraryPage` Pydantic model —
  `{items: list[MediaLibraryItem], total: int, page: int, page_size: int}`.
- Produces: `GET /media/library` query params — `search: str | None`,
  `type: Literal["video", "photo"] | None`, `procedure_id: int | None`,
  `sort: Literal["uploaded_at", "last_edited_at", "size_bytes", "linked_sequence_count"] = "uploaded_at"`,
  `order: Literal["asc", "desc"] = "desc"`, `page: int = 1`,
  `page_size: int = 25`.

- [ ] **Step 1: Write the failing tests**

Replace the tail of `test_media_library_lists_videos_and_photo_sequences`
(the two `response = client.get("/media/library", ...)` calls and their
`items = response.json()` lines) to read through the envelope, and add
new tests for filtering/sorting/paging. Edit
`backend/tests/test_media.py`:

```python
def test_media_library_lists_videos_and_photo_sequences():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Library listing procedure"}, headers=headers
    ).json()["id"]

    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos",
            files={"file": ("library_video.mp4", f, "video/mp4")},
            data={"title": "Library video", "procedure_id": str(procedure_id)},
            headers=headers,
        ).json()["id"]

    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "Library video seq", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]

    fixture = Path(__file__).parent / "fixtures" / "tiny_frame.png"
    with open(fixture, "rb") as f:
        image_bytes = f.read()
    photo_sequence_id = client.post(
        "/media/sequences/photos",
        data={"name": "Library photo seq", "procedure_id": str(procedure_id)},
        files=[("files", ("p.png", image_bytes, "image/png"))],
        headers=headers,
    ).json()["id"]

    response = client.get("/media/library", headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert body["page"] == 1
    assert body["page_size"] == 25
    assert body["total"] >= 2
    items = body["items"]
    video_item = next(i for i in items if i["kind"] == "video" and i["filename"] == "library_video.mp4")
    assert video_item["linked_sequence_count"] == 1
    assert video_item["title"] == "Library video"
    # No annotations yet -- last_edited_at falls back to the sequence's own created_at.
    assert video_item["last_edited_at"] is not None

    photo_item = next(i for i in items if i["kind"] == "photo" and i["id"] == photo_sequence_id)
    assert photo_item["linked_sequence_count"] == 1
    assert photo_item["filename"] == "Library photo seq"
    assert photo_item["title"] is None
    assert photo_item["last_edited_at"] is not None

    # Now add an annotation to the video's sequence and confirm last_edited_at moves forward.
    before_last_edited = video_item["last_edited_at"]

    procedures = client.get("/taxonomy/procedures", headers=headers).json()
    procedure = next(p for p in procedures if p["id"] == procedure_id)
    categories = client.get(
        f"/taxonomy/categories?procedure_id={procedure['id']}", headers=headers
    ).json()
    category = next((c for c in categories if c["name"] == "last-edited-category"), None)
    if category is None:
        category = client.post(
            "/taxonomy/categories",
            json={"name": "last-edited-category", "procedure_id": procedure["id"]},
            headers=headers,
        ).json()
    evaluation_types = client.get("/taxonomy/evaluation-types", headers=headers).json()
    evaluation_type = next(
        (e for e in evaluation_types if e["name"] == "last-edited-evaluation-type"), None
    )
    if evaluation_type is None:
        evaluation_type = client.post(
            "/taxonomy/evaluation-types",
            json={"name": "last-edited-evaluation-type"},
            headers=headers,
        ).json()
    label_id = client.post(
        "/taxonomy/labels",
        json={
            "name": "last-edited-label",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=headers,
    ).json()["id"]

    frames = client.get(f"/media/sequences/{sequence_id}/frames", headers=headers).json()
    frame_id = frames[0]["id"]
    client.post(
        f"/annotation/frames/{frame_id}/annotations",
        json={"label_id": label_id},
        headers=headers,
    )

    response_after = client.get("/media/library", headers=headers)
    items_after = response_after.json()["items"]
    video_item_after = next(
        i for i in items_after if i["kind"] == "video" and i["filename"] == "library_video.mp4"
    )
    assert video_item_after["last_edited_at"] >= before_last_edited
    assert video_item_after["last_edited_at"] > video_item_after["uploaded_at"]


def test_media_library_search_matches_video_title_or_filename():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Search procedure"}, headers=headers
    ).json()["id"]

    with open(FIXTURE_VIDEO, "rb") as f:
        client.post(
            "/media/videos",
            files={"file": ("zzz_unique_filename.mp4", f, "video/mp4")},
            data={"title": "Totally different title", "procedure_id": str(procedure_id)},
            headers=headers,
        )

    by_filename = client.get(
        "/media/library", params={"search": "zzz_unique_filename"}, headers=headers
    ).json()
    assert any(i["filename"] == "zzz_unique_filename.mp4" for i in by_filename["items"])

    by_title = client.get(
        "/media/library", params={"search": "totally different"}, headers=headers
    ).json()
    assert any(i["filename"] == "zzz_unique_filename.mp4" for i in by_title["items"])

    no_match = client.get(
        "/media/library", params={"search": "no-such-media-exists-anywhere"}, headers=headers
    ).json()
    assert no_match["items"] == []
    assert no_match["total"] == 0


def test_media_library_filters_by_type():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Type filter procedure"}, headers=headers
    ).json()["id"]

    fixture = Path(__file__).parent / "fixtures" / "tiny_frame.png"
    with open(fixture, "rb") as f:
        image_bytes = f.read()
    client.post(
        "/media/sequences/photos",
        data={"name": "Type filter photo seq", "procedure_id": str(procedure_id)},
        files=[("files", ("p.png", image_bytes, "image/png"))],
        headers=headers,
    )

    photos_only = client.get("/media/library", params={"type": "photo"}, headers=headers).json()
    assert all(i["kind"] == "photo" for i in photos_only["items"])

    videos_only = client.get("/media/library", params={"type": "video"}, headers=headers).json()
    assert all(i["kind"] == "video" for i in videos_only["items"])


def test_media_library_filters_by_procedure_id():
    headers = _auth_headers()
    procedure_a = client.post(
        "/taxonomy/procedures", json={"name": "Procedure filter A"}, headers=headers
    ).json()["id"]
    procedure_b = client.post(
        "/taxonomy/procedures", json={"name": "Procedure filter B"}, headers=headers
    ).json()["id"]

    fixture = Path(__file__).parent / "fixtures" / "tiny_frame.png"
    with open(fixture, "rb") as f:
        image_bytes = f.read()
    client.post(
        "/media/sequences/photos",
        data={"name": "Procedure A photo seq", "procedure_id": str(procedure_a)},
        files=[("files", ("pa.png", image_bytes, "image/png"))],
        headers=headers,
    )
    with open(fixture, "rb") as f:
        image_bytes_b = f.read()
    client.post(
        "/media/sequences/photos",
        data={"name": "Procedure B photo seq", "procedure_id": str(procedure_b)},
        files=[("files", ("pb.png", image_bytes_b, "image/png"))],
        headers=headers,
    )

    filtered = client.get(
        "/media/library", params={"procedure_id": procedure_a}, headers=headers
    ).json()
    assert all(i["procedure_id"] == procedure_a for i in filtered["items"])
    assert any(i["filename"] == "Procedure A photo seq" for i in filtered["items"])
    assert not any(i["filename"] == "Procedure B photo seq" for i in filtered["items"])


def test_media_library_sorts_by_size_bytes_ascending():
    headers = _auth_headers()
    response = client.get(
        "/media/library", params={"sort": "size_bytes", "order": "asc"}, headers=headers
    )
    assert response.status_code == 200
    sizes = [i["size_bytes"] for i in response.json()["items"]]
    assert sizes == sorted(sizes)


def test_media_library_sorts_by_size_bytes_descending():
    headers = _auth_headers()
    response = client.get(
        "/media/library", params={"sort": "size_bytes", "order": "desc"}, headers=headers
    )
    assert response.status_code == 200
    sizes = [i["size_bytes"] for i in response.json()["items"]]
    assert sizes == sorted(sizes, reverse=True)


def test_media_library_paginates_results():
    headers = _auth_headers()
    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "Pagination procedure"}, headers=headers
    ).json()["id"]

    fixture = Path(__file__).parent / "fixtures" / "tiny_frame.png"
    for n in range(3):
        with open(fixture, "rb") as f:
            image_bytes = f.read()
        client.post(
            "/media/sequences/photos",
            data={"name": f"Pagination photo seq {n}", "procedure_id": str(procedure_id)},
            files=[("files", (f"p{n}.png", image_bytes, "image/png"))],
            headers=headers,
        )

    page_1 = client.get(
        "/media/library",
        params={"procedure_id": procedure_id, "page": 1, "page_size": 2},
        headers=headers,
    ).json()
    assert len(page_1["items"]) == 2
    assert page_1["total"] == 3
    assert page_1["page"] == 1

    page_2 = client.get(
        "/media/library",
        params={"procedure_id": procedure_id, "page": 2, "page_size": 2},
        headers=headers,
    ).json()
    assert len(page_2["items"]) == 1
    assert page_2["total"] == 3

    page_ids_1 = {i["id"] for i in page_1["items"]}
    page_ids_2 = {i["id"] for i in page_2["items"]}
    assert page_ids_1.isdisjoint(page_ids_2)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest tests/test_media.py -k "library" -v`
Expected: FAIL — the handler still returns a bare list and ignores the
new query params, so `response.json()["items"]` raises (list has no
`__getitem__` for a string key) and the filter/sort/paginate tests get
unfiltered/unsorted/unpaginated results.

- [ ] **Step 3: Add `MediaLibraryPage` to schemas.py**

In `backend/app/media/schemas.py`, immediately after the
`MediaLibraryItem` class (ends at line 110):

```python
class MediaLibraryPage(BaseModel):
    items: list[MediaLibraryItem]
    total: int
    page: int
    page_size: int
```

- [ ] **Step 4: Implement filter/sort/paginate in the router**

In `backend/app/media/router.py`, update the import (line 17-28) to add
`MediaLibraryPage` to the `from app.media.schemas import (...)` block,
and add `Literal` to the typing imports at the top of the file if not
already present (check line 1-8; add `from typing import Literal` if
missing).

Replace the `get_media_library` function (currently
`backend/app/media/router.py:131-194`) — keep the two assembly loops
(lines 133-191) exactly as they are, and replace only the signature and
the final `items.sort(...); return items` (lines 193-194):

```python
@router.get("/library", response_model=MediaLibraryPage)
def get_media_library(
    search: str | None = None,
    type: Literal["video", "photo"] | None = None,
    procedure_id: int | None = None,
    sort: Literal["uploaded_at", "last_edited_at", "size_bytes", "linked_sequence_count"] = "uploaded_at",
    order: Literal["asc", "desc"] = "desc",
    page: int = 1,
    page_size: int = 25,
    session: Session = Depends(get_session),
) -> MediaLibraryPage:
    items: list[MediaLibraryItem] = []

    # ... existing video loop (lines 135-164) and photo loop (lines 166-191)
    # stay exactly as-is here ...

    if search:
        needle = search.lower()
        items = [
            item
            for item in items
            if needle in item.filename.lower() or (item.title is not None and needle in item.title.lower())
        ]
    if type is not None:
        items = [item for item in items if item.kind == type]
    if procedure_id is not None:
        items = [item for item in items if item.procedure_id == procedure_id]

    items.sort(key=lambda item: getattr(item, sort), reverse=(order == "desc"))

    total = len(items)
    start = (page - 1) * page_size
    page_items = items[start : start + page_size]

    return MediaLibraryPage(items=page_items, total=total, page=page, page_size=page_size)
```

Note the parameter is named `type`, shadowing the Python builtin within
this function's scope — this is intentional to keep the query param name
matching the spec (`?type=video`); it isn't used as the builtin anywhere
in this function.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_media.py -v`
Expected: PASS (all tests in the file, not just `-k library`, since the
response shape change could affect nothing else, but this confirms no
regression).

- [ ] **Step 6: Regenerate openapi.json**

Run: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py`
Then: `git diff --stat openapi.json` — confirm it changed (the
`/media/library` path should now show query parameters and a
`MediaLibraryPage` response schema instead of a bare array).

- [ ] **Step 7: Commit**

```bash
git add backend/app/media/schemas.py backend/app/media/router.py backend/tests/test_media.py openapi.json
git commit -m "feat: add search/filter/sort/pagination to media library endpoint"
```

---

## Task 2: Frontend — debounce hook

**Files:**
- Create: `frontend/src/features/media/useDebouncedValue.ts`
- Test: `frontend/src/features/media/useDebouncedValue.test.ts`

**Interfaces:**
- Produces: `useDebouncedValue<T>(value: T, delayMs: number): T` — returns
  `value`, updated only after `delayMs` has elapsed since the last change.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useDebouncedValue } from "./useDebouncedValue";

describe("useDebouncedValue", () => {
  it("returns the initial value immediately", () => {
    const { result } = renderHook(() => useDebouncedValue("a", 300));
    expect(result.current).toBe("a");
  });

  it("does not update until the delay has elapsed", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 300), {
      initialProps: { value: "a" },
    });

    rerender({ value: "b" });
    expect(result.current).toBe("a");

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe("a");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("b");

    vi.useRealTimers();
  });

  it("resets the timer on rapid successive changes", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 300), {
      initialProps: { value: "a" },
    });

    rerender({ value: "b" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ value: "c" });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe("a");

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe("c");

    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/media/useDebouncedValue.test.ts`
Expected: FAIL with "Cannot find module './useDebouncedValue'"

- [ ] **Step 3: Implement the hook**

```typescript
import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/media/useDebouncedValue.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/media/useDebouncedValue.ts frontend/src/features/media/useDebouncedValue.test.ts
git commit -m "feat: add useDebouncedValue hook"
```

---

## Task 3: Frontend — `useMediaLibrary` takes filter/sort/page params

**Files:**
- Modify: `frontend/src/entities/useMediaLibrary.ts:1-13`
  (`useMediaLibrary` function only — `useDeleteVideo`/`useDeleteSequence`
  below it are unchanged)
- Test: no dedicated test file exists for `useMediaLibrary` today;
  coverage comes from `MediaLibraryTable.test.tsx` (Task 5). This task
  has no standalone test — its behavior is only observable through the
  table, so TDD for this hook happens as part of Task 5's tests instead
  of in isolation here.

**Interfaces:**
- Consumes: nothing new from earlier tasks.
- Produces: `useMediaLibrary(params: MediaLibraryParams)` where
  `MediaLibraryParams = { search?: string; type?: "video" | "photo"; procedureId?: number; sort?: "uploaded_at" | "last_edited_at" | "size_bytes" | "linked_sequence_count"; order?: "asc" | "desc"; page: number; pageSize: number }`.
  The query's `data` is now the full envelope
  `{ items: MediaLibraryItem[]; total: number; page: number; page_size: number } | undefined`
  (previously it was `MediaLibraryItem[]`) — every caller must be updated
  to read `.data?.items` instead of `.data`.

- [ ] **Step 1: Update `useMediaLibrary`**

Since this hook has no isolated test, apply the implementation directly
(TDD coverage for its new behavior comes via Task 5's
`MediaLibraryTable.test.tsx` cases, written before that task's
implementation). Replace
`frontend/src/entities/useMediaLibrary.ts` lines 1-13:

```typescript
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export interface MediaLibraryParams {
  search?: string;
  type?: "video" | "photo";
  procedureId?: number;
  sort?: "uploaded_at" | "last_edited_at" | "size_bytes" | "linked_sequence_count";
  order?: "asc" | "desc";
  page: number;
  pageSize: number;
}

export function useMediaLibrary(params: MediaLibraryParams) {
  const { search, type, procedureId, sort, order, page, pageSize } = params;
  return useQuery({
    queryKey: ["media-library", search, type, procedureId, sort, order, page, pageSize],
    queryFn: async () => {
      const result = await apiClient.GET("/media/library", {
        params: {
          query: {
            search: search || undefined,
            type,
            procedure_id: procedureId,
            sort,
            order,
            page,
            page_size: pageSize,
          },
        },
      });
      return result.data;
    },
  });
}
```

(The rest of the file — `useDeleteVideo`, `useDeleteSequence`, and their
`invalidateQueries({ queryKey: ["media-library"] })` calls — is
unchanged; TanStack Query invalidates all queries whose key starts with
`["media-library"]`, which still matches the new longer keys.)

- [ ] **Step 2: Commit**

This task has no passing test to run in isolation — defer the commit and
fold it into Task 5's commit, since Task 5 is what proves this hook
works end-to-end. Do not commit yet; proceed directly to Task 4.

---

## Task 4: Frontend — `MediaLibraryPagination` component

**Files:**
- Create: `frontend/src/features/media/MediaLibraryPagination.tsx`
- Test: `frontend/src/features/media/MediaLibraryPagination.test.tsx`

**Interfaces:**
- Produces: `MediaLibraryPagination({ total, page, pageSize, onPageChange }: { total: number; page: number; pageSize: number; onPageChange: (page: number) => void })`.
  Renders nothing (`null`) when `total <= pageSize`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MediaLibraryPagination } from "./MediaLibraryPagination";

describe("MediaLibraryPagination", () => {
  it("renders nothing when everything fits on one page", () => {
    const { container } = render(
      <MediaLibraryPagination total={10} page={1} pageSize={25} onPageChange={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a button per page and highlights the current page", () => {
    render(<MediaLibraryPagination total={55} page={2} pageSize={25} onPageChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "1" })).toBeInTheDocument();
    const current = screen.getByRole("button", { name: "2" });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "3" })).toBeInTheDocument();
  });

  it("calls onPageChange with the clicked page number", async () => {
    const onPageChange = vi.fn();
    render(<MediaLibraryPagination total={55} page={1} pageSize={25} onPageChange={onPageChange} />);
    await userEvent.click(screen.getByRole("button", { name: "3" }));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it("disables Previous on the first page and Next on the last page", () => {
    const { rerender } = render(
      <MediaLibraryPagination total={55} page={1} pageSize={25} onPageChange={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /next/i })).not.toBeDisabled();

    rerender(<MediaLibraryPagination total={55} page={3} pageSize={25} onPageChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /previous/i })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
  });

  it("calls onPageChange with page - 1 / page + 1 for Previous/Next", async () => {
    const onPageChange = vi.fn();
    render(<MediaLibraryPagination total={55} page={2} pageSize={25} onPageChange={onPageChange} />);
    await userEvent.click(screen.getByRole("button", { name: /previous/i }));
    expect(onPageChange).toHaveBeenCalledWith(1);
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/media/MediaLibraryPagination.test.tsx`
Expected: FAIL with "Cannot find module './MediaLibraryPagination'"

- [ ] **Step 3: Implement the component**

```typescript
export function MediaLibraryPagination({
  total,
  page,
  pageSize,
  onPageChange,
}: {
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  const pageCount = Math.ceil(total / pageSize);
  if (pageCount <= 1) return null;

  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);

  return (
    <div className="flex items-center justify-center gap-1 py-3">
      <button
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        className="rounded border border-gray-700 px-2 py-1 text-sm text-gray-100 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Previous
      </button>
      {pages.map((p) => (
        <button
          key={p}
          onClick={() => onPageChange(p)}
          aria-current={p === page ? "page" : undefined}
          className={`rounded px-3 py-1 text-sm ${
            p === page ? "bg-blue-700 text-white" : "text-gray-100 hover:bg-gray-800"
          }`}
        >
          {p}
        </button>
      ))}
      <button
        onClick={() => onPageChange(page + 1)}
        disabled={page >= pageCount}
        className="rounded border border-gray-700 px-2 py-1 text-sm text-gray-100 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Next
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/media/MediaLibraryPagination.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/media/MediaLibraryPagination.tsx frontend/src/features/media/MediaLibraryPagination.test.tsx
git commit -m "feat: add MediaLibraryPagination component"
```

---

## Task 5: Frontend — wire search/filters/sort/pagination into `MediaLibraryTable`

**Files:**
- Modify: `frontend/src/features/media/MediaLibraryTable.tsx` (whole file,
  currently 108 lines)
- Modify: `frontend/src/features/media/MediaLibraryTable.test.tsx` (whole
  file — every existing mock's `data:` array must be wrapped in the new
  envelope shape, plus new tests for search/filter/sort/pagination)

**Interfaces:**
- Consumes: `useDebouncedValue` (Task 2), `useMediaLibrary` with
  `MediaLibraryParams` (Task 3), `MediaLibraryPagination` (Task 4).

- [ ] **Step 1: Update existing tests for the envelope response shape**

In `frontend/src/features/media/MediaLibraryTable.test.tsx`, every
`vi.mocked(apiClient.GET).mockResolvedValue({ data: [ ... ], error: undefined })`
and `mockImplementation` branch that currently returns a bare array for
the library endpoint must wrap it as
`{ items: [...], total: <items.length>, page: 1, page_size: 25 }`. For
example, the first test's mock (lines 22-38) becomes:

```typescript
vi.mocked(apiClient.GET).mockResolvedValue({
  data: {
    items: [
      {
        id: 1,
        kind: "video",
        filename: "a.mp4",
        title: "A Title",
        procedure_id: null,
        uploaded_at: "2026-07-28T00:00:00Z",
        last_edited_at: "2026-07-29T00:00:00Z",
        size_bytes: 1_200_000,
        linked_sequence_count: 2,
      },
    ],
    total: 1,
    page: 1,
    page_size: 25,
  },
  error: undefined,
} as never);
```

Apply the same wrapping to every other `mockResolvedValue`/
`mockImplementation` return in the file that supplies library data (the
`/taxonomy/procedures` branches inside `mockImplementation` calls stay a
bare array — only the library-endpoint branch/response changes). Do this
for all 8 existing tests in the file.

Then add new tests to the same file, `describe` block:

```typescript
  it("debounces the search input before requesting", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { items: [], total: 0, page: 1, page_size: 25 },
      error: undefined,
    } as never);

    render(<MediaLibraryTable />, { wrapper });
    await screen.findByPlaceholderText(/search/i);

    const initialCallCount = vi.mocked(apiClient.GET).mock.calls.length;
    await userEvent.type(screen.getByPlaceholderText(/search/i), "foo");

    // No new library call fired yet -- still debouncing.
    expect(vi.mocked(apiClient.GET).mock.calls.length).toBe(initialCallCount);

    await waitFor(
      () => {
        const libraryCalls = vi
          .mocked(apiClient.GET)
          .mock.calls.filter((call) => call[0] === "/media/library");
        const lastCall = libraryCalls[libraryCalls.length - 1];
        expect(lastCall?.[1]?.params?.query?.search).toBe("foo");
      },
      { timeout: 1000 }
    );
  });

  it("sends the selected type filter as a query param", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { items: [], total: 0, page: 1, page_size: 25 },
      error: undefined,
    } as never);

    render(<MediaLibraryTable />, { wrapper });
    await screen.findByLabelText(/type/i);

    await userEvent.selectOptions(screen.getByLabelText(/type/i), "video");

    await waitFor(() => {
      const libraryCalls = vi
        .mocked(apiClient.GET)
        .mock.calls.filter((call) => call[0] === "/media/library");
      const lastCall = libraryCalls[libraryCalls.length - 1];
      expect(lastCall?.[1]?.params?.query?.type).toBe("video");
    });
  });

  it("toggles sort order when clicking the same column header twice", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { items: [], total: 0, page: 1, page_size: 25 },
      error: undefined,
    } as never);

    render(<MediaLibraryTable />, { wrapper });
    const sizeHeader = await screen.findByRole("button", { name: /size/i });

    await userEvent.click(sizeHeader);
    await waitFor(() => {
      const libraryCalls = vi
        .mocked(apiClient.GET)
        .mock.calls.filter((call) => call[0] === "/media/library");
      const lastCall = libraryCalls[libraryCalls.length - 1];
      expect(lastCall?.[1]?.params?.query?.sort).toBe("size_bytes");
      expect(lastCall?.[1]?.params?.query?.order).toBe("desc");
    });

    await userEvent.click(sizeHeader);
    await waitFor(() => {
      const libraryCalls = vi
        .mocked(apiClient.GET)
        .mock.calls.filter((call) => call[0] === "/media/library");
      const lastCall = libraryCalls[libraryCalls.length - 1];
      expect(lastCall?.[1]?.params?.query?.sort).toBe("size_bytes");
      expect(lastCall?.[1]?.params?.query?.order).toBe("asc");
    });
  });

  it("renders pagination controls driven by the response envelope", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: {
        items: [
          {
            id: 1,
            kind: "photo",
            filename: "batch-1",
            title: null,
            procedure_id: null,
            uploaded_at: "2026-07-28T00:00:00Z",
            last_edited_at: "2026-07-29T00:00:00Z",
            size_bytes: 1_000,
            linked_sequence_count: 1,
          },
        ],
        total: 60,
        page: 1,
        page_size: 25,
      },
      error: undefined,
    } as never);

    render(<MediaLibraryTable />, { wrapper });

    expect(await screen.findByRole("button", { name: "2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "3" })).toBeInTheDocument();
  });

  it("shows a no-results message when the filtered list is empty", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { items: [], total: 0, page: 1, page_size: 25 },
      error: undefined,
    } as never);

    render(<MediaLibraryTable />, { wrapper });

    expect(await screen.findByText(/no media matches/i)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/media/MediaLibraryTable.test.tsx`
Expected: FAIL — existing tests fail because the component still reads
`libraryQuery.data` as an array (`.map` over `{items, total, ...}` throws
or renders nothing), and the new tests fail because the search box, Type
select, sortable headers, and pagination don't exist yet.

- [ ] **Step 3: Implement the updated `MediaLibraryTable`**

Replace `frontend/src/features/media/MediaLibraryTable.tsx` entirely:

```typescript
import { useState } from "react";

import { useDeleteSequence, useDeleteVideo, useMediaLibrary } from "../../entities/useMediaLibrary";
import type { MediaLibraryParams } from "../../entities/useMediaLibrary";
import { useProcedures } from "../../entities/useProcedures";
import { MediaLibraryPagination } from "./MediaLibraryPagination";
import { useDebouncedValue } from "./useDebouncedValue";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type SortKey = NonNullable<MediaLibraryParams["sort"]>;

const SORTABLE_COLUMNS: { key: SortKey; label: string }[] = [
  { key: "uploaded_at", label: "Uploaded" },
  { key: "last_edited_at", label: "Last edited" },
  { key: "size_bytes", label: "Size" },
  { key: "linked_sequence_count", label: "Sequences" },
];

const PAGE_SIZE = 25;

export function MediaLibraryTable({
  onSelectVideo,
}: {
  onSelectVideo?: (videoId: number) => void;
} = {}) {
  const [searchInput, setSearchInput] = useState("");
  const search = useDebouncedValue(searchInput, 300);
  const [type, setType] = useState<"video" | "photo" | undefined>(undefined);
  const [procedureId, setProcedureId] = useState<number | undefined>(undefined);
  const [sort, setSort] = useState<SortKey>("uploaded_at");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  const libraryQuery = useMediaLibrary({
    search: search || undefined,
    type,
    procedureId,
    sort,
    order,
    page,
    pageSize: PAGE_SIZE,
  });
  const proceduresQuery = useProcedures();
  const deleteVideo = useDeleteVideo();
  const deleteSequence = useDeleteSequence();
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [errorsByKey, setErrorsByKey] = useState<Record<string, string>>({});

  function handleDelete(id: number, kind: "video" | "photo") {
    const key = `${kind}-${id}`;
    const mutation = kind === "video" ? deleteVideo : deleteSequence;
    mutation.mutate(id, {
      onSuccess: () => {
        setConfirmingKey(null);
        setErrorsByKey((errors) => ({ ...errors, [key]: "" }));
      },
      onError: (error: unknown) => {
        const detail = (error as { detail?: string } | undefined)?.detail ?? "Delete failed";
        setErrorsByKey((errors) => ({ ...errors, [key]: detail }));
      },
    });
  }

  function handleSortClick(key: SortKey) {
    if (sort === key) {
      setOrder((current) => (current === "desc" ? "asc" : "desc"));
    } else {
      setSort(key);
      setOrder("desc");
    }
    setPage(1);
  }

  function handleFilterChange<T>(setter: (value: T) => void, value: T) {
    setter(value);
    setPage(1);
  }

  const items = libraryQuery.data?.items ?? [];
  const total = libraryQuery.data?.total ?? 0;

  return (
    <div>
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 z-10 bg-gray-900 text-xs uppercase text-gray-400">
          <tr>
            <th className="py-1.5 px-3">
              <div>Filename</div>
              <input
                type="text"
                placeholder="Search..."
                value={searchInput}
                onChange={(e) => {
                  setSearchInput(e.target.value);
                  setPage(1);
                }}
                className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs normal-case text-gray-100"
              />
            </th>
            <th className="py-1.5 px-3">
              <label htmlFor="media-type-filter">Type</label>
              <select
                id="media-type-filter"
                value={type ?? ""}
                onChange={(e) =>
                  handleFilterChange(setType, (e.target.value || undefined) as "video" | "photo" | undefined)
                }
                className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs normal-case text-gray-100"
              >
                <option value="">All types</option>
                <option value="video">video</option>
                <option value="photo">photo</option>
              </select>
            </th>
            <th className="py-1.5 px-3">
              <label htmlFor="media-procedure-filter">Procedure</label>
              <select
                id="media-procedure-filter"
                value={procedureId ?? ""}
                onChange={(e) =>
                  handleFilterChange(
                    setProcedureId,
                    e.target.value ? Number(e.target.value) : undefined
                  )
                }
                className="mt-1 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs normal-case text-gray-100"
              >
                <option value="">All procedures</option>
                {(proceduresQuery.data ?? []).map((procedure) => (
                  <option key={procedure.id} value={procedure.id}>
                    {procedure.name}
                  </option>
                ))}
              </select>
            </th>
            {SORTABLE_COLUMNS.map((column) => (
              <th key={column.key} className="py-1.5 px-3">
                <button
                  onClick={() => handleSortClick(column.key)}
                  className="flex items-center gap-1 uppercase text-gray-400 hover:text-gray-200"
                >
                  {column.label}
                  {sort === column.key && <span>{order === "desc" ? "▼" : "▲"}</span>}
                </button>
              </th>
            ))}
            <th className="py-1.5 px-3" />
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={8} className="py-4 px-3 text-center text-gray-500">
                No media matches your filters
              </td>
            </tr>
          ) : (
            items.map((item) => {
              const key = `${item.kind}-${item.id}`;
              const procedureName =
                item.procedure_id === null
                  ? "—"
                  : (proceduresQuery.data?.find((procedure) => procedure.id === item.procedure_id)?.name ??
                    item.procedure_id);
              return (
                <tr key={key} className="border-b border-gray-800 hover:bg-gray-900/50">
                  <td
                    className={`py-1.5 px-3 text-gray-100 ${item.kind === "video" ? "cursor-pointer text-blue-400 hover:text-blue-300 hover:underline" : ""}`}
                    onClick={item.kind === "video" ? () => onSelectVideo?.(item.id) : undefined}
                  >
                    {item.kind === "video" ? (
                      <div>
                        <div>{item.title}</div>
                        <div className="text-xs text-gray-500">{item.filename}</div>
                      </div>
                    ) : (
                      item.filename
                    )}
                  </td>
                  <td className="py-1.5 px-3 text-gray-100">{item.kind}</td>
                  <td className="py-1.5 px-3 text-gray-100">{procedureName}</td>
                  <td className="py-1.5 px-3 text-gray-100">{new Date(item.uploaded_at).toLocaleDateString()}</td>
                  <td className="py-1.5 px-3 text-gray-100">{new Date(item.last_edited_at).toLocaleDateString()}</td>
                  <td className="py-1.5 px-3 text-gray-100">{formatSize(item.size_bytes)}</td>
                  <td className="py-1.5 px-3 text-gray-100">{item.linked_sequence_count}</td>
                  <td className="py-1.5 px-3 text-right">
                    {confirmingKey === key ? (
                      <button
                        onClick={() => handleDelete(item.id, item.kind)}
                        className="rounded bg-red-700 px-3 py-1.5 text-white hover:bg-red-600"
                      >
                        Confirm
                      </button>
                    ) : (
                      <button
                        onClick={() => setConfirmingKey(key)}
                        className="rounded border border-gray-700 px-3 py-1.5 text-gray-100 hover:bg-gray-800"
                      >
                        Delete
                      </button>
                    )}
                    {errorsByKey[key] && <p className="mt-1 text-xs text-red-400">{errorsByKey[key]}</p>}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
      <MediaLibraryPagination total={total} page={page} pageSize={PAGE_SIZE} onPageChange={setPage} />
    </div>
  );
}
```

Note: the `<th>` elements now hold `<label>`/`<input>`/`<select>` in
addition to their text label, so `normal-case` is applied to those
controls to counteract the `<thead>`'s `uppercase` styling (which would
otherwise all-caps the search placeholder and select options).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/media/MediaLibraryTable.test.tsx`
Expected: PASS (all 13 tests — 8 updated + 5 new)

- [ ] **Step 5: Run the full frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: PASS — confirms no other component consuming `useMediaLibrary`
or `MediaLibraryTable` broke. (Per the File Structure section, no other
file imports `useMediaLibrary`.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/entities/useMediaLibrary.ts frontend/src/features/media/MediaLibraryTable.tsx frontend/src/features/media/MediaLibraryTable.test.tsx
git commit -m "feat: add search, filters, sortable columns, and pagination to media library table"
```

---

## Task 6: Manual verification in a real browser

Per this repo's testing philosophy (ROADMAP.md's Phase 1 deviation log):
unit tests mock `apiClient` entirely and can't catch integration issues
like a param name mismatch between frontend and backend. Exercise this
for real before considering the feature done.

- [ ] **Step 1: Start the stack**

Ensure `docker compose up -d`, backend (`cd backend && uv run uvicorn app.main:app --reload`),
and frontend (`cd frontend && npm run dev`) are all running.

- [ ] **Step 2: Click through the feature**

In a browser, navigate to the media library page and verify:
- Typing in the Filename search box narrows the table after a brief pause.
- Selecting a Type filters to just video or just photo rows.
- Selecting a Procedure filters to that procedure's rows.
- Clicking "Uploaded", "Last edited", "Size", "Sequences" headers sorts
  the table; clicking the same header again reverses the order; the
  arrow indicator matches the active column/direction.
- If there are more than 25 rows total, pagination controls appear below
  the table and clicking a page number or Previous/Next changes the
  visible rows.
- If there are 25 or fewer rows, no pagination controls render.
- Combining a search term with a filter and a sort produces the expected
  narrowed, ordered result.

- [ ] **Step 3: Report result**

State explicitly whether manual verification passed or what broke — do
not claim the feature works based on unit tests alone.

---

## Self-Review Notes

- **Spec coverage:** search (Task 1 backend + Task 5 frontend), Type/
  Procedure single-select filters (Task 1 + Task 5), sortable Uploaded/
  Last edited/Size/Sequences columns with asc/desc toggle (Task 1 + Task
  5), page-number pagination (Task 1 + Task 4 + Task 5), Filename
  search-only/no-sort (Task 5 — no sort button rendered for the Filename
  column), single-select (not multi-select) Type/Procedure (Task 5 uses
  `<select>`, not checkboxes), empty-filter no-results message (Task 5).
  All spec sections have a covering task.
- **Placeholder scan:** no TBD/TODO markers; every step has literal code.
- **Type consistency:** `MediaLibraryParams.sort` (Task 3) matches the
  backend's `Literal["uploaded_at", "last_edited_at", "size_bytes", "linked_sequence_count"]`
  (Task 1) and the `SortKey` type/`SORTABLE_COLUMNS` keys used in Task 5.
  `MediaLibraryPagination`'s props (`total`, `page`, `pageSize`,
  `onPageChange`) as defined in Task 4 match exactly how Task 5 invokes
  it. `useDebouncedValue<T>(value, delayMs)` signature from Task 2
  matches its Task 5 call site (`useDebouncedValue(searchInput, 300)`).
