# Timeline Panel Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `RecutSequenceForm`, `SequenceFromMarksForm`, and `RenameSequenceForm` with one `SequenceForm` component (create/edit modes), and replace the timeline's three per-segment icon buttons with click targets: segment name → open, segment body → edit, empty background click (not drag) → auto-stretched create.

**Architecture:** `SequenceForm.tsx` is a single component whose behavior branches on whether a `sequence` prop is present. `SequenceTimeline.tsx` gains click-vs-drag discrimination on top of its existing drag machinery (unchanged) plus a new "segment-click" drag-state variant and gap-computation logic for empty-background clicks. `VideoReviewPlayer.tsx` collapses its three-way state branch (`renamingSequenceId`/`recuttingSequenceId`/create-from-marks) into one `editingSequenceId: number | null` plus the existing `markStart`/`markEnd`.

**Tech Stack:** React 18, TypeScript, Vitest + @testing-library/react (`fireEvent`/`userEvent`), existing Tailwind dark-theme classes, TanStack Query (`useUpdateSequence`, `useCreateSequenceFromVideo`, `useSuggestSequenceName`, `useProcedures`).

## Global Constraints

- **Language:** English only in code, comments, and UI copy (CLAUDE.md).
- **TDD:** every frontend task with logic gets a failing test before the implementation (CLAUDE.md).
- Click-vs-drag threshold: **3 screen pixels** — if `mouseup`'s `clientX` is within 3px of the `mousedown`'s `clientX`, treat it as a click, not a drag (spec).
- Segments never touch with zero gap between them — the empty-background gap computation does not need to handle or defend against that case (spec, "Out of scope").
- Both `SequenceForm` modes share `CropFields` and the same overall layout/field set (spec).
- `SequenceForm` edit mode only shows the destructive confirm step when the range (`markStart`/`markEnd` vs. the sequence's current `start_time`/`start_time + duration`) or crop actually changed from the sequence's current values; a name/procedure-only change saves directly via `useUpdateSequence` with no confirm (spec).
- The existing "Mark start"/"Mark end" buttons and their mm:ss displays in `VideoReviewPlayer.tsx` are unchanged and remain a valid way to set marks for create mode (spec).
- All existing drag-to-adjust behavior (edge dragging, snapping, minimum 1-second width, video scrub sync) from `docs/superpowers/specs/2026-08-01-timeline-drag-marks-design.md` must keep working unchanged — this plan only adds click entry points on top of it, never replaces it.
- `SequenceTimeline`'s `onOpenSequence`, `onMarkStartChange`, `onMarkEndChange`, `onScrub` props keep their existing signatures; `onRenameSequence`/`onRecutSequence` are removed and replaced by `onSegmentClick`/`onEmptyBackgroundClick`.

---

### Task 1: `SequenceForm` — create mode

**Files:**
- Create: `frontend/src/features/media/SequenceForm.tsx`
- Test: `frontend/src/features/media/SequenceForm.test.tsx`

**Interfaces:**
- Consumes: `CropFields`/`ZERO_CROP`/`Crop` from `frontend/src/features/media/CropFields.tsx` (existing, unchanged); `useCreateSequenceFromVideo`, `useUpdateSequence` from `frontend/src/entities/useSequences.ts` (existing, unchanged); `useProcedures` from `frontend/src/entities/useProcedures.ts` (existing); `useSuggestSequenceName` from `frontend/src/entities/useSuggestSequenceName.ts` (existing).
- Produces: `SequenceForm` component with this prop shape (create mode uses the fields with no `sequence`; Task 2 adds the `sequence`-present edit-mode branch to the same component and file):
  ```typescript
  type SequenceRead = components["schemas"]["SequenceRead"];

  export function SequenceForm({
    sequence,
    videoId,
    markStart,
    markEnd,
    procedureId,
    existingSequences,
    onCropChange,
    onDone,
  }: {
    sequence?: SequenceRead;
    videoId: number;
    markStart: number;
    markEnd: number;
    procedureId?: number;
    existingSequences: SequenceRead[];
    onCropChange: (crop: Crop) => void;
    onDone: () => void;
  })
  ```
  This exact prop shape (all fields present regardless of mode; `sequence` is what selects the mode) is what Task 3's `VideoReviewPlayer.tsx` wiring depends on.

This task implements ONLY the `sequence === undefined` (create) branch. Write the component now handling both branches structurally (an `if (sequence)` split), but Task 1's tests only cover create mode; Task 2 adds the edit-mode tests and fully implements that branch's confirm-step logic.

- [ ] **Step 1: Write the failing tests for create mode**

Create `frontend/src/features/media/SequenceForm.test.tsx`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { SequenceForm } from "./SequenceForm";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("SequenceForm create mode (no sequence prop)", () => {
  afterEach(() => vi.clearAllMocks());

  it("submits with start_time and duration derived from the marks, not typed fields", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path) => {
      if (path === "/taxonomy/procedures") {
        return { data: [{ id: 1, name: "EGD" }], error: undefined } as never;
      }
      if (path === "/media/sequences/suggest-name") {
        return { data: { name: "EGD 2026-07-29 #1" }, error: undefined } as never;
      }
      return { data: undefined, error: undefined } as never;
    });
    vi.mocked(apiClient.POST).mockResolvedValue({
      data: { id: 42, name: "EGD 2026-07-29 #1", video_id: 5, procedure_id: 1, start_time: 10, duration: 20 },
      error: undefined,
    } as never);

    const onCreated = vi.fn();
    render(
      <SequenceForm
        videoId={5}
        markStart={10}
        markEnd={30}
        procedureId={1}
        onCropChange={vi.fn()}
        existingSequences={[]}
        onDone={onCreated}
      />,
      { wrapper }
    );

    await userEvent.click(await screen.findByRole("button", { name: /create sequence/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(apiClient.POST).toHaveBeenCalledWith(
      "/media/videos/{video_id}/sequences",
      expect.objectContaining({
        body: expect.objectContaining({ start_time: 10, duration: 20 }),
      })
    );
  });

  it("inherits crop from the most-recently-created existing sequence", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [], error: undefined } as never);

    render(
      <SequenceForm
        videoId={5}
        markStart={10}
        markEnd={30}
        procedureId={1}
        onCropChange={vi.fn()}
        existingSequences={[
          { id: 1, name: "First", video_id: 5, procedure_id: 1, start_time: 0, duration: 10, annotation_count: 0, crop_box: { left: 5, right: 5, top: 0, bottom: 0 } },
          { id: 2, name: "Second", video_id: 5, procedure_id: 1, start_time: 10, duration: 10, annotation_count: 0, crop_box: { left: 20, right: 15, top: 10, bottom: 8 } },
        ]}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    expect(await screen.findByLabelText(/left %/i)).toHaveValue(20);
    expect(screen.getByLabelText(/right %/i)).toHaveValue(15);
    expect(screen.getByLabelText(/top %/i)).toHaveValue(10);
    expect(screen.getByLabelText(/bottom %/i)).toHaveValue(8);
  });

  it("defaults crop to zero when the video has no existing sequences", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [], error: undefined } as never);

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

    expect(await screen.findByLabelText(/left %/i)).toHaveValue(0);
  });

  it("shows an error message when creating the sequence fails", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path) => {
      if (path === "/taxonomy/procedures") {
        return { data: [{ id: 1, name: "EGD" }], error: undefined } as never;
      }
      if (path === "/media/sequences/suggest-name") {
        return { data: { name: "EGD 2026-07-29 #1" }, error: undefined } as never;
      }
      return { data: undefined, error: undefined } as never;
    });
    vi.mocked(apiClient.POST).mockResolvedValue({
      data: undefined,
      error: { detail: "start_time + duration exceeds the video's duration" },
    } as never);

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

    await userEvent.click(await screen.findByRole("button", { name: /create sequence/i }));

    expect(await screen.findByText(/failed to create sequence/i)).toBeInTheDocument();
  });

  it("disables the submit button while the create request is pending, so a slow request can't be double-submitted", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path) => {
      if (path === "/taxonomy/procedures") {
        return { data: [{ id: 1, name: "EGD" }], error: undefined } as never;
      }
      if (path === "/media/sequences/suggest-name") {
        return { data: { name: "EGD 2026-07-29 #1" }, error: undefined } as never;
      }
      return { data: undefined, error: undefined } as never;
    });
    let resolvePost!: (value: unknown) => void;
    vi.mocked(apiClient.POST).mockReturnValue(
      new Promise((resolve) => {
        resolvePost = resolve;
      }) as never
    );

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

    const button = await screen.findByRole("button", { name: /create sequence/i });
    await userEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(apiClient.POST).toHaveBeenCalledTimes(1);

    await userEvent.click(button);
    expect(apiClient.POST).toHaveBeenCalledTimes(1);

    resolvePost({
      data: { id: 42, name: "EGD 2026-07-29 #1", video_id: 5, procedure_id: 1, start_time: 10, duration: 20 },
      error: undefined,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/media/SequenceForm.test.tsx`
Expected: FAIL with "Cannot find module './SequenceForm'" (file doesn't exist yet).

- [ ] **Step 3: Write the implementation (create-mode branch; edit-mode branch stubbed)**

Create `frontend/src/features/media/SequenceForm.tsx`:

```typescript
import { useEffect, useState } from "react";

import { useProcedures } from "../../entities/useProcedures";
import { useCreateSequenceFromVideo, useUpdateSequence } from "../../entities/useSequences";
import { useSuggestSequenceName } from "../../entities/useSuggestSequenceName";
import type { components } from "../../shared/api/generated/schema";
import { CropFields, ZERO_CROP, type Crop } from "./CropFields";

type SequenceRead = components["schemas"]["SequenceRead"];

function mostRecentCrop(sequences: SequenceRead[]): Crop {
  const mostRecent = [...sequences].sort((a, b) => b.id - a.id)[0];
  return (mostRecent?.crop_box as Crop | null | undefined) ?? ZERO_CROP;
}

export function SequenceForm({
  sequence,
  videoId,
  markStart,
  markEnd,
  procedureId: procedureIdProp,
  existingSequences,
  onCropChange,
  onDone,
}: {
  sequence?: SequenceRead;
  videoId: number;
  markStart: number;
  markEnd: number;
  procedureId?: number;
  existingSequences: SequenceRead[];
  onCropChange: (crop: Crop) => void;
  onDone: () => void;
}) {
  const proceduresQuery = useProcedures();
  const isEdit = sequence !== undefined;

  const [procedureId, setProcedureId] = useState<number | undefined>(
    isEdit ? (sequence!.procedure_id ?? undefined) : procedureIdProp
  );
  const suggestedNameQuery = useSuggestSequenceName(isEdit ? undefined : procedureId);
  const [name, setName] = useState(isEdit ? sequence!.name : "");
  const [fps, setFps] = useState<number | "">(isEdit ? "" : 1);
  const [crop, setCrop] = useState<Crop>(() =>
    isEdit ? ((sequence!.crop_box as Crop | null) ?? ZERO_CROP) : mostRecentCrop(existingSequences)
  );
  const [confirming, setConfirming] = useState(false);

  const createSequence = useCreateSequenceFromVideo();
  const updateSequence = useUpdateSequence();
  const isPending = isEdit ? updateSequence.isPending : createSequence.isPending;
  const isError = isEdit ? updateSequence.isError : createSequence.isError;

  useEffect(() => {
    onCropChange(crop);
  }, [crop, onCropChange]);

  useEffect(() => {
    if (
      !isEdit &&
      procedureIdProp === undefined &&
      procedureId === undefined &&
      proceduresQuery.data &&
      proceduresQuery.data.length > 0
    ) {
      setProcedureId(proceduresQuery.data[0].id);
    }
  }, [isEdit, procedureIdProp, procedureId, proceduresQuery.data]);

  useEffect(() => {
    if (!isEdit && suggestedNameQuery.data?.name) {
      setName(suggestedNameQuery.data.name);
    }
  }, [isEdit, suggestedNameQuery.data?.name]);

  const startTime = Math.round(Math.min(markStart, markEnd));
  const duration = Math.round(Math.abs(markEnd - markStart));

  function handleCreateSubmit(event: React.FormEvent) {
    event.preventDefault();
    createSequence.mutate(
      { videoId, name, procedureId, startTime, duration, fps: fps === "" ? 1 : fps, crop },
      { onSuccess: () => onDone() }
    );
  }

  // Edit-mode submit/confirm logic is implemented in Task 2.
  function handleEditSubmit(event: React.FormEvent) {
    event.preventDefault();
  }

  function handleConfirm() {
    // Implemented in Task 2.
  }

  if (isEdit) {
    return (
      <form onSubmit={handleEditSubmit} className="flex flex-col gap-3 rounded border border-gray-800 bg-gray-900 p-4">
        <CropFields crop={crop} onChange={setCrop} />
        <p className="text-sm text-gray-400">
          Range: {startTime}s – {startTime + duration}s ({duration}s)
        </p>
        <label className="flex flex-col gap-1 text-sm text-gray-300">
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100"
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-gray-300">
          Procedure
          <select
            value={procedureId ?? ""}
            onChange={(e) => setProcedureId(e.target.value ? Number(e.target.value) : undefined)}
            className="rounded border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100"
          >
            <option value="">None</option>
            {(proceduresQuery.data ?? []).map((procedure) => (
              <option key={procedure.id} value={procedure.id}>
                {procedure.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex w-24 flex-col gap-1 text-sm text-gray-300">
          FPS
          <input
            type="number"
            value={fps}
            onChange={(e) => setFps(e.target.value === "" ? "" : Number(e.target.value))}
            className="rounded border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100"
          />
        </label>
        {confirming && sequence!.annotation_count > 0 && (
          <p className="text-sm text-red-400">
            This will delete {sequence!.annotation_count} annotation{sequence!.annotation_count === 1 ? "" : "s"} on
            this sequence&apos;s current frames.
          </p>
        )}
        {isError && <p className="text-sm text-red-400">Save failed. Please try again.</p>}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={isPending}
            className="rounded bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={onDone}
            className="rounded border border-gray-700 px-3 py-2 text-sm hover:bg-gray-800"
          >
            Close
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={handleCreateSubmit} className="flex flex-col gap-3 rounded border border-gray-800 bg-gray-900 p-4">
      <CropFields crop={crop} onChange={setCrop} />
      <p className="text-sm text-gray-400">
        Range: {startTime}s – {startTime + duration}s ({duration}s)
      </p>
      <label className="flex flex-col gap-1 text-sm text-gray-300">
        Procedure
        <select
          value={procedureId ?? ""}
          onChange={(e) => setProcedureId(e.target.value ? Number(e.target.value) : undefined)}
          className="rounded border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100"
          required
        >
          <option value="" disabled>
            Select a procedure
          </option>
          {(proceduresQuery.data ?? []).map((procedure) => (
            <option key={procedure.id} value={procedure.id}>
              {procedure.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm text-gray-300">
        Name
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100"
          required
        />
      </label>
      <label className="flex w-24 flex-col gap-1 text-sm text-gray-300">
        FPS
        <input
          type="number"
          value={fps === "" ? 1 : fps}
          onChange={(e) => setFps(Number(e.target.value))}
          className="rounded border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100"
        />
      </label>
      {isError && <p className="text-sm text-red-400">Failed to create sequence. Please try again.</p>}
      <button
        type="submit"
        disabled={isPending}
        className="rounded bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-500 disabled:opacity-50"
      >
        {isPending ? "Creating…" : "Create sequence"}
      </button>
    </form>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/media/SequenceForm.test.tsx`
Expected: PASS, all 5 create-mode tests green.

- [ ] **Step 5: Commit**

```bash
cd frontend
git add src/features/media/SequenceForm.tsx src/features/media/SequenceForm.test.tsx
git commit -m "feat: add SequenceForm create mode, replacing SequenceFromMarksForm"
```

---

### Task 2: `SequenceForm` — edit mode with conditional confirm

**Files:**
- Modify: `frontend/src/features/media/SequenceForm.tsx`
- Test: `frontend/src/features/media/SequenceForm.test.tsx`

**Interfaces:**
- Consumes: `SequenceForm`'s existing structure from Task 1 (the `isEdit` branch's JSX and stub handlers, edited in place).
- Produces: complete `SequenceForm` component (both modes fully functional) — Task 3's `VideoReviewPlayer.tsx` wiring depends on the full behavior described below.

**Design notes for the implementer:**

- The edit-mode submit button is always labeled "Save" (per the design spec, there's no separate "Re-cut" label anymore — both name-only and range/crop changes go through the same button).
- On submit, determine whether the range or crop changed from the sequence's original values:
  ```typescript
  const rangeChanged = startTime !== sequence!.start_time || duration !== sequence!.duration;
  const cropChanged = JSON.stringify(crop) !== JSON.stringify((sequence!.crop_box as Crop | null) ?? ZERO_CROP);
  ```
  (`startTime`/`duration` are already computed above from `markStart`/`markEnd`, matching the existing `RecutSequenceForm` pattern.)
- If neither `rangeChanged` nor `cropChanged`: call `updateSequence.mutate` directly with only `{ sequenceId: sequence!.id, name, procedureId }` (no `startTime`/`duration`/`fps`/`crop` — the mutation hook already supports partial updates per its existing signature), `onSuccess: () => onDone()`. No confirm step.
- If either changed: `handleEditSubmit` sets `confirming = true` instead of submitting (mirroring today's `RecutSequenceForm.handleRecutClick`). Two buttons then render instead of "Save"/"Close": "Confirm" (calls `handleConfirm`, disabled while `updateSequence.isPending`) and "Cancel" (sets `confirming = false`, does NOT call `onDone` — this returns to the editable state, distinct from the top-level "Close" button which fully exits). `handleConfirm` calls `updateSequence.mutate` with the full payload `{ sequenceId: sequence!.id, name, procedureId, startTime, duration, fps: fps === "" ? undefined : fps, crop }`, `onSuccess: () => onDone()`, `onError: () => setConfirming(false)`.
- fps is required (non-empty) only when `rangeChanged || cropChanged` is true, since only that path re-extracts frames — the "Save" button (before confirming) should be `disabled={isEdit && (rangeChanged || cropChanged) && fps === ""}` in addition to `disabled={isPending}`. When only name/procedure changed, fps being empty doesn't matter (it's never sent).
- Replace the two stub functions (`handleEditSubmit`, `handleConfirm`) from Task 1 with this real logic, and add `confirming` state (already declared in Task 1's stub — reuse it).
- Update the edit-mode JSX's button block: replace the always-rendered "Save"/"Close" pair with the same `!confirming ? (Save + Close) : (Confirm + Cancel)` conditional structure `RecutSequenceForm.tsx` used (read that file's git history via `git show HEAD:frontend/src/features/media/RecutSequenceForm.tsx` if it's already been deleted by the time you start this task, or read it directly if Task 4 hasn't run yet — this plan's tasks execute in order, so it will still exist).
- The annotation-count warning (`{sequence!.annotation_count > 0 && ...}`) should only show once `confirming` is true (matches today's behavior — Task 1's stub already gates it this way).

- [ ] **Step 1: Write the failing tests for edit mode**

Add to `frontend/src/features/media/SequenceForm.test.tsx`, in a new `describe` block after the existing `describe("SequenceForm create mode ...")`:

```typescript
describe("SequenceForm edit mode (sequence prop present)", () => {
  afterEach(() => vi.clearAllMocks());

  const sequence = {
    id: 9, name: "To be edited", video_id: 5, procedure_id: 1,
    start_time: 0, duration: 20, annotation_count: 3, crop_box: null,
  };

  it("shows the exact annotation count that will be deleted, only once confirming", async () => {
    render(
      <SequenceForm
        sequence={sequence}
        videoId={5}
        markStart={0}
        markEnd={15}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    expect(screen.queryByText(/3 annotation/i)).not.toBeInTheDocument();

    const fpsInput = screen.getByLabelText(/fps/i);
    await userEvent.type(fpsInput, "2");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByText(/3 annotation/i)).toBeInTheDocument();
  });

  it("saves name/procedure changes directly, with no confirmation step, when range and crop are unchanged", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { ...sequence, name: "Renamed" },
      error: undefined,
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

    const nameInput = screen.getByLabelText(/^name$/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Renamed");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(apiClient.PATCH).toHaveBeenCalledWith(
      "/media/sequences/{sequence_id}",
      expect.objectContaining({
        params: { path: { sequence_id: 9 } },
        body: expect.objectContaining({ name: "Renamed" }),
      })
    );
    // No confirm dialog ever appeared.
    expect(screen.queryByRole("button", { name: /confirm/i })).not.toBeInTheDocument();
  });

  it("requires confirmation and submits full re-cut payload when the range changed", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { ...sequence, start_time: 0, duration: 15 },
      error: undefined,
    } as never);

    const onDone = vi.fn();
    render(
      <SequenceForm
        sequence={sequence}
        videoId={5}
        markStart={0}
        markEnd={15}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={onDone}
      />,
      { wrapper }
    );

    const fpsInput = screen.getByLabelText(/fps/i);
    await userEvent.type(fpsInput, "2");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(apiClient.PATCH).toHaveBeenCalledWith(
      "/media/sequences/{sequence_id}",
      expect.objectContaining({
        params: { path: { sequence_id: 9 } },
        body: expect.objectContaining({ start_time: 0, duration: 15, fps: 2 }),
      })
    );
  });

  it("does not submit if the range-change confirmation is cancelled, and returns to the editable state", async () => {
    render(
      <SequenceForm
        sequence={sequence}
        videoId={5}
        markStart={0}
        markEnd={15}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    const fpsInput = screen.getByLabelText(/fps/i);
    await userEvent.type(fpsInput, "2");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /cancel/i }));

    expect(apiClient.PATCH).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /^save$/i })).toBeInTheDocument();
  });

  it("shows an error and returns to the editable state when the confirmed save fails", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: undefined,
      error: { detail: "start_time + duration exceeds the video's duration" },
    } as never);

    const onDone = vi.fn();
    render(
      <SequenceForm
        sequence={sequence}
        videoId={5}
        markStart={0}
        markEnd={15}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={onDone}
      />,
      { wrapper }
    );

    const fpsInput = screen.getByLabelText(/fps/i);
    await userEvent.type(fpsInput, "2");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /confirm/i }));

    expect(await screen.findByText(/save failed/i)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /^save$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm/i })).not.toBeInTheDocument();
  });

  it("lets the user leave edit mode without saving via a top-level Close button", async () => {
    const onDone = vi.fn();
    render(
      <SequenceForm
        sequence={sequence}
        videoId={5}
        markStart={0}
        markEnd={15}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={onDone}
      />,
      { wrapper }
    );

    await userEvent.click(screen.getByRole("button", { name: /^close$/i }));

    expect(onDone).toHaveBeenCalled();
    expect(apiClient.PATCH).not.toHaveBeenCalled();
  });

  it("disables the Save button when fps is empty and the range or crop changed", async () => {
    render(
      <SequenceForm
        sequence={sequence}
        videoId={5}
        markStart={0}
        markEnd={15}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    const saveButton = screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
  });

  it("does not require fps when only name/procedure changed (range and crop untouched)", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { ...sequence, name: "Renamed" },
      error: undefined,
    } as never);

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

    const saveButton = screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
  });

  it("pre-fills crop fields from the sequence's existing crop_box", () => {
    render(
      <SequenceForm
        sequence={{ ...sequence, crop_box: { left: 12, right: 8, top: 4, bottom: 6 } }}
        videoId={5}
        markStart={0}
        markEnd={20}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    expect(screen.getByLabelText(/left %/i)).toHaveValue(12);
    expect(screen.getByLabelText(/right %/i)).toHaveValue(8);
    expect(screen.getByLabelText(/top %/i)).toHaveValue(4);
    expect(screen.getByLabelText(/bottom %/i)).toHaveValue(6);
  });

  it("defaults crop fields to zero when the sequence has no crop_box", () => {
    render(
      <SequenceForm
        sequence={{ ...sequence, crop_box: null }}
        videoId={5}
        markStart={0}
        markEnd={20}
        existingSequences={[]}
        onCropChange={vi.fn()}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    expect(screen.getByLabelText(/left %/i)).toHaveValue(0);
    expect(screen.getByLabelText(/right %/i)).toHaveValue(0);
    expect(screen.getByLabelText(/top %/i)).toHaveValue(0);
    expect(screen.getByLabelText(/bottom %/i)).toHaveValue(0);
  });

  it("requires confirmation when only the crop changed, even if the range did not", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { ...sequence, crop_box: { left: 20, right: 0, top: 0, bottom: 0 } },
      error: undefined,
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

    await userEvent.clear(screen.getByLabelText(/fps/i));
    await userEvent.type(screen.getByLabelText(/fps/i), "2");
    await userEvent.clear(screen.getByLabelText(/left %/i));
    await userEvent.type(screen.getByLabelText(/left %/i), "20");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(apiClient.PATCH).toHaveBeenCalledWith(
      "/media/sequences/{sequence_id}",
      expect.objectContaining({
        body: expect.objectContaining({
          crop: { left: 20, right: 0, top: 0, bottom: 0 },
        }),
      })
    );
  });

  it("reports crop changes to the parent via onCropChange", async () => {
    const onCropChange = vi.fn();
    render(
      <SequenceForm
        sequence={{ ...sequence, crop_box: { left: 12, right: 8, top: 4, bottom: 6 } }}
        videoId={5}
        markStart={0}
        markEnd={20}
        existingSequences={[]}
        onCropChange={onCropChange}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    await waitFor(() =>
      expect(onCropChange).toHaveBeenCalledWith({ left: 12, right: 8, top: 4, bottom: 6 })
    );

    await userEvent.clear(screen.getByLabelText(/left %/i));
    await userEvent.type(screen.getByLabelText(/left %/i), "20");

    await waitFor(() =>
      expect(onCropChange).toHaveBeenLastCalledWith({ left: 20, right: 8, top: 4, bottom: 6 })
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/media/SequenceForm.test.tsx`
Expected: FAIL — the edit-mode tests fail because `handleEditSubmit`/`handleConfirm` are stubs (submitting does nothing, no PATCH call happens, no confirm step appears).

- [ ] **Step 3: Implement edit-mode submit/confirm logic**

In `frontend/src/features/media/SequenceForm.tsx`, replace the stub functions and the edit-mode button block as follows.

Replace:
```typescript
  // Edit-mode submit/confirm logic is implemented in Task 2.
  function handleEditSubmit(event: React.FormEvent) {
    event.preventDefault();
  }

  function handleConfirm() {
    // Implemented in Task 2.
  }
```
with:
```typescript
  const rangeChanged = isEdit && (startTime !== sequence!.start_time || duration !== sequence!.duration);
  const cropChanged =
    isEdit && JSON.stringify(crop) !== JSON.stringify((sequence!.crop_box as Crop | null) ?? ZERO_CROP);
  const needsRecut = rangeChanged || cropChanged;

  function handleEditSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (needsRecut) {
      setConfirming(true);
      return;
    }
    updateSequence.mutate(
      { sequenceId: sequence!.id, name, procedureId },
      { onSuccess: () => onDone() }
    );
  }

  function handleConfirm() {
    if (fps === "") return;
    updateSequence.mutate(
      { sequenceId: sequence!.id, name, procedureId, startTime, duration, fps, crop },
      {
        onSuccess: () => onDone(),
        onError: () => setConfirming(false),
      }
    );
  }
```

Replace the edit-mode JSX's button block:
```typescript
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={isPending}
            className="rounded bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={onDone}
            className="rounded border border-gray-700 px-3 py-2 text-sm hover:bg-gray-800"
          >
            Close
          </button>
        </div>
```
with:
```typescript
        {!confirming ? (
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={isPending || (needsRecut && fps === "")}
              className="rounded bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={onDone}
              className="rounded border border-gray-700 px-3 py-2 text-sm hover:bg-gray-800"
            >
              Close
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleConfirm}
              disabled={isPending}
              className="rounded bg-red-600 px-3 py-2 font-medium text-white hover:bg-red-500 disabled:opacity-50"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded border border-gray-700 px-3 py-2 text-sm hover:bg-gray-800"
            >
              Cancel
            </button>
          </div>
        )}
```

Also update the annotation-count warning condition (it already checks `confirming &&` per Task 1's stub — verify it reads `{confirming && sequence!.annotation_count > 0 && (...)}`, no change needed if so).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/media/SequenceForm.test.tsx`
Expected: PASS, all 18 tests green (5 create-mode from Task 1 + 13 edit-mode from this task).

- [ ] **Step 5: Commit**

```bash
cd frontend
git add src/features/media/SequenceForm.tsx src/features/media/SequenceForm.test.tsx
git commit -m "feat: implement SequenceForm edit mode with conditional re-cut confirmation"
```

---

### Task 3: Timeline click targets — name link, segment body, empty background

**Files:**
- Modify: `frontend/src/features/media/SequenceTimeline.tsx`
- Test: `frontend/src/features/media/SequenceTimeline.test.tsx`

**Interfaces:**
- Consumes: `pixelToSeconds`, `findSnapSeconds` from `frontend/src/features/media/computeTimelineDrag.ts` (existing, unchanged — already imported).
- Produces: `SequenceTimeline` with these prop changes consumed by Task 4's `VideoReviewPlayer.tsx` wiring:
  - Removed: `onRenameSequence: (id: number) => void`, `onRecutSequence: (id: number) => void`.
  - Added: `onSegmentClick: (sequenceId: number, startTime: number, endTime: number) => void`, `onEmptyBackgroundClick: () => void`.
  - Unchanged: `durationSeconds`, `sequences`, `markStart`, `markEnd`, `onOpenSequence`, `onMarkStartChange`, `onMarkEndChange`, `onScrub`.

**Design notes for the implementer:**

- Read the current `frontend/src/features/media/SequenceTimeline.tsx` in full before starting — this task modifies it in place, keeping the existing drag `useEffect`, `handleRootMouseDown`, and JSX structure for the pending overlay/handles exactly as-is. Only the segment rendering and the click-vs-drag discrimination are new.
- **Click-vs-drag discrimination:** the `DragState` type gains a `mouseDownClientX: number` field on the `"new"` variant (used only for the empty-background case; segment clicks don't need drag machinery since they don't visually drag). Update `handleRootMouseDown` to store `event.clientX` when starting a `"new"` drag: `setDragState({ edge: "new", anchorSeconds, mouseDownClientX: event.clientX })`. In `handleMouseUp` (inside the drag `useEffect`), receive the `MouseEvent` (change its signature from `function handleMouseUp()` to `function handleMouseUp(event: MouseEvent)`, and update `window.addEventListener("mouseup", handleMouseUp)` — no signature change needed there since `addEventListener` already passes the event) and check: if `dragState.edge === "new"` and `Math.abs(event.clientX - dragState.mouseDownClientX) < CLICK_THRESHOLD_PIXELS` (add `const CLICK_THRESHOLD_PIXELS = 3;` near the existing `SNAP_PIXELS`/`MIN_REGION_SECONDS` constants), treat as a click: compute the gap bounds (see below) and call `onMarkStartChange`/`onMarkEndChange` with them, then call `onEmptyBackgroundClick()`. Otherwise (real drag, or a handle drag), just `setDragState(null)` as today.
- **Gap computation for empty-background clicks:**
  ```typescript
  function computeGapBounds(clickSeconds: number, sequences: SequenceRead[], durationSeconds: number): [number, number] {
    let left = 0;
    let right = durationSeconds;
    for (const s of sequences) {
      const segEnd = s.start_time + s.duration;
      if (segEnd <= clickSeconds && segEnd > left) left = segEnd;
      if (s.start_time >= clickSeconds && s.start_time < right) right = s.start_time;
    }
    return [left, right];
  }
  ```
  `clickSeconds` is computed the same way the existing drag anchor is: `pixelToSeconds(event.clientX, rect, durationSeconds)` at the mousedown point (reuse the already-stored `dragState.anchorSeconds`, which was computed this way in `handleRootMouseDown` — do not recompute it in `handleMouseUp`).
- **Segment name click:** in the segment's JSX, change the `<span className="truncate">{sequence.name}</span>` to a clickable element with its own stopped-propagation click handler:
  ```typescript
  <button
    type="button"
    onClick={(event) => {
      event.stopPropagation();
      onOpenSequence(sequence.id);
    }}
    className="truncate underline"
  >
    {sequence.name}
  </button>
  ```
- **Segment body click:** the segment's outer `<div>` (currently just `title={sequence.name}` with no interaction) gets `onMouseDown`:
  ```typescript
  onMouseDown={(event) => {
    event.stopPropagation();
    onSegmentClick(sequence.id, sequence.start_time, sequence.start_time + sequence.duration);
  }}
  ```
  This fires immediately on mousedown (no drag or click-threshold logic needed here — a segment click has no visual drag of its own, so there's nothing to distinguish from). `stopPropagation()` prevents the root's `handleRootMouseDown` from also firing (same pattern already used by the mark handles).
- **Remove:** the three inline icon `<button>`s (↗ ✎ ✂, with their `aria-label`s `Open ${name}`/`Rename ${name}`/`Re-cut ${name}`) and the `onRenameSequence`/`onRecutSequence` props entirely.
- The segment `<div>`'s `title={sequence.name}` attribute can stay (harmless tooltip, not tested either way).

- [ ] **Step 1: Update existing tests' props and write the new failing tests**

In `frontend/src/features/media/SequenceTimeline.test.tsx`:

1. Remove `onRenameSequence={vi.fn()}` and `onRecutSequence={vi.fn()}` from every existing `render(<SequenceTimeline ... />)` call in the file (there are 11), and add `onSegmentClick={vi.fn()}` and `onEmptyBackgroundClick={vi.fn()}` to each instead — except where a test specifically needs to assert on one of those callbacks, in which case pass the real `vi.fn()` variable there (see below).
2. Delete the two tests `"calls onRenameSequence with the right id when a segment's rename action is used"` and `"calls onRecutSequence with the right id when a segment's re-cut action is used"` entirely — those actions no longer exist.
3. Update `"calls onOpenSequence with the right id when a segment's open action is used"` — the button's accessible name changes since the icon button `aria-label="Open ${name}"` is gone and it's now a plain button containing the name text. Change:
   ```typescript
   await userEvent.click(screen.getByRole("button", { name: /open larynx/i }));
   ```
   to:
   ```typescript
   await userEvent.click(screen.getByRole("button", { name: "Larynx" }));
   ```
4. Update `"clicking a segment's action button does not start a drag"` similarly — change `screen.getByRole("button", { name: /open larynx/i })` to `screen.getByRole("button", { name: "Larynx" })`.

Then add these new tests at the end of the `describe` block, before the closing `});`:

```typescript
  it("clicking a segment's name calls onOpenSequence, not onSegmentClick", async () => {
    const onOpen = vi.fn();
    const onSegmentClick = vi.fn();
    render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={sequences}
        markStart={null}
        markEnd={null}
        onOpenSequence={onOpen}
        onSegmentClick={onSegmentClick}
        onEmptyBackgroundClick={vi.fn()}
        onMarkStartChange={vi.fn()}
        onMarkEndChange={vi.fn()}
        onScrub={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Larynx" }));

    expect(onOpen).toHaveBeenCalledWith(1);
    expect(onSegmentClick).not.toHaveBeenCalled();
  });

  it("clicking a segment's body (not its name) calls onSegmentClick with the segment's bounds", () => {
    const onSegmentClick = vi.fn();
    render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={sequences}
        markStart={null}
        markEnd={null}
        onOpenSequence={vi.fn()}
        onSegmentClick={onSegmentClick}
        onEmptyBackgroundClick={vi.fn()}
        onMarkStartChange={vi.fn()}
        onMarkEndChange={vi.fn()}
        onScrub={vi.fn()}
      />
    );

    // Esophagus: start_time=20, duration=30 -> bounds [20, 50].
    fireEvent.mouseDown(screen.getByTitle("Esophagus"));

    expect(onSegmentClick).toHaveBeenCalledWith(2, 20, 50);
  });

  it("a true click on empty background (no meaningful mouse movement) sets marks to the gap between neighbors and calls onEmptyBackgroundClick", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });
    const onMarkStartChange = vi.fn();
    const onMarkEndChange = vi.fn();
    const onEmptyBackgroundClick = vi.fn();
    const { container } = render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={sequences}
        markStart={null}
        markEnd={null}
        onOpenSequence={vi.fn()}
        onSegmentClick={vi.fn()}
        onEmptyBackgroundClick={onEmptyBackgroundClick}
        onMarkStartChange={onMarkStartChange}
        onMarkEndChange={onMarkEndChange}
        onScrub={vi.fn()}
      />
    );

    // sequences: Larynx [0,20), Esophagus [20,50). Click in the gap after
    // Esophagus, e.g. clientX=140 -> 70s (200px/100s = 2px/s). Gap bounds:
    // left=50 (Esophagus's end), right=100 (durationSeconds, no next segment).
    const root = container.firstChild as HTMLElement;
    fireEvent.mouseDown(root, { clientX: 140, target: root, currentTarget: root });
    // No mousemove at all -- or one within the 3px threshold; mouseup at the same clientX.
    fireEvent.mouseUp(window, { clientX: 140 });

    expect(onMarkStartChange).toHaveBeenLastCalledWith(50);
    expect(onMarkEndChange).toHaveBeenLastCalledWith(100);
    expect(onEmptyBackgroundClick).toHaveBeenCalled();
  });

  it("a click between two segments sets marks to the gap bounded by both neighbors", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });
    const onMarkStartChange = vi.fn();
    const onMarkEndChange = vi.fn();
    const threeSequences = [
      { id: 1, name: "A", video_id: 5, procedure_id: 1, start_time: 0, duration: 20, annotation_count: 0 },
      { id: 2, name: "B", video_id: 5, procedure_id: 1, start_time: 40, duration: 10, annotation_count: 0 },
    ];
    const { container } = render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={threeSequences}
        markStart={null}
        markEnd={null}
        onOpenSequence={vi.fn()}
        onSegmentClick={vi.fn()}
        onEmptyBackgroundClick={vi.fn()}
        onMarkStartChange={onMarkStartChange}
        onMarkEndChange={onMarkEndChange}
        onScrub={vi.fn()}
      />
    );

    // Gap is [20, 40). Click at 30s -> clientX=60.
    const root = container.firstChild as HTMLElement;
    fireEvent.mouseDown(root, { clientX: 60, target: root, currentTarget: root });
    fireEvent.mouseUp(window, { clientX: 60 });

    expect(onMarkStartChange).toHaveBeenLastCalledWith(20);
    expect(onMarkEndChange).toHaveBeenLastCalledWith(40);
  });

  it("a real drag (movement past the 3px click threshold) still behaves as today's drag-to-create, not a click", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });
    const onMarkStartChange = vi.fn();
    const onMarkEndChange = vi.fn();
    const onEmptyBackgroundClick = vi.fn();
    const { container } = render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={[]}
        markStart={null}
        markEnd={null}
        onOpenSequence={vi.fn()}
        onSegmentClick={vi.fn()}
        onEmptyBackgroundClick={onEmptyBackgroundClick}
        onMarkStartChange={onMarkStartChange}
        onMarkEndChange={onMarkEndChange}
        onScrub={vi.fn()}
      />
    );

    const root = container.firstChild as HTMLElement;
    fireEvent.mouseDown(root, { clientX: 40, target: root, currentTarget: root });
    fireEvent.mouseMove(window, { clientX: 100 });
    fireEvent.mouseUp(window, { clientX: 100 });

    // Drag-to-create result (anchor=20s, dragged to 50s) must be preserved as-is.
    expect(onMarkStartChange).toHaveBeenLastCalledWith(20);
    expect(onMarkEndChange).toHaveBeenLastCalledWith(50);
    // The click-only callback must NOT fire for a real drag.
    expect(onEmptyBackgroundClick).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/media/SequenceTimeline.test.tsx`
Expected: FAIL — TypeScript errors on the removed/renamed props until the component is updated, then behavioral failures (no click discrimination exists yet, name isn't a separate clickable element, segment body has no `onMouseDown`).

- [ ] **Step 3: Implement the click targets and click-vs-drag discrimination**

Replace the full contents of `frontend/src/features/media/SequenceTimeline.tsx`:

```typescript
import { useEffect, useRef, useState } from "react";

import { findSnapSeconds, pixelToSeconds } from "./computeTimelineDrag";
import type { components } from "../../shared/api/generated/schema";

const SEGMENT_COLORS = ["bg-blue-600", "bg-emerald-600", "bg-amber-600", "bg-purple-600", "bg-pink-600"];
const SNAP_PIXELS = 8;
const MIN_REGION_SECONDS = 1;
const CLICK_THRESHOLD_PIXELS = 3;

type SequenceRead = components["schemas"]["SequenceRead"];
type DragState =
  | { edge: "start" | "end"; anchorSeconds: number }
  | { edge: "new"; anchorSeconds: number; mouseDownClientX: number };

function computeGapBounds(
  clickSeconds: number,
  sequences: SequenceRead[],
  durationSeconds: number
): [number, number] {
  let left = 0;
  let right = durationSeconds;
  for (const s of sequences) {
    const segEnd = s.start_time + s.duration;
    if (segEnd <= clickSeconds && segEnd > left) left = segEnd;
    if (s.start_time >= clickSeconds && s.start_time < right) right = s.start_time;
  }
  return [left, right];
}

export function SequenceTimeline({
  durationSeconds,
  sequences,
  markStart,
  markEnd,
  onOpenSequence,
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
  onOpenSequence: (id: number) => void;
  onSegmentClick: (sequenceId: number, startTime: number, endTime: number) => void;
  onEmptyBackgroundClick: () => void;
  onMarkStartChange: (seconds: number) => void;
  onMarkEndChange: (seconds: number) => void;
  onScrub: (seconds: number) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);

  function pct(seconds: number): number {
    if (durationSeconds <= 0) return 0;
    return (seconds / durationSeconds) * 100;
  }

  useEffect(() => {
    if (dragState === null) return;

    function handleMouseMove(event: MouseEvent) {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;

      const snapCandidates: number[] = sequences.flatMap((s) => [s.start_time, s.start_time + s.duration]);
      if (dragState!.edge === "start" && markEnd !== null) snapCandidates.push(markEnd);
      if (dragState!.edge === "end" && markStart !== null) snapCandidates.push(markStart);

      const raw = pixelToSeconds(event.clientX, rect, durationSeconds);
      const snapped = findSnapSeconds(raw, event.clientX, rect, durationSeconds, snapCandidates, SNAP_PIXELS);

      onScrub(snapped);

      if (dragState!.edge === "start") {
        const max = (markEnd ?? durationSeconds) - MIN_REGION_SECONDS;
        onMarkStartChange(Math.min(snapped, max));
      } else if (dragState!.edge === "end") {
        const min = (markStart ?? 0) + MIN_REGION_SECONDS;
        onMarkEndChange(Math.max(snapped, min));
      } else {
        const anchor = dragState!.anchorSeconds;
        let start = Math.min(anchor, snapped);
        let end = Math.max(anchor, snapped);
        if (end - start < MIN_REGION_SECONDS) {
          if (snapped >= anchor) {
            end = Math.min(durationSeconds, anchor + MIN_REGION_SECONDS);
          } else {
            start = Math.max(0, anchor - MIN_REGION_SECONDS);
          }
        }
        onMarkStartChange(start);
        onMarkEndChange(end);
      }
    }

    function handleMouseUp(event: MouseEvent) {
      const current = dragState!;
      if (current.edge === "new" && Math.abs(event.clientX - current.mouseDownClientX) < CLICK_THRESHOLD_PIXELS) {
        const [left, right] = computeGapBounds(current.anchorSeconds, sequences, durationSeconds);
        onMarkStartChange(left);
        onMarkEndChange(right);
        onEmptyBackgroundClick();
      }
      setDragState(null);
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragState, sequences, markStart, markEnd, durationSeconds, onMarkStartChange, onMarkEndChange, onScrub, onEmptyBackgroundClick]);

  function handleRootMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const anchorSeconds = pixelToSeconds(event.clientX, rect, durationSeconds);
    setDragState({ edge: "new", anchorSeconds, mouseDownClientX: event.clientX });
  }

  return (
    <div ref={rootRef} onMouseDown={handleRootMouseDown} className="relative h-10 w-full rounded bg-gray-800">
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
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpenSequence(sequence.id);
            }}
            className="truncate underline"
          >
            {sequence.name}
          </button>
        </div>
      ))}
      {markStart !== null && markEnd !== null && (
        <>
          <div
            data-testid="pending-mark-overlay"
            className="absolute top-0 h-full border-2 border-dashed border-yellow-400 bg-yellow-400/20 pointer-events-none"
            style={{
              left: `${pct(Math.min(markStart, markEnd))}%`,
              width: `${pct(Math.abs(markEnd - markStart))}%`,
            }}
          />
          <div
            data-testid="mark-handle-start"
            onMouseDown={(event) => {
              event.stopPropagation();
              setDragState({ edge: "start", anchorSeconds: 0 });
            }}
            className="absolute top-0 h-full bg-yellow-400/60"
            style={{ left: `${pct(Math.min(markStart, markEnd))}%`, width: "6px", cursor: "ew-resize" }}
          />
          <div
            data-testid="mark-handle-end"
            onMouseDown={(event) => {
              event.stopPropagation();
              setDragState({ edge: "end", anchorSeconds: 0 });
            }}
            className="absolute top-0 h-full bg-yellow-400/60"
            style={{ left: `calc(${pct(Math.max(markStart, markEnd))}% - 6px)`, width: "6px", cursor: "ew-resize" }}
          />
        </>
      )}
    </div>
  );
}
```

Note the `handleMouseUp` signature change from `function handleMouseUp()` to `function handleMouseUp(event: MouseEvent)` — this is required for the click-threshold check and matches how `handleMouseMove` already receives `event`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/media/SequenceTimeline.test.tsx`
Expected: PASS. Count: 11 original tests (2 removed for rename/re-cut, so 9 remain, 2 of those updated for the new button query) + 5 new = 14 total.

- [ ] **Step 5: Commit**

```bash
cd frontend
git add src/features/media/SequenceTimeline.tsx src/features/media/SequenceTimeline.test.tsx
git commit -m "feat: replace timeline icon buttons with name-link, segment-click, and empty-background-click targets"
```

---

### Task 4: Wire `VideoReviewPlayer` to `SequenceForm` and the new timeline props; delete the three superseded components

**Files:**
- Modify: `frontend/src/features/media/VideoReviewPlayer.tsx`
- Test: `frontend/src/features/media/VideoReviewPlayer.test.tsx`
- Delete: `frontend/src/features/media/RecutSequenceForm.tsx`, `frontend/src/features/media/RecutSequenceForm.test.tsx`, `frontend/src/features/media/SequenceFromMarksForm.tsx`, `frontend/src/features/media/SequenceFromMarksForm.test.tsx`, `frontend/src/features/media/RenameSequenceForm.tsx`, `frontend/src/features/media/RenameSequenceForm.test.tsx`

**Interfaces:**
- Consumes: `SequenceForm` from Task 1/2 (`frontend/src/features/media/SequenceForm.tsx`); `SequenceTimeline`'s new props from Task 3.
- Produces: nothing new consumed by later tasks — this is the final integration task.

**Design notes for the implementer:**

- Read the current `frontend/src/features/media/VideoReviewPlayer.tsx` in full before starting.
- Replace the three pieces of state `renamingSequenceId`, `recuttingSequenceId` with one: `const [editingSequenceId, setEditingSequenceId] = useState<number | null>(null);`. `markStart`/`markEnd` state stays exactly as-is (unchanged from the existing localStorage-persisted `useState` calls).
- Replace `handleRenameSequence`/`handleRecutSequence` with:
  ```typescript
  function handleSegmentClick(sequenceId: number, startTime: number, endTime: number) {
    setEditingSequenceId(sequenceId);
    setMarkStart(startTime);
    setMarkEnd(endTime);
  }

  function handleEmptyBackgroundClick() {
    setEditingSequenceId(null);
  }
  ```
  (`handleEmptyBackgroundClick` doesn't need to touch `markStart`/`markEnd` itself — `SequenceTimeline` already calls `onMarkStartChange`/`onMarkEndChange` with the gap bounds before calling `onEmptyBackgroundClick`, per Task 3. This handler only needs to guarantee create mode renders, i.e. that no stale `editingSequenceId` is left over from a previous segment click.)
- `handleEditDone` (existing) changes to reset `editingSequenceId` instead of `renamingSequenceId`/`recuttingSequenceId`:
  ```typescript
  function handleEditDone() {
    setEditingSequenceId(null);
    setMarkStart(null);
    setMarkEnd(null);
    setActiveCrop(null);
    sequencesQuery.refetch();
  }
  ```
- `handleCreated` (existing, used when `SequenceForm` create-mode's `onDone` fires) stays as-is — it already does the right thing (reset marks, clear crop, refetch). Since Task 1/2's `SequenceForm` uses a single `onDone` prop for both modes (not separate `onCreated`/`onDone` names), wire create-mode's `onDone={handleCreated}` and edit-mode's `onDone={handleEditDone}` — same function names as today, just now both flow through `SequenceForm`'s single `onDone` prop name instead of the old components' differently-named props.
- Replace the render logic. Currently three mutually-exclusive conditional blocks (`renamingSequenceId !== null`, `recuttingSequenceId !== null && marks`, `marks && no editing`) become two:
  ```typescript
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
  {editingSequenceId === null && markStart !== null && markEnd !== null && markEnd !== markStart && (
    <SequenceForm
      videoId={videoId}
      markStart={markStart}
      markEnd={markEnd}
      procedureId={video.procedure_id ?? undefined}
      existingSequences={sequencesQuery.data ?? []}
      onCropChange={setActiveCrop}
      onDone={handleCreated}
    />
  )}
  {editingSequenceId === null && markStart !== null && markEnd !== null && markEnd === markStart && (
    <p className="text-sm text-red-400">Start and end can&apos;t be the same point.</p>
  )}
  ```
  (The `markEnd === markStart` zero-width guard stays exactly as today, unchanged, only re-scoped to `editingSequenceId === null`.)
- Update the `<SequenceTimeline ... />` call: remove `onRenameSequence={handleRenameSequence}` and `onRecutSequence={handleRecutSequence}`, add `onSegmentClick={handleSegmentClick}` and `onEmptyBackgroundClick={handleEmptyBackgroundClick}`.
- Remove the now-unused imports of `RenameSequenceForm`, `RecutSequenceForm`, `SequenceFromMarksForm`; add `import { SequenceForm } from "./SequenceForm";`.
- **Widen the panel slightly:** the side panel `<div>` currently has `className="flex min-w-0 flex-[2] flex-col gap-3 rounded border border-gray-800 bg-gray-950 p-3"`. Change the flex ratio from the video's `flex-[3]` / panel's `flex-[2]` (60/40) to `flex-[2]` / `flex-[3]` — i.e. change the video `<div>`'s class from `"relative min-w-0 flex-[3]"` to `"relative min-w-0 flex-[2]"` and the panel's from `flex-[2]` to `flex-[3]"` (40/60), giving the panel more room for `SequenceForm`'s combined field set. Keep every other class on both divs unchanged.

- [ ] **Step 1: Update the test file**

In `frontend/src/features/media/VideoReviewPlayer.test.tsx`, update the one test that exercises the old re-cut-icon flow, `"pre-fills marks from the clicked segment and PATCHes on re-cut confirm"`. Change:
```typescript
    await userEvent.click(await screen.findByRole("button", { name: /re-cut larynx/i }));
    expect(await screen.findByText(/10s – 30s/)).toBeInTheDocument();

    const fpsInput = screen.getByLabelText(/fps/i);
    await userEvent.type(fpsInput, "3");
    await userEvent.click(screen.getByRole("button", { name: /^re-cut$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /confirm/i }));
```
to:
```typescript
    fireEvent.mouseDown(screen.getByTitle("Larynx"));
    expect(await screen.findByText(/10s – 30s/)).toBeInTheDocument();

    const fpsInput = screen.getByLabelText(/fps/i);
    await userEvent.type(fpsInput, "3");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /confirm/i }));
```
(`fireEvent.mouseDown` on the segment `<div>` found by its `title` attribute replicates a click on the segment body — matching the pattern Task 3's own tests use. `fireEvent` is already imported in this file.)

Also update `"wires sequencesQuery data into SequenceFromMarksForm so it inherits a real fetched crop_box"` — only the test's name/comment references the old component name; its behavior (Mark start/Mark end buttons driving create-mode crop inheritance) is unchanged, so only rename the `it(...)` description string to `"wires sequencesQuery data into SequenceForm's create mode so it inherits a real fetched crop_box"` — no other change needed in that test's body.

- [ ] **Step 2: Run tests to verify the updated test fails against the current (pre-Task-4) component**

Run: `cd frontend && npx vitest run src/features/media/VideoReviewPlayer.test.tsx`
Expected: FAIL — `screen.getByTitle("Larynx")` mousedown does nothing on the current component (no `onSegmentClick` wiring yet), so `"10s – 30s"` never appears.

- [ ] **Step 3: Wire `VideoReviewPlayer.tsx` and delete the superseded components**

Apply the state/handler/render changes described in the design notes above to `frontend/src/features/media/VideoReviewPlayer.tsx`.

Then delete the superseded files:
```bash
cd frontend
rm src/features/media/RecutSequenceForm.tsx src/features/media/RecutSequenceForm.test.tsx
rm src/features/media/SequenceFromMarksForm.tsx src/features/media/SequenceFromMarksForm.test.tsx
rm src/features/media/RenameSequenceForm.tsx src/features/media/RenameSequenceForm.test.tsx
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/media/VideoReviewPlayer.test.tsx`
Expected: PASS, all 9 tests green (8 existing, one updated in Step 1).

- [ ] **Step 5: Run the full frontend suite**

Run: `cd frontend && npx vitest run`
Expected: PASS, all tests green. Compute the expected count: prior total (193, per the previous plan's final state) minus the 3 deleted test files' counts (`RecutSequenceForm.test.tsx` had 11 tests, `SequenceFromMarksForm.test.tsx` had 6 tests — both fully superseded by `SequenceForm.test.tsx`'s 18 tests from Tasks 1-2; `RenameSequenceForm.test.tsx`'s count — check it directly with `wc -l` and read it before deleting, since this plan did not enumerate its exact test count) plus `SequenceForm.test.tsx`'s 18 plus `SequenceTimeline.test.tsx`'s net change (14, up from 11, i.e. +3) — do not hard-code a specific final number in your report beyond what the actual run prints; just confirm 0 failures.

- [ ] **Step 6: Commit**

```bash
cd frontend
git add -A
git commit -m "feat: wire VideoReviewPlayer to consolidated SequenceForm and timeline click targets, widen side panel"
```

---

## Manual Verification (after all tasks complete)

Per CLAUDE.md's testing philosophy, exercise this for real in a browser before trusting the test suite alone — this change touches mouse-event geometry and multi-step form state that unit tests with `fireEvent` can miss in ways real cursor behavior would catch.

1. Start the stack per `CLAUDE.md`'s "Running the stack" section.
2. Open a video with at least one existing sequence.
3. Click a segment's name (the underlined text) — confirm it navigates into that sequence, exactly like the old ↗ button did.
4. Click elsewhere on a segment's body (not the name) — confirm the combined form opens in edit mode, pre-filled with that sequence's name/procedure/crop, with the yellow region shown on the timeline at that sequence's bounds and draggable by its handles as before.
5. Edit only the name and click Save — confirm it saves immediately with no confirmation dialog.
6. Drag an edge to change the range, then click Save — confirm the annotation-deletion confirmation appears (if the sequence has annotations) before it actually saves.
7. Click empty timeline background between two existing sequences (a real click, no drag) — confirm a new pending region appears auto-stretched to fill exactly that gap, and the combined form opens in create mode.
8. Click empty background before the first sequence, and after the last sequence — confirm the auto-stretch correctly uses `0`/`durationSeconds` as the open-ended bound.
9. Confirm a real drag (mouse actually moves) from empty background still behaves as the existing drag-to-create, not a click.
10. Confirm the side panel is visibly wider than before, and the combined form doesn't feel cramped.
11. Confirm "Mark start"/"Mark end" buttons and their mm:ss timestamps still work exactly as before, independent of all the above.
