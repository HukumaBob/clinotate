# SequenceForm Delete + Open-in-Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Delete button and an "Open in editor" button to `SequenceForm`'s edit mode, and remove the now-redundant "open in editor" link from timeline segments (it was nearly unclickable on short segments).

**Architecture:** One backend change (widen `DELETE /media/sequences/{id}` to accept video-linked sequences, closing a deliberate-but-incomplete guard) and three frontend changes (`SequenceForm.tsx` gains the two buttons and wires them to the existing `useDeleteSequence` hook and a new `onOpenEditor` prop; `SequenceTimeline.tsx` drops the `onOpenSequence` prop and its segment-name link; `VideoReviewPlayer.tsx` moves that callback from `SequenceTimeline` to the edit-mode `SequenceForm` instance).

**Tech Stack:** FastAPI + SQLAlchemy (backend), React + TypeScript + Vitest/Testing Library (frontend), TanStack Query for mutations.

## Global Constraints

- Language: English only in code, comments, docstrings, UI copy — no Russian anywhere in the repo (per `CLAUDE.md`).
- Dark theme only — don't introduce light-background Tailwind classes.
- TDD: every task below writes a failing test before the implementation.
- Object storage/taxonomy_version rules don't apply to this change (no binary media or `Label` references touched).
- `useDeleteSequence` and `apiClient` are the only sanctioned way to call the DELETE endpoint from the frontend — no hand-rolled `fetch()`.

---

### Task 1: Backend — allow deleting video-linked sequences

**Files:**
- Modify: `backend/app/media/router.py:534` (`delete_sequence`)
- Test: `backend/tests/test_media.py`

**Interfaces:**
- Consumes: existing `Sequence`, `Frame`, `Annotation` models (`backend/app/media/models.py`, `backend/app/annotation/models.py`) — unchanged.
- Produces: `DELETE /media/sequences/{sequence_id}` now returns `204` for any existing sequence without annotated frames, regardless of `video_id`; still `409` if the sequence has annotated frames; still `404` only when the sequence doesn't exist.

- [ ] **Step 1: Write the failing tests**

Replace the existing `test_delete_video_derived_sequence_via_media_endpoint_returns_404` test in `backend/tests/test_media.py` with two tests — one for the new success path, one confirming the annotation guard still applies to video-linked sequences. Find the existing test (it's the last test in the file, added by commit `92b99f3`) and replace it with:

```python
def test_delete_video_derived_sequence_succeeds():
    headers = _auth_headers()
    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos",
            files={"file": ("deletable_derived.mp4", f, "video/mp4")},
            data={"title": "Deletable derived"},
            headers=headers,
        ).json()["id"]
    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "Video-derived seq", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]

    response = client.delete(f"/media/sequences/{sequence_id}", headers=headers)

    assert response.status_code == 204
    assert client.get(f"/media/sequences/{sequence_id}", headers=headers).status_code == 404


def test_delete_video_derived_sequence_with_annotations_returns_409():
    headers = _auth_headers()

    # Mirrors backend/tests/test_annotation.py's _create_label get-or-create
    # pattern: Procedure/Category/EvaluationType creation 500s on a unique-
    # constraint collision instead of returning a JSON error, so look each
    # up first rather than assuming a fresh POST will succeed.
    procedures = client.get("/taxonomy/procedures", headers=headers).json()
    procedure = next((p for p in procedures if p["name"] == "delete-guard-procedure"), None)
    if procedure is None:
        procedure = client.post(
            "/taxonomy/procedures", json={"name": "delete-guard-procedure"}, headers=headers
        ).json()

    categories = client.get(
        f"/taxonomy/categories?procedure_id={procedure['id']}", headers=headers
    ).json()
    category = next((c for c in categories if c["name"] == "delete-guard-category"), None)
    if category is None:
        category = client.post(
            "/taxonomy/categories",
            json={"name": "delete-guard-category", "procedure_id": procedure["id"]},
            headers=headers,
        ).json()

    evaluation_types = client.get("/taxonomy/evaluation-types", headers=headers).json()
    evaluation_type = next(
        (e for e in evaluation_types if e["name"] == "delete-guard-evaluation-type"), None
    )
    if evaluation_type is None:
        evaluation_type = client.post(
            "/taxonomy/evaluation-types", json={"name": "delete-guard-evaluation-type"}, headers=headers
        ).json()

    label_id = client.post(
        "/taxonomy/labels",
        json={
            "name": "Delete-guard label",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=headers,
    ).json()["id"]

    with open(FIXTURE_VIDEO, "rb") as f:
        video_id = client.post(
            "/media/videos",
            files={"file": ("not_deletable_annotated.mp4", f, "video/mp4")},
            data={"title": "Not deletable annotated", "procedure_id": procedure["id"]},
            headers=headers,
        ).json()["id"]
    sequence_id = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "Annotated video-derived seq", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()["id"]
    frame_id = client.get(
        f"/media/sequences/{sequence_id}/frames", headers=headers
    ).json()[0]["id"]
    client.post(
        f"/annotation/frames/{frame_id}/annotations",
        json={"label_id": label_id},
        headers=headers,
    )

    response = client.delete(f"/media/sequences/{sequence_id}", headers=headers)

    assert response.status_code == 409
```

This test's setup (get-or-create procedure/category/evaluation-type, then
`POST /taxonomy/labels` with `category_id`/`evaluation_type_id`, then
`POST /annotation/frames/{frame_id}/annotations` with just `{"label_id": ...}`)
is copied from the real, already-passing pattern in
`backend/tests/test_annotation.py`'s `_create_label`/`_create_frame` helpers
and `test_create_classification_annotation` — verified against
`backend/app/taxonomy/schemas.py`'s `LabelCreate` (`name`, `color`,
`category_id`, `evaluation_type_id`) and
`backend/app/annotation/schemas.py`'s `AnnotationCreate` (`label_id` only;
the route auto-fills `annotation_type`/`taxonomy_version`/`status`). Use it
as-is; no further schema lookup should be needed.

