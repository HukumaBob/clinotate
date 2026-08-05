# Media Library "Last Edited" Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Last edited" column to the media library table, computed live as the max `created_at` across each row's nested sequences/frames/annotations.

**Architecture:** One backend change (compute `last_edited_at` per item in `GET /media/library` via SQL aggregation, add it to `MediaLibraryItem`) and one frontend change (render the new column in `MediaLibraryTable.tsx`, same date format as `Uploaded`).

**Tech Stack:** FastAPI + SQLAlchemy (backend), React + TypeScript + Vitest/Testing Library (frontend).

## Global Constraints

- Language: English only — code, comments, docstrings, UI copy. No Russian anywhere in the repo (per CLAUDE.md).
- TDD: every backend task and every frontend task with logic gets a failing test before the implementation.
- No new database column or migration — `last_edited_at` is computed live in SQL on every request, not stored.
- "Edit" scope for this change is creation/deletion of `Sequence` and `Annotation` rows only (via their `created_at`). Annotation status changes do NOT move "Last edited" — `Annotation` has no `updated_at` yet, and adding one is explicitly out of scope.
- Display format matches the existing `Uploaded` column exactly: `new Date(item.last_edited_at).toLocaleDateString()` — date only, no time, no relative phrasing.

---

### Task 1: Backend — compute and expose `last_edited_at`

**Files:**
- Modify: `backend/app/media/schemas.py:101-109` (`MediaLibraryItem`)
- Modify: `backend/app/media/router.py:131-171` (`get_media_library`)
- Test: `backend/tests/test_media.py` (extend `test_media_library_lists_videos_and_photo_sequences`, currently at line 595-636)

**Interfaces:**
- Consumes: existing `Video`, `Sequence`, `Frame`, `Annotation` models from `backend/app/media/models.py` and `backend/app/annotation/models.py` (already imported in `router.py` — `Frame`, `Sequence`, `Video` at line 16, `Annotation` at line 9). Uses `sqlalchemy.func` (already imported at `router.py:6`).
- Produces: `MediaLibraryItem.last_edited_at: datetime` — populated for every item (video and photo rows alike). This is what Task 2's frontend consumes as `item.last_edited_at` via the regenerated `frontend/src/shared/api/generated/schema.d.ts`.

- [ ] **Step 1: Write the failing test**

Open `backend/tests/test_media.py` and find `test_media_library_lists_videos_and_photo_sequences` (line 595). Replace the whole test body with a version that also creates an annotation and asserts `last_edited_at` moves forward. This reuses the exact get-or-create taxonomy pattern already established later in this same file (see `_get_or_create_label` around line 1158) — copy that pattern rather than inventing a new one:

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
    items = response.json()
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
    items_after = response_after.json()
    video_item_after = next(
        i for i in items_after if i["kind"] == "video" and i["filename"] == "library_video.mp4"
    )
    assert video_item_after["last_edited_at"] >= before_last_edited
    assert video_item_after["last_edited_at"] > video_item_after["uploaded_at"]
