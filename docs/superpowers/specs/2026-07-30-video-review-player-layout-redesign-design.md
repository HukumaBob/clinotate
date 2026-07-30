# Video review player layout redesign + crop-box UI in re-cut

## Context

Real usage of the merged video review player + Sequence-editing feature
(see [2026-07-29-media-video-review-player-design.md](2026-07-29-media-video-review-player-design.md),
[2026-07-30-sequence-edit-design.md](2026-07-30-sequence-edit-design.md))
surfaced three problems:

1. The page-level `<h1>Media</h1>` heading in `MediaPage.tsx` wastes
   vertical space the nav bar already covers (it highlights the active
   section).
2. The `<video>` element is `w-full` inside a height-bounded container.
   Endoscopy footage is commonly 4:3 or near-square, so on a typical wide
   viewport this produces large unused black bars on both sides — space
   that could hold the fps/crop/mark-info fields currently crammed below
   the video.
3. `RecutSequenceForm` (the destructive re-cut form) has no crop-box UI
   at all, even though the backend already persists `crop_box` on
   `Sequence` and `recut_sequence` already reuses whatever crop was
   stored at creation time (a fix from the 2026-07-30 whole-branch
   review). The user can see a sequence keeps its crop through a re-cut,
   but cannot see or change what that crop actually is from the re-cut
   screen — and the *creation* flow's crop UI (`SequenceFromMarksForm`)
   is a collapsed four-number section with no visual feedback and no
   memory between sequences of the same video.

## Scope

In scope: `MediaPage.tsx`'s page heading removal; `VideoReviewPlayer.tsx`'s
layout (video width, side panel); a new reusable `CropOverlay` component;
crop fields added to `RecutSequenceForm.tsx`; crop-inheritance-from-prior-
sequence behavior for `SequenceFromMarksForm.tsx`; the backend `PATCH`
endpoint gaining a `crop` field. Out of scope: drag-to-resize the crop
rectangle directly on the video (numeric inputs only, per this session's
decision); any change to the Photos → Sequence upload flow; any change to
codec/transcode behavior.

## Layout

`MediaPage.tsx` drops its `<h1>Media</h1>` entirely — the top nav bar
already highlights the active section (established pattern per
[2026-07-23-platform-ui-ux-design.md](../../specs/2026-07-23-platform-ui-ux-design.md),
which specifies a flat nav with no separate section headers).

`VideoReviewPlayer.tsx`'s main content becomes a `flex` row instead of a
single-column stack:

- Left: the `<video>` element, `flex-[3]` (~60% of the row), keeping its
  existing `max-h-[40vh]` cap so it never grows unreasonably tall on a
  narrow viewport — width now follows the flex share instead of `w-full`.
- Right: a new side panel, `flex-[2]` (~40%), `flex flex-col gap-4`,
  matching the existing dark-form styling (`rounded border
  border-gray-800 bg-gray-900 p-4`) already used by sibling components
  in this codebase.

`SequenceTimeline` stays full-width, below this row — unchanged.

The side panel is contextual, not a fixed set of fields always shown: it
renders whichever operation is currently active (marking a new range for
`SequenceFromMarksForm`, `RenameSequenceForm`, or `RecutSequenceForm`),
matching `VideoReviewPlayer`'s existing state machine
(`renamingSequenceId`/`recuttingSequenceId`/`markStart`/`markEnd`) — no
new state shape, just where the resulting JSX renders. The "Mark
start"/"Mark end" buttons (currently rendered by `SequenceTimeline`
alongside the colored-segment bar) move into this side panel too, since
they're part of the same "what am I currently doing" context as the
range/fps/crop fields, not part of the timeline's read-only overview
role. `SequenceTimeline` keeps `onMarkStart`/`onMarkEnd`/`markStart`/
`markEnd` props removed from its own rendering — those become
`VideoReviewPlayer`-level buttons instead, so `SequenceTimeline` becomes
purely the colored-segment overview + per-segment Open/Rename/Re-cut
actions.

## `CropOverlay` component (new)

`frontend/src/features/media/CropOverlay.tsx`. Purely presentational —
takes the current crop percentages and renders a positioned overlay.