- [ ] **Step 2: Run tests to verify they fail as expected**

Run: `cd backend && uv run pytest tests/test_media.py -k "delete_video_derived_sequence" -v`
Expected: `test_delete_video_derived_sequence_succeeds` FAILs with `assert 404 == 204` (current guard rejects video-linked sequences). `test_delete_video_derived_sequence_with_annotations_returns_409` FAILs the same way (also blocked by the 404 guard before it even reaches the annotation check).

- [ ] **Step 3: Widen the guard in `delete_sequence`**

In `backend/app/media/router.py`, find:

```python
@router.delete("/sequences/{sequence_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sequence(sequence_id: int, session: Session = Depends(get_session)) -> None:
    sequence = session.get(Sequence, sequence_id)
    if sequence is None or sequence.video_id is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sequence not found")
```

Change the guard condition to drop the `video_id` check:

```python
@router.delete("/sequences/{sequence_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sequence(sequence_id: int, session: Session = Depends(get_session)) -> None:
    sequence = session.get(Sequence, sequence_id)
    if sequence is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sequence not found")
```

The rest of the function (annotation guard, frame cleanup, delete, commit) is unchanged — it already operates generically on `sequence_id` and doesn't assume a standalone sequence.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest tests/test_media.py -k "delete_video_derived_sequence or delete_photo_sequence or delete_video" -v`
Expected: all PASS, including the pre-existing `test_delete_photo_sequence_without_annotations_succeeds` and `test_delete_video_with_linked_sequence_returns_409` (unaffected by this change).

- [ ] **Step 5: Run the full backend media test file to check for regressions**

Run: `cd backend && uv run pytest tests/test_media.py -v`
Expected: all PASS.

- [ ] **Step 6: Regenerate OpenAPI schema and commit**

The route's status codes/behavior text didn't change its signature, but regenerate defensively per `CLAUDE.md`'s standing instruction after any router change:

```bash
cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py
git diff --stat openapi.json
```

If `openapi.json` changed, include it in the commit. Then:

```bash
git add backend/app/media/router.py backend/tests/test_media.py openapi.json
git commit -m "$(cat <<'EOF'
fix: allow deleting video-linked sequences, not just standalone photos

DELETE /media/sequences/{id} previously 404'd for any sequence with a
video_id, a guard left over from when only standalone photo-sequence
deletion was implemented. SequenceForm's upcoming Delete button needs
this to work for sequences cut from a video too.
EOF
)"
```

(Omit `openapi.json` from `git add` if the diff was empty.)

---

### Task 2: Frontend — `SequenceForm` Delete button

**Files:**
- Modify: `frontend/src/features/media/SequenceForm.tsx`
- Test: `frontend/src/features/media/SequenceForm.test.tsx`