```

Note: comparing ISO-format datetime strings with `>=`/`>` works correctly here because FastAPI/Pydantic serializes `datetime` fields as ISO 8601 strings with zero-padded, fixed-width components, which sort lexicographically the same as chronologically.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest tests/test_media.py::test_media_library_lists_videos_and_photo_sequences -v`
Expected: FAIL with `KeyError: 'last_edited_at'` (the field doesn't exist on the response yet).

- [ ] **Step 3: Add the field to the schema**

In `backend/app/media/schemas.py`, find `MediaLibraryItem` (line 101):

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

Add `last_edited_at` after `uploaded_at`:

```python
class MediaLibraryItem(BaseModel):
    id: int
    kind: Literal["video", "photo"]
    filename: str
    title: str | None
    procedure_id: int | None
    uploaded_at: datetime
    last_edited_at: datetime
    size_bytes: int
    linked_sequence_count: int
```

- [ ] **Step 4: Compute `last_edited_at` in the endpoint**

In `backend/app/media/router.py`, find `get_media_library` (line 131). Replace the whole function body with a version that computes `last_edited_at` for both branches:

```python
@router.get("/library", response_model=list[MediaLibraryItem])
def get_media_library(session: Session = Depends(get_session)) -> list[MediaLibraryItem]:
    items: list[MediaLibraryItem] = []

    videos = session.query(Video).all()
    for video in videos:
        sequences = session.query(Sequence).filter(Sequence.video_id == video.id).all()
        linked_count = len(sequences)
        sequence_ids = [s.id for s in sequences]
        annotation_max = (
            session.query(func.max(Annotation.created_at))
            .join(Frame, Annotation.frame_id == Frame.id)
            .filter(Frame.sequence_id.in_(sequence_ids))
            .scalar()
            if sequence_ids
            else None
        )
        candidates = [video.created_at] + [s.created_at for s in sequences]
        if annotation_max is not None:
            candidates.append(annotation_max)
        last_edited_at = max(candidates)
        items.append(
            MediaLibraryItem(
                id=video.id,
                kind="video",
                filename=video.filename,
                title=video.title,
                procedure_id=video.procedure_id,
                uploaded_at=video.created_at,
                last_edited_at=last_edited_at,
                size_bytes=video.size_bytes,
                linked_sequence_count=linked_count,
            )
        )

    photo_sequences = session.query(Sequence).filter(Sequence.video_id.is_(None)).all()
    for sequence in photo_sequences:
        total_size = (
            session.query(func.sum(Frame.size_bytes)).filter(Frame.sequence_id == sequence.id).scalar()
            or 0
        )
        annotation_max = (
            session.query(func.max(Annotation.created_at))
            .join(Frame, Annotation.frame_id == Frame.id)
            .filter(Frame.sequence_id == sequence.id)
            .scalar()
        )
        last_edited_at = max(sequence.created_at, annotation_max) if annotation_max is not None else sequence.created_at
        items.append(
            MediaLibraryItem(
                id=sequence.id,
                kind="photo",
                filename=sequence.name,
                title=None,
                procedure_id=sequence.procedure_id,
                uploaded_at=sequence.created_at,
                last_edited_at=last_edited_at,
                size_bytes=total_size,
                linked_sequence_count=1,
            )
        )

    items.sort(key=lambda item: item.uploaded_at, reverse=True)
    return items
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

Expected: `openapi.json` shows a diff (the `MediaLibraryItem` schema gained a `last_edited_at` field). This file must be committed alongside the code change — the frontend's `generate-api` step reads it, not the live backend.

- [ ] **Step 8: Commit**

```bash
git add backend/app/media/schemas.py backend/app/media/router.py backend/tests/test_media.py openapi.json
git commit -m "$(cat <<'EOF'
feat: compute last_edited_at for media library items

Uploaded only reflects original upload time, never later activity
(new sequences cut from a video, new annotations on its frames).
last_edited_at is the max created_at across a row's nested
sequences/frames/annotations, computed live -- no new column, no
migration, no risk of a stale cached value.
EOF
)"
```

---

### Task 2: Frontend — render the "Last edited" column

**Files:**
- Modify: `frontend/src/features/media/MediaLibraryTable.tsx:43-49` (header), `:76-77` (row cells)
- Test: `frontend/src/features/media/MediaLibraryTable.test.tsx`

**Interfaces:**
- Consumes: `MediaLibraryItem.last_edited_at: string` (ISO datetime) from Task 1's regenerated `frontend/src/shared/api/generated/schema.d.ts` (run automatically by `npm run test`'s `pretest` hook — no manual regen step needed, but every mocked test-data item in this file must include a `last_edited_at` field since the real API now always returns one).
- Produces: no new exported symbols; the existing table gains one column.

- [ ] **Step 1: Write the failing tests**

Every existing mock object in `frontend/src/features/media/MediaLibraryTable.test.tsx` lacks a `last_edited_at` field. Add one to each existing mock item (there are 7 mock objects in this file as of the last change — one per `it(...)` block plus the two-item test). Use a value distinct from `uploaded_at` so the two columns are visibly different in a snapshot-style read, e.g. for an item with `uploaded_at: "2026-07-28T00:00:00Z"` add `last_edited_at: "2026-07-29T00:00:00Z"`.

Then add a new test at the end of the `describe("MediaLibraryTable", ...)` block (after the last existing test, before the closing `});`):

```typescript
  it("shows the Last edited date, distinct from Uploaded", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: [
        {
          id: 22,
          kind: "video",
          filename: "edited.mp4",
          title: "Edited video",
          procedure_id: null,
          uploaded_at: "2026-07-01T00:00:00Z",
          last_edited_at: "2026-07-15T00:00:00Z",
          size_bytes: 1_000,
          linked_sequence_count: 1,
        },
      ],
      error: undefined,
    } as never);

    render(<MediaLibraryTable />, { wrapper });

    await screen.findByText("edited.mp4");
    expect(screen.getByText(new Date("2026-07-01T00:00:00Z").toLocaleDateString())).toBeInTheDocument();
    expect(screen.getByText(new Date("2026-07-15T00:00:00Z").toLocaleDateString())).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify the new test fails**

