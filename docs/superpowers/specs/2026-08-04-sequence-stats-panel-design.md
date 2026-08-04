# Sequence Statistics Panel Design

## Problem

`SequenceForm.tsx`'s edit mode recently freed up horizontal space when FPS
moved next to the crop fields and Procedure moved under Name (see
`docs/specs/2026-08-01-frontend-design-system.md`'s retrofit and the
follow-up compactness pass). That space is currently empty. The user wants
it filled with read-only statistics about the sequence being edited: frame
count, frame resolution, and a compact scrollable table of which labels
have been annotated and how many times.

## Scope

This only applies to `SequenceForm`'s edit mode (a `sequence` prop is
present, i.e. real frames/annotations exist to summarize). Create mode has
no sequence yet — nothing to show stats for, no stats panel renders there.

## Backend: `GET /media/sequences/{sequence_id}/stats`

New endpoint in `backend/app/media/router.py`, following the same query
pattern already used by `_sequence_read`'s `annotation_count` (a single
aggregation query per field, no N+1).

**Response schema** (`backend/app/media/schemas.py`):

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

**Behavior:**
- `frame_count`: `COUNT(*)` over `Frame` filtered by `sequence_id`.
- `frame_width`/`frame_height`: taken from the frame with the lowest
  `frame_index` in the sequence (frames within one sequence come from a
  single crop/extract pass and are uniform in practice; picking "the first
  frame" is the simplest correct choice, not an average or a set).
  `None`/`None` when the sequence has zero frames.
- `labels`: `Annotation` joined to `Frame` (filtered by `sequence_id`)
  joined to `Label`, `GROUP BY Label.name`, `COUNT(*)` per group, ordered
  by count descending. Includes every `annotation_type`
  (classification/mask/bbox) keyed by label name — not filtered to
  `AnnotationType.MASK` specifically, despite the "masks" wording in the
  original request, per explicit confirmation during design review.
- 404 if the sequence doesn't exist (matching `get_sequence`'s existing
  pattern).

## Frontend

**`frontend/src/entities/useSequenceStats.ts`** (new): a React Query hook,
`useSequenceStats(sequenceId: number)`, following the existing
`useSuggestSequenceName`-style pattern (simple `GET`, `enabled` gating not
needed here since it's only ever called with a real id from edit mode).

**`frontend/src/features/media/SequenceStatsPanel.tsx`** (new): renders the
fetched stats. Structure:
- A `caption`-role line: `"{frame_count} frames · {frame_width}×{frame_height}"`
  (omit the resolution part entirely if `frame_width`/`frame_height` are
  `null` — a zero-frame sequence just reads `"0 frames"`).
- A `section-heading`-role label "Labels" above a compact table: one row
  per `{label_name, count}`, `py-1 px-2` (tighter than the standard
  `py-1.5 px-3` table-row token, since this is a small secondary widget,
  not a primary data table), wrapped in `max-h-32 overflow-y-auto` so a
  sequence with many distinct labels scrolls instead of growing the panel.
- While loading: no skeleton needed given the endpoint's simplicity — the
  panel can render nothing until data arrives (matches how other
  lightweight queries in this codebase are handled, e.g.
  `useSuggestSequenceName`'s consumers).
- Empty state: if `labels` is empty, show a `caption`-role
  "No annotations yet" instead of an empty table.

**`SequenceForm.tsx` wiring:** in the `isEdit` branch only, wrap the
existing form content and a new `<SequenceStatsPanel sequenceId={sequence!.id} />`
in a `flex` row — the form keeps its current fields as the primary
(`flex-1`) column, the stats panel is a narrow fixed-width column
(`w-48`) to its right. No change to create mode's JSX.

## Testing

- Backend: TDD per `CLAUDE.md` — a failing test for the new endpoint
  covering: correct `frame_count`, correct `frame_width`/`frame_height`
  from the lowest-`frame_index` frame, correct `labels` grouping/count
  across mixed `annotation_type`s, empty-sequence case (`frame_count=0`,
  `frame_width`/`height=None`, `labels=[]`), 404 for a missing sequence.
- Frontend: `useSequenceStats.test.ts` (hook fetches and returns data) and
  `SequenceStatsPanel.test.tsx` (renders frame count/resolution line,
  renders the labels table sorted as returned, renders the empty state,
  renders the no-resolution case when width/height are null). Also add a
  minimal `SequenceForm.test.tsx` assertion that the stats panel renders
  in edit mode and does not render in create mode.

## Out of scope

- No caching/invalidation wiring beyond React Query's defaults — stats are
  read-only display data, not expected to change while the form is open
  except via a re-cut (which already fully re-renders the form via
  `onDone` → parent refetch, at which point a fresh `SequenceForm` mount
  naturally re-fetches stats too).
- No stats for photo-only (video-less) sequences beyond what already works
  generically — `Frame`/`Annotation` aggregation is video-agnostic since
  it queries by `sequence_id`, so standalone photo sequences get correct
  stats for free without special-casing.