**Interfaces:**
- Consumes: `useDeleteSequence` from `frontend/src/entities/useMediaLibrary.ts` — `useMutation` whose `mutate` takes `(sequenceId: number, { onSuccess, onError })`, where `onError` receives the thrown `result.error` object (shape `{ detail?: string }`, mirroring how `updateSequence`'s error is already surfaced via `isError` in this same file).
- Produces: no new exported symbols; internal `confirmingDelete` state and a `handleDeleteConfirm` handler local to the edit-mode branch of `SequenceForm`.

- [ ] **Step 1: Write the failing tests**

Add these tests inside the existing `describe("SequenceForm edit mode (sequence prop present)", ...)` block in `frontend/src/features/media/SequenceForm.test.tsx`, after the last test (`"renders the stats panel for the sequence being edited"`). First add `DELETE: vi.fn()` to the `vi.mock("../../shared/api/client", ...)` block at the top of the file (currently only `GET, POST, PATCH` are mocked):

```typescript
vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));
```

Then add:

```typescript
  it("shows a Delete button that requires a second click to confirm", async () => {
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

    expect(screen.queryByRole("button", { name: /^confirm$/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(await screen.findByRole("button", { name: /^confirm$/i })).toBeInTheDocument();
    expect(apiClient.DELETE).not.toHaveBeenCalled();
  });

  it("deletes the sequence and calls onDone when delete is confirmed", async () => {
    vi.mocked(apiClient.DELETE).mockResolvedValue({ data: undefined, error: undefined } as never);

    const onDone = vi.fn();
    render(
      <SequenceForm
        sequence={sequence}
        videoId={5}
        markStart={0}
        markEnd={20}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={onDone}
      />,
      { wrapper }
    );

    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^confirm$/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(apiClient.DELETE).toHaveBeenCalledWith(
      "/media/sequences/{sequence_id}",
      expect.objectContaining({ params: { path: { sequence_id: 9 } } })
    );
  });

  it("cancels the delete confirmation without calling the API", async () => {
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

    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^cancel$/i }));

    expect(screen.queryByRole("button", { name: /^confirm$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeInTheDocument();
    expect(apiClient.DELETE).not.toHaveBeenCalled();
  });

  it("shows an error and stays open when delete fails", async () => {
    vi.mocked(apiClient.DELETE).mockResolvedValue({
      data: undefined,
      error: { detail: "This sequence has annotated frames — remove annotations before deleting it" },
    } as never);

    const onDone = vi.fn();
    render(
      <SequenceForm
        sequence={sequence}
        videoId={5}
        markStart={0}
        markEnd={20}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={onDone}
      />,
      { wrapper }
    );

    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^confirm$/i }));

    expect(await screen.findByText(/remove annotations before deleting/i)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });
```

Note: the existing re-cut confirmation flow already produces a button named "Confirm" (see the `handleConfirm`/`confirming` state in `SequenceForm.tsx:105-114,184-202`). The Delete confirmation must use different, unambiguous button text so these two confirmation flows can't collide when both could theoretically be triggered — use **"Delete confirm"** as the accessible name for the delete-confirm button instead of a bare "Confirm", and update the four tests above accordingly (replace `name: /^confirm$/i` with `name: /^delete confirm$/i` for the delete-flow tests only — leave the pre-existing re-cut tests using `/confirm/i` untouched, since regex `/confirm/i` still matches "Delete confirm" too; to keep the two flows unambiguous in tests, use the exact `/^delete confirm$/i` anchor shown here). Similarly use **"Cancel"** is already used by the re-cut flow's cancel button — reuse the same word is fine since the two confirmation UIs are never both mounted at once (see Step 3), but if you want an extra safety margin use `/^cancel delete$/i` for the delete-cancel button and adjust the test above (`name: /^cancel delete$/i`) to match. Pick one convention and apply it consistently between the tests and the implementation in Step 3.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/media/SequenceForm.test.tsx -t "Delete"`
Expected: FAIL — no "Delete" button exists yet (`getByRole("button", { name: /^delete$/i })` throws).

- [ ] **Step 3: Implement the Delete button in `SequenceForm.tsx`**

Add the import and state, then the button. In `frontend/src/features/media/SequenceForm.tsx`, update the import line:

```typescript
import { useCreateSequenceFromVideo, useUpdateSequence } from "../../entities/useSequences";
import { useDeleteSequence } from "../../entities/useMediaLibrary";
```

Add state and the mutation hook near the existing `confirming` state (around line 48):

```typescript
  const [confirming, setConfirming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const deleteSequence = useDeleteSequence();
```

Add a handler near `handleConfirm` (after line 114):

```typescript
  function handleDeleteConfirm() {
    setDeleteError(null);
    deleteSequence.mutate(sequence!.id, {
      onSuccess: () => onDone(),
      onError: (error: unknown) => {
        const detail = (error as { detail?: string } | undefined)?.detail ?? "Delete failed";
        setDeleteError(detail);
        setConfirmingDelete(false);
      },
    });
  }
```

In the edit-mode JSX (the `if (isEdit) { return ( ... ) }` block), the current structure is:

```tsx
          {isError && <p className="text-xs text-red-400">Save failed. Please try again.</p>}
          {!confirming ? (
            <div className="flex gap-2">
              <button type="submit" ...>Save</button>
              <button type="button" onClick={onDone} ...>Close</button>
            </div>
          ) : (
            <div className="flex gap-2">
              <button type="button" onClick={handleConfirm} ...>Confirm</button>
              <button type="button" onClick={() => setConfirming(false)} ...>Cancel</button>
            </div>
          )}
```

Replace it with a version that wraps the existing button row in a `justify-between` flex container, adding the delete controls on the right, and shows the delete error message alongside the existing save error message. Delete controls are only rendered when `!confirming` (the re-cut flow), since the two destructive/confirming flows should never be visible together:

```tsx
          {isError && <p className="text-xs text-red-400">Save failed. Please try again.</p>}
          {deleteError && <p className="text-xs text-red-400">{deleteError}</p>}
          <div className="flex items-center justify-between gap-2">
            {!confirming ? (
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={isPending || (needsRecut && fps === "")}
                  className="rounded bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={onDone}
                  className="rounded border border-gray-700 px-3 py-1.5 text-gray-100 hover:bg-gray-800"
                >
                  Close
                </button>
                {onOpenEditor && (
                  <button
                    type="button"
                    onClick={() => onOpenEditor(sequence!.id)}
                    className="rounded border border-gray-700 px-3 py-1.5 text-gray-100 hover:bg-gray-800"
                  >
                    Open in editor
                  </button>
                )}
              </div>
            ) : (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={isPending}
                  className="rounded bg-red-700 px-4 py-2 font-medium text-white hover:bg-red-600 disabled:opacity-50"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded border border-gray-700 px-3 py-1.5 text-gray-100 hover:bg-gray-800"
                >
                  Cancel
                </button>
              </div>
            )}
            {!confirming &&
              (!confirmingDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="rounded border border-gray-700 px-3 py-1.5 text-gray-100 hover:bg-gray-800"
                >
                  Delete
                </button>
              ) : (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleDeleteConfirm}
                    disabled={deleteSequence.isPending}
                    className="rounded bg-red-700 px-4 py-2 font-medium text-white hover:bg-red-600 disabled:opacity-50"
                  >
                    Delete confirm
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    className="rounded border border-gray-700 px-3 py-1.5 text-gray-100 hover:bg-gray-800"
                  >
                    Cancel
                  </button>
                </div>
              ))}
          </div>