Run: `cd frontend && npx vitest run src/features/media/MediaLibraryTable.test.tsx -t "Last edited"`
Expected: FAIL — the second `screen.getByText(...)` assertion finds nothing, since the column doesn't exist yet.

- [ ] **Step 3: Add the column**

In `frontend/src/features/media/MediaLibraryTable.tsx`, add the header cell after `Uploaded` (line 46):

```tsx
          <th className="py-1.5 px-3">Filename</th>
          <th className="py-1.5 px-3">Type</th>
          <th className="py-1.5 px-3">Procedure</th>
          <th className="py-1.5 px-3">Uploaded</th>
          <th className="py-1.5 px-3">Last edited</th>
          <th className="py-1.5 px-3">Size</th>
          <th className="py-1.5 px-3">Sequences</th>
          <th className="py-1.5 px-3" />
```

Add the corresponding row cell after the `Uploaded` cell (line 77), using the exact same formatting call:

```tsx
              <td className="py-1.5 px-3 text-gray-100">{new Date(item.uploaded_at).toLocaleDateString()}</td>
              <td className="py-1.5 px-3 text-gray-100">{new Date(item.last_edited_at).toLocaleDateString()}</td>
              <td className="py-1.5 px-3 text-gray-100">{formatSize(item.size_bytes)}</td>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/media/MediaLibraryTable.test.tsx`
Expected: all PASS, including every pre-existing test in this file.

- [ ] **Step 5: Run the full frontend test suite and type check**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `cd frontend && npx vitest run`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd frontend && git add src/features/media/MediaLibraryTable.tsx src/features/media/MediaLibraryTable.test.tsx
git commit -m "$(cat <<'EOF'
feat: show Last edited column in media library table

Renders the last_edited_at field added to the API in the previous
commit, using the same toLocaleDateString formatting already used by
the Uploaded column.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** all four spec decisions (max-created_at formula scoped to Sequence/Annotation only; live SQL computation, no migration; annotation status changes excluded; display format matching `Uploaded`) map to Tasks 1-2. The spec's "Out of scope" items (no `Annotation.updated_at`, no relative time formatting, no change to `Uploaded` itself) are respected — no task touches those.
- **Placeholder scan:** none found — both tasks contain complete, runnable code for every step, including the full replacement test body and full replacement endpoint body (chosen over a diff/patch description since the function's structure changes enough that showing exact before/after context inline would be more error-prone to apply than a clean replacement).
- **Type/name consistency:** `MediaLibraryItem.last_edited_at: datetime` (Task 1, backend) maps to `item.last_edited_at` access in Task 2's JSX and test mocks, formatted identically to `item.uploaded_at`. No naming drift between tasks.
