# Frontend design system

Fills a gap the platform UI/UX spec never addressed: that spec
([2026-07-23-platform-ui-ux-design.md](2026-07-23-platform-ui-ux-design.md))
covers screen architecture and navigation, and explicitly says it does
*not* cover "exact pixel values, spacing, and typography." This document
is that pass — a small, fixed set of Tailwind tokens and constraints that
every screen (built or not-yet-built) draws from, so visual decisions stop
being made ad hoc per component.

Scope: pure documentation. No `tailwind.config.ts` changes, no new
components — this is a reference for writing Tailwind classes consistently,
not a new abstraction layer. `Media` is the first screen to be brought in
line with it (see "Retrofit scope" below) since it's the newest, most
representative real screen — proving the system reads correctly against
real code before new screens (`Tags`, `Dataset`, `Train`, `Results`) are
built against it from the start. `Sequences`/frame editor is not part of
this retrofit — its layout is pixel-approved in the UI/UX spec and it's a
denser, more custom surface (canvas, tool panel); revisit separately if
needed.

## Constraints

This is medical software: a clinician annotates for 8-hour shifts. That
drives every choice below.

- **Density over aesthetics.** Prefer more information visible at once
  (tighter rows, smaller chrome) over generous whitespace. This is not
  "cram everything in" — it means defaulting to the tighter end of
  Tailwind's spacing scale for repeated/structural elements (table rows,
  form fields), while keeping body text at a readable size (see
  Typography).
- **WCAG AA is mandatory for all UI chrome** — text/background contrast,
  focus states, icons, form borders. No exceptions for chrome.
  - **Explicit exception: mask/tag color overlays on video frames.**
    `Label.color` is arbitrary user-chosen data rendered on top of a real
    endoscopic frame — contrast against an unknown, uncontrolled video
    background cannot be guaranteed by any UI rule. Mitigation instead of
    contrast guarantee: mask labels always render on a dark, semi-opaque
    backing (`bg-black/70` or similar) behind the text/dot, never as bare
    colored text directly on the frame. This exception covers only
    label-color rendering on frame/video surfaces, nothing else.
- **Functional micro-animation is fine; decorative animation is not.**
  Allowed: hover/focus color transitions, loading spinners, the grid↔frame-
  editor in-place swap. Not allowed: fade-ins on page load, parallax,
  bounce/elastic easing, auto-advancing carousels, or any animation whose
  only job is to look nice rather than communicate state or feedback.
- **Dark theme only.** Every token below is chosen and contrast-checked
  against the dark palette only, per `CLAUDE.md`'s `darkMode: "class"`
  decision — light mode is out of scope, not a variant to keep in mind
  while picking colors here.

## Color semantics

Stock Tailwind palette, no custom hues — the gap isn't the palette, it's
that today's code mixes shades of the same color arbitrarily (`red-500`,
`red-600`, `red-700` used interchangeably with no rule). Each role below
is pinned to specific shades; don't substitute a neighboring shade "because
it looked fine."

| Role | Shades | Used for |
|---|---|---|
| `neutral` (gray) | 950 / 900 / 800 / 700 / 500 / 400 / 300 / 100 | Backgrounds, surfaces, borders, chrome text — the entire structural palette |
| `accent` (blue) | 600 / 500 / 400 | Active nav item, primary buttons, focus rings, links |
| `danger` (red) | 900 / 700 / 600 / 400 | Errors, destructive actions, critical badges |
| `warning` (amber) | 600 / 400 | Warnings (near-duplicate frame, low-quality suggestion) |
| `success` (emerald) | 600 / 400 | Completed/healthy statuses (job succeeded, active item) |