```

This uses the "Delete confirm" naming convention from Step 1 — make sure the test file's button-name matchers (`/^delete confirm$/i`) match exactly what you wrote in Step 1. The `onOpenEditor` prop referenced here is added in Task 3 — for this task alone, if implementing Task 2 in isolation before Task 3, temporarily omit the `onOpenEditor` block (Task 3 adds both the prop and this JSX block together; if executed as a single combined change, include it now). Since Task 3 is a separate task in this plan, add the `onOpenEditor` prop and JSX in Task 3, not here — remove the `{onOpenEditor && (...)}` block from this task's edit and leave only the Delete/Delete-confirm addition. Task 3's step will add the "Open in editor" button back in.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/media/SequenceForm.test.tsx`
Expected: all PASS, including every pre-existing edit-mode test (the `justify-between` wrapper and reordered markup must not change any existing button's accessible name or the conditions under which `Confirm`/`Cancel` for re-cut appear).

- [ ] **Step 5: Commit**

```bash
cd frontend && git add src/features/media/SequenceForm.tsx src/features/media/SequenceForm.test.tsx
git commit -m "$(cat <<'EOF'
feat: add Delete button to SequenceForm edit mode

Inline two-step confirmation (Delete -> Delete confirm/Cancel),
matching the pattern already used in MediaLibraryTable. Relies on the
DELETE /media/sequences/{id} guard fix from the previous commit.
EOF
)"
```

---

### Task 3: Frontend — `SequenceForm` "Open in editor" button + `VideoReviewPlayer` wiring

**Files:**
- Modify: `frontend/src/features/media/SequenceForm.tsx`
- Modify: `frontend/src/features/media/VideoReviewPlayer.tsx`
- Test: `frontend/src/features/media/SequenceForm.test.tsx`
- Test: `frontend/src/features/media/VideoReviewPlayer.test.tsx`

**Interfaces:**
- Consumes: `SequenceForm`'s existing prop list (from Task 2's edit branch).
- Produces: `SequenceForm` gains an optional prop `onOpenEditor?: (sequenceId: number) => void`. `VideoReviewPlayer` passes its own existing `onOpenSequence: (sequenceId: number) => void` prop through to the edit-mode `SequenceForm` instance's `onOpenEditor`, instead of to `SequenceTimeline`.

