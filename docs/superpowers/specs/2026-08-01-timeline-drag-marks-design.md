# Timeline Drag-to-Adjust Marks Design

## Problem

`VideoReviewPlayer.tsx` currently only lets a user set `markStart`/`markEnd`
via two buttons ("Mark start" / "Mark end") that capture the video player's
current playback time. Positioning a mark precisely means scrubbing the
video, pausing, clicking the button, then repeating for the other edge --
slow and imprecise, with no way to nudge just one edge without redoing both.
`SequenceTimeline.tsx` already renders a yellow dashed overlay for the
pending mark region (`markStart`/`markEnd`) alongside the existing colored
sequence segments, but that overlay is purely visual -- it isn't
interactive.

## Goal

Let the user drag the edges of the pending mark region directly on the
timeline, with edges snapping to the boundaries of adjacent sequence
segments, while keeping the existing "Mark start"/"Mark end" buttons as an
alternative, equally valid way to set marks.

## Behavior

- **Empty timeline (no pending marks):** mousedown+drag on empty timeline
  background starts a new region. The mousedown point becomes one edge: the
  edge closer to the drag's current position updates live as the mouse
  moves; the other edge is fixed at the mousedown point.
- **Existing pending region:** each edge of the yellow overlay has a
  ~6px-wide grab handle (`cursor: ew-resize`). Dragging a handle moves only
  that edge; the other edge stays fixed. A handle cannot cross past the
  opposite edge (minimum region width is enforced at 1 second).
- **Snapping:** while dragging, if the cursor comes within 8 screen pixels
  of an adjacent sequence's boundary (`start_time` or
  `start_time + duration`), the edge snaps to that exact second instead of
  the raw cursor position. This is a screen-pixel threshold, not a
  time-based one, so it stays usable regardless of video length.
- **Player sync:** every `mousemove` during an active drag sets
  `video.currentTime` to the timestamp under the cursor, so the user sees
  the exact frame they're marking (matches conventional video editor
  behavior).
- **Mark buttons unchanged:** "Mark start"/"Mark end" continue to set
  `markStart`/`markEnd` from the player's current time, independent of
  drag. Both mechanisms write to the same state.
- **Whole-region move:** out of scope for this iteration -- only individual
  edges are draggable, not the whole region as a unit.
- **Existing segment clicks unaffected:** mousedown starting on a colored
  sequence segment (or its Open/Rename/Re-cut buttons) does not start a
  drag; drag only initiates from the pending region's handles or from empty
  timeline background.

## Architecture

**Pure geometry function** (new file, `computeTimelineDrag.ts`):

```ts
export function pixelToSeconds(
  clientX: number,
  timelineRect: { left: number; width: number },
  durationSeconds: number
): number

export function findSnapSeconds(
  rawSeconds: number,
  clientX: number,
  timelineRect: { left: number; width: number },
  durationSeconds: number,
  snapCandidates: number[],
  snapPixels: number
): number
```

`pixelToSeconds` converts a mouse `clientX` to a clamped `[0, durationSeconds]`
time. `findSnapSeconds` checks each candidate second (converted back to a
pixel position) against `clientX`; if any candidate is within `snapPixels`,
returns that candidate's exact second, otherwise returns `rawSeconds`
unchanged. Both are plain functions with no DOM dependency -- fully unit
testable without simulating mouse events.

**`SequenceTimeline.tsx` changes:**

- Accepts new props: `onMarkStartChange: (seconds: number) => void`,
  `onMarkEndChange: (seconds: number) => void`, `onScrub: (seconds: number) => void`
  (fired on every drag mousemove, used by the parent to set
  `video.currentTime`).
- Snap candidates are derived from `sequences` (each segment's start and
  end) plus, while dragging one pending edge, the other pending edge's
  current value.
- Drag state (`{ edge: "start" | "end" | "new"; }` or `null`) is local
  `useState`; `mousemove`/`mouseup` listeners are attached to `window` for
  the duration of a drag (attached in a `useEffect` keyed on whether a drag
  is active, removed on mouseup) so the drag continues even if the cursor
  leaves the timeline's bounding box.
- The pending overlay gets two 6px absolutely-positioned handle `<div>`s
  (`data-testid="mark-handle-start"` / `"mark-handle-end"`) layered over its
  left/right edges, each with `onMouseDown` starting that edge's drag.
- Empty-background `onMouseDown` (on the timeline's root div, checked via
  `event.target === event.currentTarget` so segment/handle clicks don't
  bubble into it) starts a `"new"` drag.

**`VideoReviewPlayer.tsx` changes:**

- Passes `onMarkStartChange={setMarkStart}`, `onMarkEndChange={setMarkEnd}`,
  and `onScrub={(seconds) => { if (videoRef.current) videoRef.current.currentTime = seconds; }}`
  to `SequenceTimeline`.
- No other state changes -- `markStart`/`markEnd` already flow through the
  existing localStorage persistence effect, so drag-set marks persist the
  same way button-set marks do.

## Testing

- `computeTimelineDrag.test.ts`: pure function tests for `pixelToSeconds`
  (clamping, proportional mapping) and `findSnapSeconds` (snaps within
  threshold, passes through outside threshold, picks nearest candidate when
  multiple are in range).
- `SequenceTimeline.test.tsx`: new cases using `fireEvent.mouseDown` /
  `fireEvent.mouseMove` / `fireEvent.mouseUp` on `window` --
  drag-creates-a-region-from-empty-background, drag-moves-only-the-grabbed-edge,
  drag-snaps-to-an-adjacent-segment-boundary, drag-cannot-cross-the-opposite-edge,
  drag-calls-onScrub-with-the-live-cursor-position, clicking-a-segment-button-does-not-start-a-drag.

## Out of scope

- Dragging the whole pending region as a unit (moving both edges together).
- Touch/pointer-event support beyond mouse (existing codebase has no touch
  requirements elsewhere).
- Keyboard-accessible dragging (arrow-key nudging) -- not requested; the
  Mark start/end buttons remain the keyboard-friendly path.