```typescript
export function CropOverlay({
  crop,
}: {
  crop: { left: number; right: number; top: number; bottom: number };
}) {
  // renders 4 semi-transparent black bars (top/bottom/left/right insets)
  // plus a thin high-contrast border (border-2 border-yellow-400) around
  // the remaining visible rectangle, absolutely positioned to fill its
  // parent -- the parent is responsible for being position:relative and
  // sized to match the <video> element exactly (a wrapping div around
  // <video>, not <video> itself, since <video> can't host absolutely
  // positioned children reliably across browsers).
}
```

Rendered wherever crop is being edited (inside `SequenceFromMarksForm`
when its crop section is open, and inside `RecutSequenceForm`) by
wrapping the video in a `relative`-positioned container and layering
`CropOverlay` on top, both editing forms passing their own local crop
state down. No coordinate math beyond percentage-based CSS `inset`/
`clip-path` — the crop values are already left/right/top/bottom
percentages, matching CSS box-model insets directly.

## Crop inheritance

**On the re-cut form (`RecutSequenceForm`):** pre-fills its crop fields
from `sequence.crop_box` (already fetched via `SequenceRead`, already
present on the `sequence` prop this component receives) — the user sees
and can edit what's already stored, not a blank slate.

**On the create-new-sequence form (`SequenceFromMarksForm`):** on mount,
finds the video's most-recently-created `Sequence` (max `id`/
`created_at` among `sequencesQuery.data`, already loaded by the parent
`VideoReviewPlayer` — no new endpoint) and pre-fills crop from that
sequence's `crop_box` if one exists. If the video has no sequences yet,
crop defaults to all-zero as today. Switching to a *different* video (no
prior sequences at all) does not carry over a crop from elsewhere —
per-video crop only, since different endoscopes/footage geometries need
different crops; a cross-video "last used" suggestion was explicitly
deprioritized as secondary/future, not built now.

## Backend

`SequenceUpdate` (`backend/app/media/schemas.py`) gains:
```python
crop: CropBox | None = None
```
Reuses the existing `CropBox` model (already validates `left+right < 100`,
`top+bottom < 100`) — no new validation logic needed.

`update_sequence`'s re-cut branch (`backend/app/media/router.py`) passes
`payload.crop` through to `recut_sequence`, which currently always reuses
`sequence.crop_box` regardless of the request — this changes to: if
`payload.crop` is provided, use it (and persist it as the sequence's new
`crop_box`); if omitted, fall back to the existing `sequence.crop_box`
(preserves today's re-cut-without-touching-crop behavior for any caller
that doesn't send `crop`, including tests written before this change).

`openapi.json` regenerated after the schema change, as required by
CLAUDE.md's API-contract constraint.

## Validation and error handling

- Crop bounds validation is entirely the existing `CropBox` pydantic
  model — no new rules. A `422` from an invalid crop during re-cut
  surfaces through `RecutSequenceForm`'s existing `updateSequence.isError`
  handling (added in the prior whole-branch-review fix wave), no new
  error-handling code needed there.
- `CropOverlay` never blocks its own rendering on "invalid" values (e.g.
  `left: 60, right: 60` visually overlapping) — it's a live preview, not
  a validator; the backend's `CropBox` model remains the single source of
  truth for what's actually accepted on submit.

## Testing

- Frontend: `CropOverlay.test.tsx` — renders the expected inset styles
  for a given crop object.
- Frontend: `RecutSequenceForm.test.tsx` extended — crop fields
  pre-filled from `sequence.crop_box`, submitted crop included in the
  `PATCH` body.
- Frontend: `SequenceFromMarksForm.test.tsx` extended — crop pre-filled
  from the most recent existing sequence's `crop_box` when one exists;
  stays zeroed when the video has no sequences yet.
- Backend: `test_media.py` — `PATCH .../sequences/{id}` with a `crop`
  field persists it to `crop_box` and a subsequent re-cut without a
  `crop` field keeps the previously-set one (regression coverage for the
  fallback behavior).
- Manual real-browser verification (per this repo's CLAUDE.md testing
  philosophy) of the new layout at a few viewport widths, and of the
  crop overlay visually tracking the four percentage inputs.
