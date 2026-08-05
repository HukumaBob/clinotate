# Media Library Title + Sticky Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each video's user-supplied title (not just its raw filename) in the media library table, and keep the upload forms / video player fixed on screen while only the library table scrolls.

**Architecture:** One backend change (add `title` to `MediaLibraryItem`, populate it from `Video.title` for video rows and `None` for photo rows) and two frontend changes (render title+filename as a two-line cell in `MediaLibraryTable.tsx`; restructure `MediaPage.tsx`'s root into a fixed-viewport flex layout with a scrollable table region).

**Tech Stack:** FastAPI + SQLAlchemy (backend), React + TypeScript + Vitest/Testing Library (frontend), Tailwind CSS.

## Global Constraints

- Language: English only — code, comments, docstrings, UI copy. No Russian anywhere in the repo (per CLAUDE.md).
- Dark theme only — don't introduce light-background Tailwind classes.
- TDD: every backend task and every frontend task with logic gets a failing test before the implementation.
- API contract: the frontend TypeScript client is generated from `openapi.json` — never write a hand-rolled, untyped `fetch()`. After the backend schema change, regenerate `openapi.json` via `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py` and verify with `git diff --stat openapi.json` that it changed, before the frontend's `generate-api` hook (`npm run dev`/`build`/`test` all run this automatically) can pick up the new `title` field.
- Photo-sequence rows have no `title` concept — only `Sequence.name`, already shown as `filename`. `title` must be `None` for `kind: "photo"` items, never omitted or defaulted to `""`.

---

### Task 1: Backend — add `title` to `MediaLibraryItem`

**Files:**
- Modify: `backend/app/media/schemas.py:101-106` (`MediaLibraryItem`)
- Modify: `backend/app/media/router.py:131-169` (`get_media_library`)
- Test: `backend/tests/test_media.py` (extend `test_media_library_lists_videos_and_photo_sequences`, around line 595-635)

**Interfaces:**
- Consumes: existing `Video.title` (`str`, always set — required at upload time) and `Sequence` model (no `title` column) from `backend/app/media/models.py`.
- Produces: `MediaLibraryItem.title: str | None` — populated with the video's title for `kind: "video"` items, `None` for `kind: "photo"` items. This is what Task 2's frontend TypeScript type (`components["schemas"]["MediaLibraryItem"]`, regenerated from `openapi.json`) will expose as `title: string | null`.

- [ ] **Step 1: Write the failing test**

Open `backend/tests/test_media.py` and find `test_media_library_lists_videos_and_photo_sequences` (around line 595). Replace its two assertion blocks at the end (lines 628-634) with:

```python
    response = client.get("/media/library", headers=headers)

    assert response.status_code == 200
    items = response.json()
    video_item = next(i for i in items if i["kind"] == "video" and i["filename"] == "library_video.mp4")
    assert video_item["linked_sequence_count"] == 1
    assert video_item["title"] == "Library video"

    photo_item = next(i for i in items if i["kind"] == "photo" and i["id"] == photo_sequence_id)
    assert photo_item["linked_sequence_count"] == 1
    assert photo_item["filename"] == "Library photo seq"
    assert photo_item["title"] is None
```

(The video was uploaded earlier in this same test with `data={"title": "Library video", ...}` at line 605 — this just asserts that title round-trips through the library endpoint. No new fixture setup needed.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_media.py::test_media_library_lists_videos_and_photo_sequences -v`
Expected: FAIL with `KeyError: 'title'` (the field doesn't exist on the response yet).

- [ ] **Step 3: Add the field to the schema**

In `backend/app/media/schemas.py`, find `MediaLibraryItem` (around line 101):

```python
class MediaLibraryItem(BaseModel):
    id: int
    kind: Literal["video", "photo"]
    filename: str
    procedure_id: int | None
    uploaded_at: datetime
    size_bytes: int
    linked_sequence_count: int
```

Add `title`:

```python
class MediaLibraryItem(BaseModel):
    id: int
    kind: Literal["video", "photo"]
    filename: str
    title: str | None
    procedure_id: int | None
    uploaded_at: datetime
    size_bytes: int
    linked_sequence_count: int
```

- [ ] **Step 4: Populate the field in the endpoint**

In `backend/app/media/router.py`, find `get_media_library` (around line 131). In the video loop (around line 138-148), add `title=video.title` to the `MediaLibraryItem(...)` call:

```python
        items.append(
            MediaLibraryItem(
                id=video.id,
                kind="video",
                filename=video.filename,
                title=video.title,
                procedure_id=video.procedure_id,
                uploaded_at=video.created_at,
                size_bytes=video.size_bytes,
                linked_sequence_count=linked_count,
            )
        )
```

In the photo-sequence loop (around line 156-166), add `title=None`:

```python
        items.append(
            MediaLibraryItem(
                id=sequence.id,
                kind="photo",
                filename=sequence.name,
                title=None,
                procedure_id=sequence.procedure_id,
                uploaded_at=sequence.created_at,
                size_bytes=total_size,
                linked_sequence_count=1,
            )
        )
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && uv run pytest tests/test_media.py::test_media_library_lists_videos_and_photo_sequences -v`
Expected: PASS.

- [ ] **Step 6: Run the full backend media test file to check for regressions**

Run: `cd backend && uv run pytest tests/test_media.py -v`
Expected: all PASS.

- [ ] **Step 7: Regenerate OpenAPI schema**

```bash
cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py
git diff --stat openapi.json
```

Expected: `openapi.json` shows a diff (the `MediaLibraryItem` schema gained a `title` field). This file must be committed alongside the code change — the frontend's `generate-api` step reads it, not the live backend.

- [ ] **Step 8: Commit**

```bash
git add backend/app/media/schemas.py backend/app/media/router.py backend/tests/test_media.py openapi.json
git commit -m "$(cat <<'EOF'
feat: add video title to media library API response

MediaLibraryItem.filename for video rows was video.filename (the raw
uploaded filename), never video.title (the name the user typed at
upload time) — rows with identical filenames were indistinguishable.
Photo-sequence rows have no separate title concept, so title is null
there.
EOF
)"
```

---

### Task 2: Frontend — two-line title/filename cell in `MediaLibraryTable`

**Files:**
- Modify: `frontend/src/features/media/MediaLibraryTable.tsx:55-60`
- Test: `frontend/src/features/media/MediaLibraryTable.test.tsx`

**Interfaces:**
- Consumes: `MediaLibraryItem.title: string | null` from Task 1's regenerated `frontend/src/shared/api/generated/schema.d.ts` (run automatically by `npm run test`'s `pretest` hook — no manual regen step needed here, but the mocked test data must include a `title` field on every item since the real API now always returns one).
- Produces: no new exported symbols; the existing filename `<td>` cell gains conditional two-line markup for video rows.

- [ ] **Step 1: Write the failing tests**

Every existing mock in `frontend/src/features/media/MediaLibraryTable.test.tsx` supplies `apiClient.GET`'s mocked data without a `title` field. Since the real (generated) type will now require `title: string | null` on every item, update each existing mock object in this file to add a `title` field — this keeps the mocks honest with the real schema even though `vi.mocked(...).mockResolvedValue(... as never)` bypasses compile-time checking. For the video items (lines 27, 59), add `title: "A Title"` and `title: "Video Five"` respectively (any distinct placeholder). For the photo items (line 68, 119) and the second video/click tests (line 96), add `title: null` for photo rows and a distinct string for video rows — match whichever `kind` each object has:
  - Line 27-33 (`a.mp4`, kind: video): add `title: "A Title"`
  - Line 58-64 (`video-five.mp4`, kind: video): add `title: "Video Five"`
  - Line 66-73 (`photo-sequence-five`, kind: photo): add `title: null`
  - Line 94-101 (`clickme.mp4`, kind: video): add `title: "Click Me Video"`
  - Line 117-124 (`batch-1`, kind: photo): add `title: null`

Then add two new tests at the end of the `describe("MediaLibraryTable", ...)` block (after the last existing test, before the closing `});`):

```typescript
  it("shows the video's title as the primary text with the filename as a secondary line", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: [
        {
          id: 20,
          kind: "video",
          filename: "raw_upload_20260101.mp4",
          title: "Colonoscopy patient 42",
          procedure_id: null,
          uploaded_at: "2026-07-28T00:00:00Z",
          size_bytes: 1_000,
          linked_sequence_count: 0,
        },
      ],
      error: undefined,
    } as never);

    render(<MediaLibraryTable />, { wrapper });

    expect(await screen.findByText("Colonoscopy patient 42")).toBeInTheDocument();
    expect(screen.getByText("raw_upload_20260101.mp4")).toBeInTheDocument();
  });

  it("shows only the filename for a photo row, with no secondary line or null artifact", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: [
        {
          id: 21,
          kind: "photo",
          filename: "photo-batch-21",
          title: null,
          procedure_id: null,
          uploaded_at: "2026-07-28T00:00:00Z",
          size_bytes: 1_000,
          linked_sequence_count: 1,
        },
      ],
      error: undefined,
    } as never);

    render(<MediaLibraryTable />, { wrapper });

    expect(await screen.findByText("photo-batch-21")).toBeInTheDocument();
    expect(screen.queryByText("null")).not.toBeInTheDocument();
    expect(screen.queryByText("undefined")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify the two new tests fail**

Run: `cd frontend && npx vitest run src/features/media/MediaLibraryTable.test.tsx -t "title"`
Expected: FAIL — `screen.findByText("Colonoscopy patient 42")` doesn't find anything, since the component still only renders `item.filename`.

- [ ] **Step 3: Implement the two-line cell**

In `frontend/src/features/media/MediaLibraryTable.tsx`, find the filename `<td>` (around lines 55-60):

```tsx
              <td
                className={`py-1.5 px-3 text-gray-100 ${item.kind === "video" ? "cursor-pointer text-blue-400 hover:text-blue-300 hover:underline" : ""}`}
                onClick={item.kind === "video" ? () => onSelectVideo?.(item.id) : undefined}
              >
                {item.filename}
              </td>
```

Replace its contents with a conditional: video rows render title (primary) + filename (secondary, small/dim); photo rows keep the current single-line filename. The cell's className, hover/cursor styling, and onClick stay exactly as they are — only the inner content changes:

```tsx
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/media/MediaLibraryTable.test.tsx`
Expected: all PASS, including every pre-existing test (the video rows' text queries like `screen.findByText("a.mp4")`, `screen.findByText("clickme.mp4")` still work since the filename is still rendered as visible text, just now inside a nested `<div>` rather than directly in the `<td>`).

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/features/media/MediaLibraryTable.tsx src/features/media/MediaLibraryTable.test.tsx
git commit -m "$(cat <<'EOF'
feat: show video title above filename in media library table

Video rows previously showed only the raw filename (e.g.
raw_upload_20260101.mp4), which is indistinguishable across uploads
that share a filename. Photo rows are unchanged -- they have no
separate title, only the already-shown sequence name.
EOF
)"
```

---

### Task 3: Frontend — sticky upload/player zone, scrollable table

**Files:**
- Modify: `frontend/src/features/media/MediaPage.tsx`

**Interfaces:**
- Consumes: nothing new — same props/children (`VideoUploadFlow`, `PhotosUploadFlow`, `VideoReviewPlayer`, `MediaLibraryTable`) as today.
- Produces: no new exported symbols or props — this is a pure layout/CSS restructuring of the existing JSX tree.

This task has no unit-testable logic (it's a CSS layout change), so there is no TDD test-first step here — per the plan's Testing section, this is verified manually in the browser instead. Do not skip the manual verification step below.

- [ ] **Step 1: Restructure the root layout**

Read the current `frontend/src/features/media/MediaPage.tsx` in full first (it's short, ~37 lines) to confirm nothing about its structure has changed since this plan was written. Then replace the component body:

Current:
```tsx
  return (
    <div className="min-h-screen bg-gray-950 p-8 text-gray-100">
      <div className="mb-6">
        {selectedVideoId !== null ? (
          <VideoReviewPlayer
            videoId={selectedVideoId}
            onBack={() => setSelectedVideoId(null)}
            onOpenSequence={goToSequence}
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <VideoUploadFlow onVideoUploaded={setSelectedVideoId} />
            <PhotosUploadFlow onCreated={goToSequence} />
          </div>
        )}
      </div>
      <MediaLibraryTable onSelectVideo={setSelectedVideoId} />
    </div>
  );
```

New — root becomes a flex column that fills its parent; the upload/player block keeps its own top padding and no longer scrolls with the page; the table moves into a `flex-1 overflow-y-auto` region that gets the bottom padding and scrolls independently. `MediaPage` renders inside `AppLayout`'s `<main className="flex-1 overflow-auto">`, not directly into the viewport (which sits below a `h-14` header inside `AppLayout`'s own `h-screen` column), so it must size against that parent with `h-full`, not against `100vh` with `h-screen` — matching the pattern already used by `SequenceGridPage`/`VideoListPage` (`min-h-full`):

```tsx
  return (
    <div className="flex h-full flex-col overflow-hidden bg-gray-950 text-gray-100">
      <div className="shrink-0 px-8 pt-8">
        {selectedVideoId !== null ? (
          <VideoReviewPlayer
            videoId={selectedVideoId}
            onBack={() => setSelectedVideoId(null)}
            onOpenSequence={goToSequence}
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <VideoUploadFlow onVideoUploaded={setSelectedVideoId} />
            <PhotosUploadFlow onCreated={goToSequence} />
          </div>
        )}
      </div>
      <div className="mt-6 flex-1 overflow-y-auto px-8 pb-8">
        <MediaLibraryTable onSelectVideo={setSelectedVideoId} />
      </div>
    </div>
  );
```

Notes on this mapping: the old outer `p-8` (8-unit padding on all sides) is split into `px-8 pt-8` on the top region (keeps left/right/top padding) and `px-8 pb-8` on the scroll region (keeps left/right/bottom padding — the two regions' side padding must match so content doesn't visually shift left/right between them). The old `mb-6` spacer between the upload block and the table becomes `mt-6` on the scroll region, preserving the same visual gap. `shrink-0` on the top region stops flexbox from compressing it if the scroll region's content is tall — without it, a flex child with no explicit height can shrink below its content's natural size. Using `h-full` instead of `h-screen` is load-bearing, not cosmetic: `h-screen` (`100vh`) is 56px taller than `MediaPage`'s actual parent (`AppLayout`'s `<main>`, which sits below a `h-14` header), so it would overflow that container and produce a second, outer scrollbar that defeats the sticky layout entirely.

- [ ] **Step 2: Type-check and run the full frontend test suite**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `cd frontend && npx vitest run`
Expected: all PASS (this is a pure layout change with no logic, so no test in the suite should reference these specific classNames — if any test unexpectedly fails, it means a test was asserting on `MediaPage`'s DOM structure in a way this refactor broke, and that needs investigating, not silencing).

- [ ] **Step 3: Manual browser verification**

Per this codebase's standing testing philosophy (CLAUDE.md: unit tests mock `apiClient` and can't catch a real layout/CSS problem), verify by hand against the running stack:

```bash
docker compose up -d
cd backend && uv run uvicorn app.main:app --reload &
cd frontend && npm run dev &
```

In the browser, navigate to the Media page (log in first if needed — see project memory for the standing `manualcheck@example.com` login, or use the normal login flow). Upload or ensure there are enough videos/photos in the library that the table's content exceeds the visible viewport height (at least ~15-20 rows; if there aren't enough already, the existing library from prior manual testing sessions should suffice, or upload a few dummy fixtures).

Confirm:
1. With no video selected, the "Upload video" / "Upload photos" forms stay visible and stationary while scrolling down through the table below them.
2. Click a video row to open `VideoReviewPlayer`. Confirm the player (video element, mark/timeline controls) stays visible and stationary while scrolling the table below it.
3. Confirm the table itself scrolls smoothly within its own region — no double scrollbar, no content clipped at the boundary between the fixed zone and the scrollable zone.
4. Confirm there's no visible layout shift or misalignment between the fixed zone's left/right edges and the table's left/right edges (this checks the `px-8` padding split from Step 1 was done correctly).

Report the result of this manual check plainly — don't mark the task complete until all four points are confirmed working.

- [ ] **Step 4: Commit**

```bash
cd frontend && git add src/features/media/MediaPage.tsx
git commit -m "$(cat <<'EOF'
fix: keep upload forms and video player fixed while scrolling table

MediaPage previously scrolled as one unit, carrying the upload forms
(or an open VideoReviewPlayer) off-screen once the media library
table grew long. The table is a secondary reference/selection list;
the upload/player zone is the primary working area and should stay
in view.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** both spec decisions (title added to `MediaLibraryItem`, two-line video-row cell; sticky-header layout with independently-scrolling table) map to Tasks 1-3. The spec's "Out of scope" items (no column/sort/delete changes beyond the cell rendering, no internal `VideoReviewPlayer` scroll changes, no title field for photo sequences) are respected — no task touches those.
- **Placeholder scan:** Task 3 has no TDD test-first step by design (pure CSS/layout, no unit-testable logic) — this is explicitly called out rather than silently skipped, and a concrete manual-verification checklist replaces it, consistent with the spec's own Testing section.
- **Type/name consistency:** `MediaLibraryItem.title: str | None` (Task 1, backend) maps to `title: string | null` on the generated TypeScript type consumed in Task 2's test mocks and the `item.title` access in `MediaLibraryTable.tsx`. No naming drift between tasks.