- [ ] **Step 1: Write the failing test for `SequenceForm`'s new button**

Add to `frontend/src/features/media/SequenceForm.test.tsx`, in the edit-mode `describe` block:

```typescript
  it("calls onOpenEditor with the sequence id when Open in editor is clicked", async () => {
    const onOpenEditor = vi.fn();
    render(
      <SequenceForm
        sequence={sequence}
        videoId={5}
        markStart={0}
        markEnd={20}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={vi.fn()}
        onOpenEditor={onOpenEditor}
      />,
      { wrapper }
    );

    await userEvent.click(screen.getByRole("button", { name: /open in editor/i }));

    expect(onOpenEditor).toHaveBeenCalledWith(9);
  });

  it("does not render an Open in editor button when onOpenEditor is not provided", async () => {
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

    expect(screen.queryByRole("button", { name: /open in editor/i })).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/media/SequenceForm.test.tsx -t "Open in editor"`
Expected: FAIL — no "Open in editor" button exists, and `onOpenEditor` isn't an accepted prop yet (TypeScript error if strict, or the button simply isn't found at runtime).

- [ ] **Step 3: Add the `onOpenEditor` prop and button to `SequenceForm.tsx`**

Update the component's prop type (near the top, alongside `onDone`):

```typescript
export function SequenceForm({
  sequence,
  videoId,
  markStart,
  markEnd,
  procedureId: procedureIdProp,
  existingSequences,
  onCropChange,
  onDone,
  onOpenEditor,
}: {
  sequence?: SequenceRead;
  videoId: number;
  markStart: number;
  markEnd: number;
  procedureId?: number;
  existingSequences: SequenceRead[];
  onCropChange: (crop: Crop) => void;
  onDone: () => void;
  onOpenEditor?: (sequenceId: number) => void;
}) {
```

