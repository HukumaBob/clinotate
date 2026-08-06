# Sequence grid thumbnail labels and mask overlay

## Problem

On `/sequences/:id` (`SequenceGridPage`), each frame thumbnail
(`FrameThumbnail`) shows its annotations as bare `● label <id>` text — see
`FrameThumbnail.tsx:23`. This is unreadable (numeric id only, no name) and
carries no color. The thumbnail also shows no visual indication of *where*
on the frame a mask annotation sits — only a clean image plus the text
caption below it. The full frame editor (`FrameCanvas.tsx`) already solves
both problems (label name/color resolution via taxonomy tree, and mask
rendering via canvas decode), but the grid page doesn't reuse either path.

## Goals

1. Replace `label ${id}` text with the label's real name and color marker,
   using the same taxonomy resolution already used in `MasksList.tsx`.
2. Render each mask annotation's `mask_url` as a colored, semi-transparent
   overlay on the thumbnail image itself, not just in the text caption.

## Non-goals

- BBOX annotation overlays (no `mask_url` to render; out of scope per
  CLAUDE.md — BBOX has no rendering logic anywhere yet).
- Canvas-based mask decoding/silhouette tracing on the grid (that stays a
  full-editor-only technique; see Approach below).

## Data flow

`SequenceGridPage` currently only knows `sequenceId` from the route and
never fetches the sequence itself. To resolve label names/colors we need
the sequence's `procedure_id` (`SequenceRead.procedure_id`, already present
in the schema) to query the taxonomy tree.

- `SequenceGridPage` calls `useSequence(sequenceIdNumber)` (existing hook,
  currently unused by this page) to get `procedure_id`.
- `SequenceGridPage` calls `useTaxonomyTree(sequenceQuery.data?.procedure_id ?? null)`
  **once** for the whole grid (existing hook, same one `FrameEditor` uses).
- The resolved tree (`treeQuery.data ?? []`) is passed down as a `taxonomyTree`
  prop to every `FrameThumbnail`. No per-thumbnail taxonomy fetch — React
  Query would dedupe identical calls anyway, but a single shared fetch is
  more direct than 20+ components independently invoking the same hook.
- State approach: plain React Query + props, matching the existing
  `FrameEditor` → `MasksList`/`FrameCanvas` pattern. Zustand
  (`frameEditorStore`) stays scoped to single-frame-editor UI state
  (selection, hover, tool); the grid has no cross-thumbnail UI state to
  share, so it doesn't need a store.

## Label resolution — shared helper

`MasksList.tsx` already has a local `resolveLabel(labelId)` closure that
walks the taxonomy tree (`category → evaluation_type → labels`) to find
`{categoryId, categoryName, tag, classification}`. This logic is extracted
into a standalone pure function:

```ts
// frontend/src/features/annotation/resolveLabel.ts
export function resolveLabelFromTree(tree: TaxonomyTree, labelId: number): ResolvedLabel | null
```

`MasksList` and `FrameThumbnail` both import and use it. `MasksList`'s
existing behavior is unchanged (same fallback to `label ${id}` if not
found — including for BBOX/no-tree-match cases).

## Thumbnail text caption

`FrameThumbnail` replaces the flat `annotations.map` loop:

```
● label 42
```

with, per annotation:

```
<span dot colored by resolved.tag.color /> {categoryName} / {tagName}
```

falling back to `label ${id}` with a neutral dot color when the label
isn't found in the tree (matching `MasksList`'s existing fallback
behavior). This applies to all annotation types, not just masks — a BBOX
annotation still gets a text row, just no image overlay.

## Mask overlay — CSS mask-image

Mask PNGs are stored as opaque grayscale (luminance = coverage, alpha
channel of the PNG itself is 255 everywhere — see the comment above
`luminanceToAlphaMask` in `FrameCanvas.tsx`). CSS's `mask-image` /
`-webkit-mask-image` with `mask-mode: luminance` interprets exactly that:
luminance becomes the effective alpha of the masked element, no JS
decoding needed.

For each mask annotation with a non-null `mask_url`, render a `div`
absolutely positioned over the thumbnail image:

```css
position: absolute; inset: 0;
background-color: <resolved label color, or DEFAULT_MASK_COLOR fallback>;
-webkit-mask-image: url(mask_url);
mask-image: url(mask_url);
-webkit-mask-mode: luminance;
mask-mode: luminance;
-webkit-mask-size: contain; mask-size: contain;
-webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
-webkit-mask-position: center; mask-position: center;
opacity: 0.45; (roughly matching FrameCanvas's MASK_FILL_ALPHA)
pointer-events: none;
```

This is a flat, unoutlined tinted fill — no silhouette tracing, no
highlight/draft states, no canvas element, no per-thumbnail image decode
or `ImageData` cache. It intentionally does not reuse `paintMaskOverlay`
from `FrameCanvas.tsx`; that function requires a decoded `ImageData` and a
tint canvas, which is unnecessary weight for a small, non-interactive grid
thumbnail.

**Multiple masks on one frame:** stack one such div per mask annotation
(same z-index, all semi-transparent) so every mask is visible at once,
consistent with the text caption which already lists every annotation.

**Sizing caveat:** the thumbnail image uses `object-contain` inside an
`aspect-square` box, so the mask div's `mask-size: contain` must match the
image's own contain-fit box, not the full square container — otherwise the
mask will misalign with the underlying frame on non-square source images.
Both the `<img>` and the mask `<div>` are absolutely stacked within the
same aspect-square parent so they share the same contain-fit geometry.

## Testing (TDD)

- `resolveLabelFromTree`: unit tests — found in tree, not found (returns
  null), label present under different categories/evaluation types.
- `FrameThumbnail`: component tests — renders resolved name+color instead
  of `label {id}` when taxonomy tree has a match; falls back to
  `label {id}` when it doesn't; renders one mask-overlay div per mask
  annotation with `mask_url` set, using the resolved color; renders no
  overlay div for BBOX/no-`mask_url` annotations.
- `SequenceGridPage`: verify it calls `useTaxonomyTree` with the
  `procedure_id` from `useSequence`, and passes the resulting tree down to
  `FrameThumbnail`.

## Files touched

- `frontend/src/features/annotation/resolveLabel.ts` (new)
- `frontend/src/features/annotation/MasksList.tsx` (use shared helper,
  remove local `resolveLabel`)
- `frontend/src/features/annotation/FrameThumbnail.tsx` (label resolution,
  mask overlay)
- `frontend/src/features/annotation/SequenceGridPage.tsx` (fetch sequence
  + taxonomy tree, pass down)
- corresponding `*.test.tsx` / `*.test.ts` files
