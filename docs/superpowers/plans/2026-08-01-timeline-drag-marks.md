# Timeline Drag-to-Adjust Marks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user drag the edges of the pending mark region directly on `SequenceTimeline`, with edges snapping to adjacent sequence boundaries and the video player scrubbing to the cursor position live, while keeping the existing "Mark start"/"Mark end" buttons working exactly as before.

**Architecture:** A new pure-function module (`computeTimelineDrag.ts`) handles all pixel↔seconds math and snap-candidate resolution, fully unit-testable without DOM events. `SequenceTimeline.tsx` gets local drag state, `window`-level `mousemove`/`mouseup` listeners for the duration of a drag, two small grab-handle `<div>`s on the pending overlay's edges, and an empty-background `mousedown` handler that starts a brand-new region. `VideoReviewPlayer.tsx` wires three new callback props (`onMarkStartChange`, `onMarkEndChange`, `onScrub`) into its existing `markStart`/`markEnd` state and `videoRef`.

**Tech Stack:** React 18, TypeScript, Vitest + @testing-library/react (`fireEvent` for mouse events), existing Tailwind dark-theme classes.

## Global Constraints

- **Language:** English only in code, comments, and UI copy (CLAUDE.md). This conversation is Russian; the code and plan text below are English.
- **TDD:** every frontend task with logic gets a failing test before the implementation (CLAUDE.md).
- Snap threshold: **8 screen pixels**, not time-based (spec).
- Grab handle width: **6px** (spec).
- Minimum region width when dragging an edge: **1 second** — an edge cannot cross the opposite edge (spec).
- Mark buttons ("Mark start"/"Mark end") keep their current behavior unchanged; both mechanisms write to the same `markStart`/`markEnd` state (spec).
- Dragging the whole pending region as a unit is explicitly out of scope for this plan (spec).
- No touch/pointer-event support, no keyboard-accessible dragging (spec, "Out of scope").
- `SequenceTimeline`'s existing props (`durationSeconds`, `sequences`, `markStart`, `markEnd`, `onOpenSequence`, `onRenameSequence`, `onRecutSequence`) and existing rendering (colored segments, their Open/Rename/Re-cut buttons, the `pending-mark-overlay` test id) must keep working — this plan only adds behavior, it doesn't replace the existing test suite's assertions (`frontend/src/features/media/SequenceTimeline.test.tsx`).

---

### Task 1: Pure geometry functions — `computeTimelineDrag.ts`

**Files:**
- Create: `frontend/src/features/media/computeTimelineDrag.ts`
- Test: `frontend/src/features/media/computeTimelineDrag.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions, no dependencies on other new code).
- Produces:
  - `pixelToSeconds(clientX: number, timelineRect: { left: number; width: number }, durationSeconds: number): number`
  - `findSnapSeconds(rawSeconds: number, clientX: number, timelineRect: { left: number; width: number }, durationSeconds: number, snapCandidates: number[], snapPixels: number): number`

These two functions are consumed by Task 2's `SequenceTimeline.tsx` drag handlers.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from "vitest";

import { findSnapSeconds, pixelToSeconds } from "./computeTimelineDrag";

describe("pixelToSeconds", () => {
  it("maps the timeline's left edge to 0 seconds", () => {
    expect(pixelToSeconds(100, { left: 100, width: 200 }, 60)).toBe(0);
  });

  it("maps the timeline's right edge to durationSeconds", () => {
    expect(pixelToSeconds(300, { left: 100, width: 200 }, 60)).toBe(60);
  });

  it("maps the midpoint proportionally", () => {
    expect(pixelToSeconds(200, { left: 100, width: 200 }, 60)).toBe(30);
  });

  it("clamps clientX below the timeline's left edge to 0", () => {
    expect(pixelToSeconds(0, { left: 100, width: 200 }, 60)).toBe(0);
  });

  it("clamps clientX past the timeline's right edge to durationSeconds", () => {
    expect(pixelToSeconds(1000, { left: 100, width: 200 }, 60)).toBe(60);
  });

  it("returns 0 when width is 0 (avoids division by zero)", () => {
    expect(pixelToSeconds(150, { left: 100, width: 0 }, 60)).toBe(0);
  });
});

describe("findSnapSeconds", () => {
  const rect = { left: 0, width: 200 };
  // 200px wide timeline, 100-second video: 2px per second.

  it("returns rawSeconds unchanged when no candidate is within snapPixels", () => {
    // clientX=60 -> 30s raw. Nearest candidate (0s @ clientX=0) is 60px away.
    const result = findSnapSeconds(30, 60, rect, 100, [0], 8);
    expect(result).toBe(30);
  });

  it("snaps to a candidate within snapPixels", () => {
    // Candidate at 30s sits at clientX=60. Cursor at clientX=63 (3px away, within 8px threshold).
    const result = findSnapSeconds(31.5, 63, rect, 100, [30], 8);
    expect(result).toBe(30);
  });

  it("picks the nearest candidate when multiple are within snapPixels", () => {
    // Candidates at 30s (clientX=60) and 31s (clientX=62); cursor at clientX=61.
    const result = findSnapSeconds(30.5, 61, rect, 100, [30, 31], 8);
    expect(result).toBe(31);
  });

  it("ignores candidates outside [0, durationSeconds]", () => {
    // Candidate at -5s would sit off-screen; must not be selected even if arithmetically "close".
    const result = findSnapSeconds(30, 60, rect, 100, [-5, 30], 8);
    expect(result).toBe(30);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/media/computeTimelineDrag.test.ts`