Fixed shade-to-purpose pairings (don't mix within a role):
- Danger text on dark background: `text-red-400`. Danger fill: `bg-red-700`,
  hover `bg-red-600`. Danger border: `border-red-900`.
- Accent fill: `bg-blue-600`, hover `bg-blue-500`. Accent text/link:
  `text-blue-400`, hover `text-blue-300`.
- Warning text/badge: `text-amber-400` / `bg-amber-600`.
- Success text/badge: `text-emerald-400` / `bg-emerald-600`.

**Tag/mask colors (`Label.color`) are data, not a UI token** — user-chosen
hex values, unrelated to the semantic roles above. See the mandatory
rendering rule under Constraints (dark backing behind label text/dot on
video surfaces). Never fold a label color into the neutral/accent/danger
system or vice versa.

## Typography

Four roles — a fixed hierarchy, replacing today's undifferentiated
`text-xs`/`text-sm` usage:

| Role | Classes | Used for |
|---|---|---|
| `page-title` | `text-lg font-semibold text-gray-100` | One per screen — "Media", "Sequences", "Tags", etc. |
| `section-heading` | `text-sm font-semibold text-gray-200` | Panel headers, form section labels, table headers |
| `body` | `text-sm text-gray-100` (secondary: `text-gray-300`) | Main content, table data, form labels — do not shrink this for density; density comes from spacing, not font size |
| `caption` | `text-xs text-gray-400` | Secondary metadata (dates, file sizes), badges, hints |

## Density / spacing tokens

| Element | Token |
|---|---|
| Table row (`td`/`th` padding) | `py-1.5 px-3` |
| Form field (input/select) | `py-1.5 px-2` |
| Standard button | `py-1.5 px-3` |
| Compact button (frequent action, e.g. "Add mask") | `py-1 px-2` |
| Primary CTA (form submit) | `py-2 px-4` |
| Vertical gap between form fields | `gap-3` |
| Gap between form field groups | `gap-4` |
| Gap between rows in a tools panel | `gap-2` |

## Component patterns

- **Table with row actions:**
  ```html
  <table class="w-full text-sm">
    <thead class="bg-gray-900 text-xs uppercase text-gray-400">
      <tr><th class="py-1.5 px-3 text-left">...</th></tr>
    </thead>
    <tbody>
      <tr class="border-b border-gray-800 hover:bg-gray-900/50">
        <td class="py-1.5 px-3">...</td>
        <td class="py-1.5 px-3 text-right">
          <button class="text-blue-400 hover:text-blue-300">Edit</button>
          <button class="text-red-400 hover:text-red-300">Delete</button>
        </td>
      </tr>
    </tbody>
  </table>
  ```
  Delete uses a two-step inline confirm (button turns into "Confirm?" +
  cancel), never `window.confirm()` — matches the fix already made in
  `MediaLibraryTable.tsx`.

- **Label + input pair:**
  ```html
  <label class="mb-1 block text-sm text-gray-300">Name</label>
  <input class="w-full rounded border border-gray-700 bg-gray-900 py-1.5 px-2
                text-sm text-gray-100 focus:border-blue-500 focus:outline-none" />
  ```

- **Cascading select** (Category → Classification → Tag): selects laid out
  in sequence, each disabled until its predecessor has a value — the
  pattern already implemented in `CascadingLabelPicker.tsx`; treat that as
  the canonical reference, not a new pattern to design.

- **Buttons — exactly three variants:**
  - `primary`: `bg-blue-600 hover:bg-blue-500 text-white`
  - `secondary`: `border border-gray-700 text-gray-100 hover:bg-gray-800`
  - `danger`: `bg-red-700 hover:bg-red-600 text-white`

- **Status badge/pill:** `rounded-full px-2 py-0.5 text-xs`, colored by
  semantic role (success/warning/danger/neutral) from the table above.

## Retrofit scope: Media

`Media` (`MediaPage.tsx`, `MediaLibraryTable.tsx`, `VideoUploadFlow.tsx`,
`PhotosUploadFlow.tsx`, `ExtractSequenceForm.tsx`, `RecutSequenceForm.tsx`,
`RenameSequenceForm.tsx`, `CropFields.tsx`, `SequenceTimeline.tsx`) gets
brought in line with the tokens above as a styling-only pass:

- Swap ad hoc `text-xs`/`text-sm`/`text-lg` usage for the four typography
  roles (`page-title` once per screen, `section-heading` for form/panel
  headers, `body` for table data and labels, `caption` for secondary
  metadata).
- Normalize the mixed `red-500`/`red-600`/`red-700` and `py-2`/`py-1.5`/
  `py-1`/`py-0.5` usage found across these files to the fixed shade
  pairings and density tokens above.
- Reshape `MediaLibraryTable`'s row/action markup to the canonical table
  pattern (including its existing two-step inline delete-confirm, which
  is already correct and should not change).
- Reshape button usage across the upload/extract/recut/rename forms into
  the three fixed variants (primary/secondary/danger) — no new variants.

No behavior, layout structure, or component boundaries change — this is a
class-level pass, not a rewrite. Verify with the same real-browser check
this codebase already requires for frontend work (see `CLAUDE.md`'s
testing philosophy): log in, walk through upload → extract → library table,
confirm nothing visually broke and delete-confirm still works.

## What this document does not cover

- No `tailwind.config.ts` changes — these are documented class
  combinations to copy, not named config tokens. A future pass could
  promote stable patterns into config or shared components once several
  screens have used them; not decided here.
- No retrofit of `Sequences`/frame editor — see above.
- No light theme variant — out of scope per `CLAUDE.md`.
- No new shared React component library (`Button`, `Table`, etc.) — this
  is a class-level styling reference; componentizing these patterns is a
  separate, later decision.