In the edit-mode button row built in Task 2, add the "Open in editor" button back into the `!confirming` left-hand group (the block Task 2's Step 3 said to omit):

```tsx
                {onOpenEditor && (
                  <button
                    type="button"
                    onClick={() => onOpenEditor(sequence!.id)}
                    className="rounded border border-gray-700 px-3 py-1.5 text-gray-100 hover:bg-gray-800"
                  >
                    Open in editor
                  </button>
                )}
```

placed immediately after the existing "Close" button, still inside the `!confirming` left-hand `<div className="flex gap-2">` group from Task 2.

- [ ] **Step 4: Run `SequenceForm` tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/media/SequenceForm.test.tsx`
Expected: all PASS.

- [ ] **Step 5: Write the failing test for `VideoReviewPlayer`'s wiring**

Read `frontend/src/features/media/VideoReviewPlayer.test.tsx` first to find an existing test that renders the edit-mode `SequenceForm` (search for `editingSequenceId` or a test that clicks a timeline segment to enter edit mode) and copy its render/setup pattern. Add a new test in that file:

```typescript
  it("passes onOpenSequence through to the edit-mode SequenceForm as onOpenEditor, not to the timeline", async () => {
    // Reuse this file's existing setup for entering edit mode (mock GET for
    // /media/videos/{id} and /media/videos/{id}/sequences so a sequence
    // exists, then click its timeline segment to set editingSequenceId).
    // Follow the exact mock shape used by this file's other "edit mode" tests.
    const onOpenSequence = vi.fn();
    // ... render VideoReviewPlayer with onOpenSequence, enter edit mode for
    // a known sequence id (match this file's existing pattern) ...

    await userEvent.click(await screen.findByRole("button", { name: /open in editor/i }));

    expect(onOpenSequence).toHaveBeenCalledWith(/* the sequence id used in setup */);
  });
```

Before finalizing this test, read `VideoReviewPlayer.test.tsx` in full to copy the exact mock setup an existing edit-mode test uses (video/sequences GET mocks, how it clicks into edit mode) — the placeholder comments above must be replaced with real code matching this file's established pattern, not left as prose.

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/features/media/VideoReviewPlayer.test.tsx -t "onOpenEditor"`
Expected: FAIL — `SequenceForm` in `VideoReviewPlayer.tsx` doesn't receive `onOpenEditor` yet, so no "Open in editor" button renders.

- [ ] **Step 7: Wire `onOpenSequence` into the edit-mode `SequenceForm` in `VideoReviewPlayer.tsx`**

Find the edit-mode `SequenceForm` render (around line 166-179):

```tsx
              {editingSequenceId !== null && markStart !== null && markEnd !== null && (() => {
                const target = sequencesQuery.data?.find((s) => s.id === editingSequenceId);
                return target ? (
                  <SequenceForm
                    sequence={target}
                    videoId={videoId}
                    markStart={markStart}
                    markEnd={markEnd}
                    existingSequences={sequencesQuery.data ?? []}
                    onCropChange={setActiveCrop}
                    onDone={handleEditDone}
                  />
                ) : null;
              })()}
```

Add `onOpenEditor={onOpenSequence}`:

```tsx
              {editingSequenceId !== null && markStart !== null && markEnd !== null && (() => {
                const target = sequencesQuery.data?.find((s) => s.id === editingSequenceId);
                return target ? (
                  <SequenceForm
                    sequence={target}
                    videoId={videoId}
                    markStart={markStart}
                    markEnd={markEnd}
                    existingSequences={sequencesQuery.data ?? []}
                    onCropChange={setActiveCrop}
                    onDone={handleEditDone}
                    onOpenEditor={onOpenSequence}
                  />
                ) : null;
              })()}
```

The create-mode `SequenceForm` instance (no `sequence` prop) is left untouched — it has no `onOpenEditor` prop passed, which is fine since the button only renders when `onOpenEditor` is provided (Task 3, Step 3) and create mode doesn't reach the edit-mode JSX branch at all.

- [ ] **Step 8: Run `VideoReviewPlayer` tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/media/VideoReviewPlayer.test.tsx`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
cd frontend && git add src/features/media/SequenceForm.tsx src/features/media/SequenceForm.test.tsx src/features/media/VideoReviewPlayer.tsx src/features/media/VideoReviewPlayer.test.tsx
git commit -m "$(cat <<'EOF'
feat: add Open in editor button to SequenceForm edit mode

Wires VideoReviewPlayer's existing onOpenSequence callback into the
edit-mode SequenceForm instance instead of the timeline, ahead of
removing the timeline's own link to it in the next commit.
EOF
)"
```

---

### Task 4: Frontend — remove the timeline's `onOpenSequence` link

**Files:**
- Modify: `frontend/src/features/media/SequenceTimeline.tsx`
- Test: `frontend/src/features/media/SequenceTimeline.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SequenceTimeline` no longer accepts an `onOpenSequence` prop. Its only per-segment interaction is `onSegmentClick` (unchanged signature: `(sequenceId: number, startTime: number, endTime: number) => void`).

- [ ] **Step 1: Update `SequenceTimeline.test.tsx` — remove `onOpenSequence`-specific tests, keep coverage of segment clicks**

In `frontend/src/features/media/SequenceTimeline.test.tsx`:

1. Remove the `onOpenSequence` prop from every `<SequenceTimeline ... />` render call in the file (there are 13 occurrences per the earlier grep) — delete the `onOpenSequence={...}` line from each.
2. Delete these three tests entirely, since they test behavior that's being removed:
   - `"calls onOpenSequence with the right id when a segment's open action is used"`
   - `"clicking a segment's action button does not start a drag"`
   - `"clicking a segment's name calls onOpenSequence, not onSegmentClick"`
3. Replace the test `"clicking a segment's body (not its name) calls onSegmentClick with the segment's bounds"` (currently uses `fireEvent.mouseDown(screen.getByTitle("Esophagus"))`) — keep it as-is, since it already tests the surviving behavior via the segment's `title` attribute, not the removed name-button. No change needed to this test's body, only removing its `onOpenSequence` prop per point 1.
4. In the first test, `"renders one segment per existing sequence with its name"`, change the assertions from `getByText` (works whether the name is a button or plain text) — no change needed there either, only prop removal.

- [ ] **Step 2: Run tests to verify the remaining ones fail on the still-present `onOpenSequence` requirement**

Run: `cd frontend && npx vitest run src/features/media/SequenceTimeline.test.tsx`
Expected: still PASS at this point, since `SequenceTimeline.tsx` itself hasn't changed yet and the component still accepts (and ignores if TypeScript allows extra props at runtime — it won't, this is TypeScript, so) — actually expect a **TypeScript compile error** in the test file wherever `onOpenSequence` was removed from a call site but the component's prop type still marks it as required. Confirm this by running the type check:

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json 2>&1 | grep SequenceTimeline`
Expected: errors like `Property 'onOpenSequence' is missing in type '...'`.

- [ ] **Step 3: Remove `onOpenSequence` from `SequenceTimeline.tsx`**

In `frontend/src/features/media/SequenceTimeline.tsx`:

Update the prop destructuring and type (lines 31-53):

```typescript
export function SequenceTimeline({
  durationSeconds,
  sequences,
  markStart,
  markEnd,
  onSegmentClick,
  onEmptyBackgroundClick,
  onMarkStartChange,
  onMarkEndChange,
  onScrub,
}: {
  durationSeconds: number;
  sequences: SequenceRead[];
  markStart: number | null;
  markEnd: number | null;
  onSegmentClick: (sequenceId: number, startTime: number, endTime: number) => void;
  onEmptyBackgroundClick: () => void;
  onMarkStartChange: (seconds: number) => void;
  onMarkEndChange: (seconds: number) => void;
  onScrub: (seconds: number) => void;
}) {
```

Update the segment rendering (lines 131-153) to drop the inner `<button>` and its wrapping logic, keeping only the plain name text inside the segment `<div>`:

```tsx
      {sequences.map((sequence) => (
        <div
          key={sequence.id}
          title={sequence.name}
          onMouseDown={(event) => {
            event.stopPropagation();
            onSegmentClick(sequence.id, sequence.start_time, sequence.start_time + sequence.duration);
          }}
          className={`absolute top-0 flex h-full items-center justify-center overflow-hidden whitespace-nowrap px-1 text-xs text-white ${SEGMENT_COLORS[sequence.id % SEGMENT_COLORS.length]}`}
          style={{ left: `${pct(sequence.start_time)}%`, width: `${pct(sequence.duration)}%` }}
        >
          <span className="truncate">{sequence.name}</span>
        </div>
      ))}
```

- [ ] **Step 4: Run tests and type check to verify everything passes**

Run: `cd frontend && npx vitest run src/features/media/SequenceTimeline.test.tsx`
Expected: all PASS.

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json`
Expected: no errors related to `SequenceTimeline` or `onOpenSequence`.

- [ ] **Step 5: Update `VideoReviewPlayer.tsx` — stop passing `onOpenSequence` to `SequenceTimeline`**

In `frontend/src/features/media/VideoReviewPlayer.tsx`, find the `<SequenceTimeline ... />` render (around line 196-209):

```tsx
          <SequenceTimeline
            durationSeconds={video.duration_seconds}
            sequences={sequencesQuery.data ?? []}
            markStart={markStart}
            markEnd={markEnd}
            onOpenSequence={onOpenSequence}
            onSegmentClick={handleSegmentClick}
            onEmptyBackgroundClick={handleEmptyBackgroundClick}
            onMarkStartChange={setMarkStart}
            onMarkEndChange={setMarkEnd}
            onScrub={(seconds) => {
              if (videoRef.current) videoRef.current.currentTime = seconds;
            }}
          />
```

Remove the `onOpenSequence={onOpenSequence}` line (it's already passed to `SequenceForm` via `onOpenEditor` from Task 3 — the `onOpenSequence` prop on `VideoReviewPlayer` itself is unchanged, only this one pass-through to `SequenceTimeline` is deleted):

```tsx
          <SequenceTimeline
            durationSeconds={video.duration_seconds}
            sequences={sequencesQuery.data ?? []}
            markStart={markStart}
            markEnd={markEnd}
            onSegmentClick={handleSegmentClick}
            onEmptyBackgroundClick={handleEmptyBackgroundClick}
            onMarkStartChange={setMarkStart}
            onMarkEndChange={setMarkEnd}
            onScrub={(seconds) => {
              if (videoRef.current) videoRef.current.currentTime = seconds;
            }}
          />
```

- [ ] **Step 6: Run the full frontend test suite and type check**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `cd frontend && npx vitest run`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
cd frontend && git add src/features/media/SequenceTimeline.tsx src/features/media/SequenceTimeline.test.tsx src/features/media/VideoReviewPlayer.tsx
git commit -m "$(cat <<'EOF'
refactor: remove timeline's open-in-editor link

Short segments made this link nearly unclickable. The same action is
now reachable via the Open in editor button in SequenceForm's edit
mode (added in the previous two commits), so the segment name is
plain text again and the whole segment only opens SequenceForm.
EOF
)"
```

---

### Task 5: End-to-end manual verification in the real browser

Per `CLAUDE.md`'s testing philosophy section: unit tests mock `apiClient` and backend tests use `TestClient`, neither of which can catch a real integration gap. Verify this feature by hand against the running stack before considering it done.

**Files:** none (manual verification only).

- [ ] **Step 1: Start the stack**

```bash
docker compose up -d
cd backend && uv run uvicorn app.main:app --reload &
cd frontend && npm run dev &
```

Wait for both to report ready (backend on `:8000`, frontend on `:5173`).

- [ ] **Step 2: Log in and open a video with at least one existing sequence**

Use the `manualcheck@example.com` login referenced in project memory (`reference_manual_check_login_and_taxonomy_reimport.md`) if available, or the normal login flow. Navigate to Media, upload or select a video that has at least one existing sequence, ideally one spanning only a few frames (to confirm the old hard-to-click link is gone).

- [ ] **Step 3: Click a short segment on the timeline**

Confirm it opens `SequenceForm` in edit mode (not the frame editor), and that there is no clickable link on the segment name itself in the timeline — only `SequenceForm`'s buttons should be interactive for this sequence now.

- [ ] **Step 4: Click "Open in editor"**

Confirm it navigates to the frame editor (`/sequences/{id}`) for that exact sequence.

- [ ] **Step 5: Go back, re-open the same sequence's edit form, click Delete**

Confirm the button turns into "Delete confirm" / "Cancel". Click "Cancel" and confirm the sequence still exists (still shown on the timeline).

- [ ] **Step 6: Click Delete again, then "Delete confirm"**

Confirm the form closes and the sequence is gone from the timeline without a page reload (React Query cache invalidation via `handleEditDone`'s `sequencesQuery.refetch()`).

- [ ] **Step 7: Repeat delete against a sequence that has annotated frames**

Confirm the API returns 409 and the form shows the "remove annotations before deleting" error message instead of silently succeeding or crashing.

- [ ] **Step 8: Report results**

State plainly whether each of steps 3-7 worked as expected. If anything didn't, note it — don't mark the plan complete until it does.

---

## Self-Review Notes

- **Spec coverage:** all four spec decisions (Edit = open frame editor via new button; timeline link removed, not duplicated; inline two-step delete confirmation matching `MediaLibraryTable`; backend gap closed) map to Tasks 1-4. The spec's "Out of scope" items (no `delete_video` change, no `MediaLibraryTable` change, no modals) are respected — no task touches those files.
- **Placeholder scan:** Task 1 Step 1's annotation-guard test was verified against the real `LabelCreate`/`AnnotationCreate` schemas and the working setup pattern in `backend/tests/test_annotation.py`, and no longer contains a guessed payload shape. Task 3 Step 5 still contains an explicit instruction to read `VideoReviewPlayer.test.tsx` and copy its existing edit-mode mock setup before finalizing that one test, since reproducing that file's full mock boilerplate here would be redundant — the implementer is told exactly where to look and what to verify, not left to invent the shape from scratch.
- **Type/name consistency:** `onOpenEditor` is used consistently across Task 3 (definition in `SequenceForm.tsx`) and Task 3/4 (`VideoReviewPlayer.tsx` passing its own `onOpenSequence` prop into `SequenceForm`'s `onOpenEditor`). `useDeleteSequence`'s `mutate(sequenceId: number, ...)` signature in Task 2 matches its real definition in `frontend/src/entities/useMediaLibrary.ts:31-45`. The "Delete confirm" button name is used consistently in Task 2's test and implementation steps.