Expected: FAIL with "Cannot find module './computeTimelineDrag'" (or similar — the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```typescript
export function pixelToSeconds(
  clientX: number,
  timelineRect: { left: number; width: number },
  durationSeconds: number
): number {
  if (timelineRect.width <= 0) return 0;
  const fraction = (clientX - timelineRect.left) / timelineRect.width;
  const clampedFraction = Math.min(1, Math.max(0, fraction));
  return clampedFraction * durationSeconds;
}

export function findSnapSeconds(
  rawSeconds: number,
  clientX: number,
  timelineRect: { left: number; width: number },
  durationSeconds: number,
  snapCandidates: number[],
  snapPixels: number
): number {
  let best: { seconds: number; distance: number } | null = null;
  for (const candidate of snapCandidates) {
    if (candidate < 0 || candidate > durationSeconds) continue;
    const candidateX = timelineRect.left + (candidate / durationSeconds) * timelineRect.width;
    const distance = Math.abs(candidateX - clientX);
    if (distance <= snapPixels && (best === null || distance < best.distance)) {
      best = { seconds: candidate, distance };
    }
  }
  return best !== null ? best.seconds : rawSeconds;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/media/computeTimelineDrag.test.ts`
Expected: PASS, all 10 tests green.

- [ ] **Step 5: Commit**

```bash
cd frontend
git add src/features/media/computeTimelineDrag.ts src/features/media/computeTimelineDrag.test.ts
git commit -m "feat: add pure pixel/seconds and snap-candidate math for timeline drag"
```

---

### Task 2: Drag interaction on `SequenceTimeline`

**Files:**
- Modify: `frontend/src/features/media/SequenceTimeline.tsx`
- Test: `frontend/src/features/media/SequenceTimeline.test.tsx`

**Interfaces:**
- Consumes: `pixelToSeconds`, `findSnapSeconds` from Task 1's `computeTimelineDrag.ts`.
- Produces: `SequenceTimeline` gains three new **required** props consumed by Task 3's `VideoReviewPlayer.tsx`:
  - `onMarkStartChange: (seconds: number) => void`
  - `onMarkEndChange: (seconds: number) => void`
  - `onScrub: (seconds: number) => void`

The existing props (`durationSeconds`, `sequences`, `markStart`, `markEnd`, `onOpenSequence`, `onRenameSequence`, `onRecutSequence`) are unchanged.

**Design notes for the implementer:**

- The component needs a `ref` on its root `<div>` to read `getBoundingClientRect()` during drag. Use `useRef<HTMLDivElement>(null)`.
- Drag state is `useState<{ edge: "start" | "end" | "new"; anchorSeconds: number } | null>(null)`.
  - `"start"` / `"end"`: dragging an existing pending edge; the *other* edge stays fixed at its current `markStart`/`markEnd` value (no `anchorSeconds` needed for these two, but keep the field for `"new"`).
  - `"new"`: dragging out a brand-new region from empty background; `anchorSeconds` is the mousedown point, fixed for the duration of the drag, and the moving edge is whichever one is currently further from the anchor is NOT relevant — simpler: the anchor is always the *fixed* edge, and the moving edge follows the cursor. On mouseup, `onMarkStartChange`/`onMarkEndChange` are called with `Math.min(anchor, current)` / `Math.max(anchor, current)` respectively so the region is always well-formed regardless of drag direction.
- Snap candidates during a drag: every sequence's `start_time` and `start_time + duration`, PLUS (for `"start"`/`"end"` drags only) the *other* pending edge's current value, so the dragged edge can snap flush against its own partner. Compute this array fresh on each mousemove from the current `sequences`/`markStart`/`markEnd` props (they're already in scope).
- `mousemove`/`mouseup` listeners are attached to `window` (not the component's own div) inside a `useEffect` keyed on whether `dragState !== null`, so the drag continues even if the cursor leaves the timeline's bounding box mid-drag; the effect's cleanup removes them. This is the standard "drag outside the element" pattern — do not attach these listeners directly as JSX props.
- On every `mousemove` while dragging: compute `rawSeconds` via `pixelToSeconds`, then `snappedSeconds` via `findSnapSeconds` with the snap candidates described above, then:
  - Call `onScrub(snappedSeconds)` unconditionally (every move, live).
  - For `"start"`: clamp `snappedSeconds` to `Math.min(snappedSeconds, markEnd! - 1)` (1-second minimum width; `markEnd` is guaranteed non-null while dragging an existing edge since edges only render when `markStart !== null && markEnd !== null`) then call `onMarkStartChange(clamped)`.
  - For `"end"`: clamp to `Math.max(snappedSeconds, markStart! + 1)` then call `onMarkEndChange(clamped)`.
  - For `"new"`: call **both** `onMarkStartChange(Math.min(anchorSeconds, snappedSeconds))` and `onMarkEndChange(Math.max(anchorSeconds, snappedSeconds))` so the overlay (which only renders when both marks are non-null) appears immediately on the first move, not just on mouseup.
- On `mouseup`: just clear drag state (`setDragState(null)`) — the marks are already live-updated via the mousemove handler above, there is nothing left to commit.
- Two grab-handle `<div>`s are rendered only when `markStart !== null && markEnd !== null` (i.e., alongside the existing pending overlay), absolutely positioned at the overlay's left/right edges, `6px` wide, with `cursor: ew-resize` (use an inline `style` for the cursor and width since Tailwind has no arbitrary-width utility already in use here — follow the existing inline-`style` pattern already used for `left`/`width`/`height` percentages in this same file).
  - `data-testid="mark-handle-start"` for the left handle, `onMouseDown` sets `dragState = { edge: "start", anchorSeconds: 0 }` (anchor unused for this branch but keep the shape consistent) and calls `event.stopPropagation()` so the mousedown doesn't also bubble to the root div's empty-background handler.
  - `data-testid="mark-handle-end"` for the right handle, same pattern with `edge: "end"`.
- The root `<div>`'s existing `onMouseDown` (new) starts a `"new"` drag **only** when `event.target === event.currentTarget` (i.e., the mousedown landed on the empty background, not bubbled up from a segment, button, or handle) AND no pending region already exists is NOT a requirement — re-read the spec: dragging out a *new* region is for when there's no existing pending region, but nothing prevents starting a fresh "new" drag over empty space even if one already exists elsewhere on a long timeline. Keep it simple: any empty-background mousedown starts a `"new"` drag with `anchorSeconds = pixelToSeconds(event.clientX, rect, durationSeconds)` (no snapping on the initial anchor point — only the moving edge snaps).
- Existing segment `<div>`s and their Open/Rename/Re-cut `<button>`s do not get any new mousedown handling — clicks on them naturally have `event.target !== event.currentTarget` on the root div (they're nested children), so the root's empty-background check already excludes them. No new code needed there.

- [ ] **Step 1: Write the failing tests**

Add to the bottom of `frontend/src/features/media/SequenceTimeline.test.tsx` (inside the existing `describe("SequenceTimeline", ...)` block, after the last existing `it`). These tests need every render call in the file updated with the two new required props — update ALL existing `render(<SequenceTimeline ... />)` calls in this file (there are 5, one per existing `it` block) to add `onMarkStartChange={vi.fn()} onMarkEndChange={vi.fn()} onScrub={vi.fn()}` alongside the existing props, otherwise TypeScript will fail to compile the test file once Task 2's implementation step adds the required props. Do this update to the existing tests as part of Step 1, not as a separate step.

```typescript
  it("drag-creates a new pending region from empty timeline background", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });
    const onMarkStartChange = vi.fn();
    const onMarkEndChange = vi.fn();
    const onScrub = vi.fn();
    const { container } = render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={[]}
        markStart={null}
        markEnd={null}
        onOpenSequence={vi.fn()}
        onRenameSequence={vi.fn()}
        onRecutSequence={vi.fn()}
        onMarkStartChange={onMarkStartChange}
        onMarkEndChange={onMarkEndChange}
        onScrub={onScrub}
      />
    );

    const root = container.firstChild as HTMLElement;
    // 200px wide timeline, 100s video -> 2px/second. clientX=40 -> 20s anchor.
    fireEvent.mouseDown(root, { clientX: 40, target: root, currentTarget: root });
    // clientX=100 -> 50s.
    fireEvent.mouseMove(window, { clientX: 100 });

    expect(onMarkStartChange).toHaveBeenLastCalledWith(20);
    expect(onMarkEndChange).toHaveBeenLastCalledWith(50);
    expect(onScrub).toHaveBeenLastCalledWith(50);

    fireEvent.mouseUp(window);
  });

  it("dragging the start handle moves only markStart, leaving markEnd fixed", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });
    const onMarkStartChange = vi.fn();
    const onMarkEndChange = vi.fn();
    render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={[]}
        markStart={10}
        markEnd={60}
        onOpenSequence={vi.fn()}
        onRenameSequence={vi.fn()}
        onRecutSequence={vi.fn()}
        onMarkStartChange={onMarkStartChange}
        onMarkEndChange={onMarkEndChange}
        onScrub={vi.fn()}
      />
    );

    const handle = screen.getByTestId("mark-handle-start");
    fireEvent.mouseDown(handle);
    // clientX=50 -> 25s.
    fireEvent.mouseMove(window, { clientX: 50 });

    expect(onMarkStartChange).toHaveBeenLastCalledWith(25);
    expect(onMarkEndChange).not.toHaveBeenCalled();

    fireEvent.mouseUp(window);
  });

  it("dragging the end handle moves only markEnd, leaving markStart fixed", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });
    const onMarkStartChange = vi.fn();
    const onMarkEndChange = vi.fn();
    render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={[]}
        markStart={10}
        markEnd={60}
        onOpenSequence={vi.fn()}
        onRenameSequence={vi.fn()}
        onRecutSequence={vi.fn()}
        onMarkStartChange={onMarkStartChange}
        onMarkEndChange={onMarkEndChange}
        onScrub={vi.fn()}
      />
    );

    const handle = screen.getByTestId("mark-handle-end");
    fireEvent.mouseDown(handle);
    // clientX=150 -> 75s.
    fireEvent.mouseMove(window, { clientX: 150 });

    expect(onMarkEndChange).toHaveBeenLastCalledWith(75);
    expect(onMarkStartChange).not.toHaveBeenCalled();

    fireEvent.mouseUp(window);
  });

  it("snaps a dragged edge to an adjacent sequence boundary within 8px", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });
    const onMarkEndChange = vi.fn();
    render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={[{ id: 1, name: "Larynx", video_id: 5, procedure_id: 1, start_time: 0, duration: 76, annotation_count: 0 }]}
        markStart={10}
        markEnd={60}
        onOpenSequence={vi.fn()}
        onRenameSequence={vi.fn()}
        onRecutSequence={vi.fn()}
        onMarkStartChange={vi.fn()}
        onMarkEndChange={onMarkEndChange}
        onScrub={vi.fn()}
      />
    );

    // Larynx ends at 76s -> clientX=152. Drag end handle to clientX=155 (3px away, within 8px threshold).
    const handle = screen.getByTestId("mark-handle-end");
    fireEvent.mouseDown(handle);
    fireEvent.mouseMove(window, { clientX: 155 });

    expect(onMarkEndChange).toHaveBeenLastCalledWith(76);

    fireEvent.mouseUp(window);
  });

  it("does not let the start handle cross past markEnd minus the 1-second minimum width", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });
    const onMarkStartChange = vi.fn();
    render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={[]}
        markStart={10}
        markEnd={20}
        onOpenSequence={vi.fn()}
        onRenameSequence={vi.fn()}
        onRecutSequence={vi.fn()}
        onMarkStartChange={onMarkStartChange}
        onMarkEndChange={vi.fn()}
        onScrub={vi.fn()}
      />
    );

    // Drag start handle far past markEnd (20s -> clientX=40). clientX=180 -> 90s raw.
    const handle = screen.getByTestId("mark-handle-start");
    fireEvent.mouseDown(handle);
    fireEvent.mouseMove(window, { clientX: 180 });

    // Clamped to markEnd(20) - 1 = 19.
    expect(onMarkStartChange).toHaveBeenLastCalledWith(19);

    fireEvent.mouseUp(window);
  });

  it("clicking a segment's action button does not start a drag", async () => {
    const onOpen = vi.fn();
    const onMarkStartChange = vi.fn();
    render(
      <SequenceTimeline
        durationSeconds={100}
        sequences={sequences}
        markStart={null}
        markEnd={null}
        onOpenSequence={onOpen}
        onRenameSequence={vi.fn()}
        onRecutSequence={vi.fn()}
        onMarkStartChange={onMarkStartChange}
        onMarkEndChange={vi.fn()}
        onScrub={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: /open larynx/i }));

    expect(onOpen).toHaveBeenCalledWith(1);
    expect(onMarkStartChange).not.toHaveBeenCalled();
  });
```

Also add `fireEvent` to the existing `import { render, screen } from "@testing-library/react";` line, changing it to `import { fireEvent, render, screen } from "@testing-library/react";`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/media/SequenceTimeline.test.tsx`
Expected: FAIL — TypeScript errors on the missing `onMarkStartChange`/`onMarkEndChange`/`onScrub` props on the existing `render` calls (until Step 1's prop updates are applied, then FAIL because `mark-handle-start`/`mark-handle-end` don't exist and the component doesn't call the new callbacks).

- [ ] **Step 3: Implement the drag behavior**

Replace the full contents of `frontend/src/features/media/SequenceTimeline.tsx`:

```typescript
import { useEffect, useRef, useState } from "react";

import { findSnapSeconds, pixelToSeconds } from "./computeTimelineDrag";
import type { components } from "../../shared/api/generated/schema";

const SEGMENT_COLORS = ["bg-blue-600", "bg-emerald-600", "bg-amber-600", "bg-purple-600", "bg-pink-600"];
const SNAP_PIXELS = 8;
const MIN_REGION_SECONDS = 1;

type SequenceRead = components["schemas"]["SequenceRead"];
type DragState = { edge: "start" | "end" | "new"; anchorSeconds: number };

export function SequenceTimeline({
  durationSeconds,
  sequences,
  markStart,
  markEnd,
  onOpenSequence,
  onRenameSequence,
  onRecutSequence,
  onMarkStartChange,
  onMarkEndChange,
  onScrub,
}: {
  durationSeconds: number;
  sequences: SequenceRead[];
  markStart: number | null;
  markEnd: number | null;
  onOpenSequence: (id: number) => void;
  onRenameSequence: (id: number) => void;
  onRecutSequence: (id: number) => void;
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
        onMarkStartChange(Math.min(dragState!.anchorSeconds, snapped));
        onMarkEndChange(Math.max(dragState!.anchorSeconds, snapped));
      }
    }

    function handleMouseUp() {
      setDragState(null);
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragState, sequences, markStart, markEnd, durationSeconds, onMarkStartChange, onMarkEndChange, onScrub]);

  function handleRootMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const anchorSeconds = pixelToSeconds(event.clientX, rect, durationSeconds);
    setDragState({ edge: "new", anchorSeconds });
  }

  return (
    <div ref={rootRef} onMouseDown={handleRootMouseDown} className="relative h-10 w-full rounded bg-gray-800">
      {sequences.map((sequence) => (
        <div
          key={sequence.id}
          title={sequence.name}
          className={`absolute top-0 flex h-full items-center justify-center overflow-hidden whitespace-nowrap px-1 text-xs text-white ${SEGMENT_COLORS[sequence.id % SEGMENT_COLORS.length]}`}
          style={{ left: `${pct(sequence.start_time)}%`, width: `${pct(sequence.duration)}%` }}
        >
          <span className="truncate">{sequence.name}</span>
          <button
            type="button"
            aria-label={`Open ${sequence.name}`}
            onClick={() => onOpenSequence(sequence.id)}
            className="ml-1 shrink-0 underline"
          >
            ↗
          </button>
          <button
            type="button"
            aria-label={`Rename ${sequence.name}`}
            onClick={() => onRenameSequence(sequence.id)}
            className="ml-1 shrink-0 underline"
          >
            ✎
          </button>
          <button
            type="button"
            aria-label={`Re-cut ${sequence.name}`}
            onClick={() => onRecutSequence(sequence.id)}
            className="ml-1 shrink-0 underline"
          >
            ✂
          </button>
        </div>
      ))}
      {markStart !== null && markEnd !== null && (
        <>
          <div
            data-testid="pending-mark-overlay"
            className="absolute top-0 h-full border-2 border-dashed border-yellow-400 bg-yellow-400/20"
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/media/SequenceTimeline.test.tsx`
Expected: PASS, all 11 tests green (5 existing + 6 new).

- [ ] **Step 5: Commit**

```bash
cd frontend
git add src/features/media/SequenceTimeline.tsx src/features/media/SequenceTimeline.test.tsx
git commit -m "feat: add drag-to-adjust handles and snap-to-boundary to the sequence timeline"
```

---

### Task 3: Wire `VideoReviewPlayer` to the new timeline callbacks

**Files:**
- Modify: `frontend/src/features/media/VideoReviewPlayer.tsx`
- Test: `frontend/src/features/media/VideoReviewPlayer.test.tsx`

**Interfaces:**
- Consumes: `SequenceTimeline`'s new required props from Task 2 (`onMarkStartChange`, `onMarkEndChange`, `onScrub`).
- Produces: nothing new consumed by later tasks — this is the final integration task.

**Design notes for the implementer:**

- `VideoReviewPlayer.tsx` already has `setMarkStart`/`setMarkEnd` (from `useState`) and `videoRef` (a `useRef<HTMLVideoElement>`) in scope — see the current file, lines 42-43 and 41.
- Add the three new props to the existing `<SequenceTimeline ... />` call (around line 205-213 in the current file):
  - `onMarkStartChange={setMarkStart}`
  - `onMarkEndChange={setMarkEnd}`
  - `onScrub={(seconds) => { if (videoRef.current) videoRef.current.currentTime = seconds; }}`
- No other changes to this file — `markStart`/`markEnd` already flow into the existing localStorage-persistence `useEffect` (lines 63-69 in the current file) and into `SequenceFromMarksForm`/`RecutSequenceForm` unchanged, so drag-set marks persist and feed those forms exactly like button-set marks already do.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/features/media/VideoReviewPlayer.test.tsx`, inside the existing `describe("VideoReviewPlayer", ...)` block, after the last existing `it`:

```typescript
  it("scrubs the video's currentTime when the timeline reports a scrub position", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path) => {
      if (path === "/media/videos/{video_id}") {
        return {
          data: {
            id: 5, filename: "a.mp4", title: "A", procedure_id: 1, fps: 1,
            duration_seconds: 60, size_bytes: 100,
            browser_playable: true, container: "mov,mp4,m4a,3gp,3g2,mj2", video_codec: "h264",
            stream_url: "https://minio.local/videos/a.mp4?signed=1",
          },
          error: undefined,
        } as never;
      }
      if (path === "/media/videos/{video_id}/sequences") {
        return { data: [], error: undefined } as never;
      }
      return { data: undefined, error: undefined } as never;
    });

    render(<VideoReviewPlayer videoId={5} onBack={vi.fn()} onOpenSequence={vi.fn()} />, { wrapper });

    const video = await waitFor(() => {
      const el = document.querySelector("video");
      expect(el).toBeInTheDocument();
      return el as HTMLVideoElement;
    });
    fireEvent.loadedMetadata(video);

    let currentTimeSetTo: number | null = null;
    Object.defineProperty(video, "currentTime", {
      get: () => 0,
      set: (value: number) => { currentTimeSetTo = value; },
      configurable: true,
    });

    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });

    // The timeline is the only element with class "relative h-10 w-full rounded bg-gray-800".
    const timelineRoot = document.querySelector(".relative.h-10.w-full.rounded.bg-gray-800") as HTMLElement;
    fireEvent.mouseDown(timelineRoot, { clientX: 40, target: timelineRoot, currentTarget: timelineRoot });
    fireEvent.mouseMove(window, { clientX: 100 });
    fireEvent.mouseUp(window);

    expect(currentTimeSetTo).toBe(30);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/media/VideoReviewPlayer.test.tsx`
Expected: FAIL — TypeScript error, `SequenceTimeline` is missing the required `onMarkStartChange`/`onMarkEndChange`/`onScrub` props in `VideoReviewPlayer.tsx`'s render (this is the correct failure at this point, since Task 2 already made those props required and Task 3 hasn't wired them yet).

- [ ] **Step 3: Wire the props**

In `frontend/src/features/media/VideoReviewPlayer.tsx`, find the existing `<SequenceTimeline ... />` call:

```typescript
          <SequenceTimeline
            durationSeconds={video.duration_seconds}
            sequences={sequencesQuery.data ?? []}
            markStart={markStart}
            markEnd={markEnd}
            onOpenSequence={onOpenSequence}
            onRenameSequence={handleRenameSequence}
            onRecutSequence={handleRecutSequence}
          />
```

Replace it with:

```typescript
          <SequenceTimeline
            durationSeconds={video.duration_seconds}
            sequences={sequencesQuery.data ?? []}
            markStart={markStart}
            markEnd={markEnd}
            onOpenSequence={onOpenSequence}
            onRenameSequence={handleRenameSequence}
            onRecutSequence={handleRecutSequence}
            onMarkStartChange={setMarkStart}
            onMarkEndChange={setMarkEnd}
            onScrub={(seconds) => {
              if (videoRef.current) videoRef.current.currentTime = seconds;
            }}
          />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/media/VideoReviewPlayer.test.tsx`
Expected: PASS, all 9 tests green (8 existing + 1 new).

- [ ] **Step 5: Run the full frontend suite**

Run: `cd frontend && npx vitest run`
Expected: PASS, all tests green (174 existing + this plan's new tests: 10 from Task 1, 6 from Task 2, 1 from Task 3 = 191 total).

- [ ] **Step 6: Commit**

```bash
cd frontend
git add src/features/media/VideoReviewPlayer.tsx src/features/media/VideoReviewPlayer.test.tsx
git commit -m "feat: scrub the video player and update marks from timeline drag"
```

---

## Manual Verification (after all tasks complete)

This plan's tests cover the logic; CLAUDE.md's testing philosophy requires exercising real UI changes in an actual browser before trusting "tests pass" as proof the feature works, since drag/mouse interaction is exactly the kind of thing unit tests with `fireEvent` can miss (e.g. actual cursor CSS, actual pixel geometry on a real screen). After the final task's commit:

1. Start the stack per `CLAUDE.md`'s "Running the stack" section (backend, frontend, transcode worker if needed).
2. Open a video with at least one existing sequence in the browser.
3. Drag out a brand-new region from empty timeline background; confirm the yellow overlay appears immediately and the video scrubs live.
4. Drag one edge of an existing pending region close to (within a few pixels of) an adjacent sequence's boundary; confirm it snaps exactly to that boundary.
5. Try to drag the start handle past the end handle; confirm it stops at 1 second before the end mark instead of crossing it.
6. Click an existing sequence segment's Open/Rename/Re-cut button; confirm it still works and does not start a drag.
7. Confirm "Mark start"/"Mark end" buttons still work as before, independently of dragging.
