# Platform UI/UX design

Fills the gap left by [2026-07-22-new-platform-design.md](2026-07-22-new-platform-design.md)'s
`## Frontend` section, which only specified a directory layout, not what any
screen actually looks like or how a user moves through the platform. Written
because a concrete UI decision (choosing between the SAM-3 and SAM 2.1
segmentation adapters, see ROADMAP.md's upcoming phase) turned out to depend
on an annotation-workspace layout that had never been designed — so this
spec covers the whole platform's navigation and every top-level screen, not
just the one that triggered it.

The sibling `/mnt/work-disk/Documents/Dev/segmentation` Django project (see
CLAUDE.md) was read as a domain-knowledge reference during this design —
what workflows/screens a working platform for this domain has needed in
practice — but its concrete layouts were deliberately not copied wholesale;
several were reworked based on real usability feedback gathered during this
session (see "Deviations from the old platform" at the end of each section).

## Top-level navigation

Six sections, top nav bar:

```
Tags → Media → Sequences → Dataset → Train → QC
```

The `QC` screen (inference runs over a video with a prediction overlay) replaces
`Results` and is designed in [2026-10-06-qc-inference-runs-design.md](2026-10-06-qc-inference-runs-design.md).

The original draft of this spec put these in the old platform's order
(`Media → Sequences → Tags → ...`); `Tags` was moved to the front once the
Tags screen shipped, since taxonomy setup (procedures, categories, labels)
is a prerequisite for every other screen's dropdowns — annotators expect
to configure it first, not stumble on it mid-list.

Flat structure, no nested menus. Each section is its own top-level route.
Dark theme only (per CLAUDE.md).

There is deliberately **no separate "Annotation" section** — see Sequences
below for why.

## Media

**Responsibility:** raw file storage plus the "cut into frames" operation.
Media does not know about annotation status, labels, or masks — it only
turns raw uploads into a `Sequence`.

Two upload flows, side by side:

- **Video → Sequence:** upload a video file, then a form to extract frames
  from it: required auto-suggested `Name` field (see below), Start
  timestamp, Duration, FPS, Procedure select, and a collapsed 4-field crop
  box (left/right/top/bottom). Submitting creates a `Sequence` and navigates
  the user straight into it (Sequences screen, grid state).
- **Photos → Sequence:** drag & drop (or click-to-browse) zone for a batch
  of standalone images, thumbnail grid preview of the selected files,
  required auto-suggested `Name` field, Procedure select. Submitting creates
  a `Sequence` from the batch and navigates the same way.

Below both flows: a **raw media library** table (filename, type video/photo,
uploaded date, size, linked sequences, delete) — a plain file archive view,
not a workflow.

**Sequence naming:** `Name` is a required field on both creation forms,
pre-filled automatically from `Procedure + today's date + a per-day ordinal`
(e.g. `EGD 2026-07-23 #3`, where `#3` counts existing sequences with the
same name-base created today) — but it is a plain editable text field, not
a fixed format; a user can overwrite it with anything (e.g. a patient/case
identifier).

## Sequences (annotation is incorporated here, not a separate section)

**Key decision, made explicit because it reverses an earlier draft of this
spec:** a first pass proposed a separate "Annotation" nav section (a
cross-sequence work queue) distinct from "Sequences" (a data catalog). This
was rejected — segmenting one frame and running tracking projects masks
across the *entire* sequence, so "already annotated" and "not yet
annotated" are not stable, disjoint states owned by two different screens;
they're the same live data viewed at different times. Splitting them would
mean either duplicating the same grid in two places or constantly
re-classifying which section a sequence belongs to as tracking runs.
Instead, **Sequences is the single place both data management and the
annotation workflow live** — opening a sequence always shows its current
masks, however they got there (manual predict, tracked forward/backward, or
future auto-detection).

### Sequences list screen

Grid of sequence cards (2×2 mini-thumbnail preview showing frames with mask
overlays baked in, name, frame count, procedure, masked-frame progress bar
with percentage). Clicking a card navigates to that sequence's own screen
(not a modal from the list — the list itself stays a catalog).

### One sequence's screen: full-viewport frame grid

Not a small in-card preview — a dedicated screen per sequence, frame grid
scaled to fill the available viewport width (roughly 4-5 columns × 3-4 rows
before scrolling, responsive to window size). Each frame thumbnail shows:

- Its existing masks as **colored, semi-transparent fills matching the
  tag's color** (not just an outline) — the actual mask shape, not a
  placeholder box.
- A **compact label strip** along the bottom of the thumbnail: one colored
  dot + short tag name per mask (e.g. `● polyp`), multiple masks separated
  by a space, truncated with "…" if it doesn't fit, full list available via
  hover tooltip.

Clicking a frame thumbnail **replaces the grid in place** with the frame
editor (see below) — not a modal overlay, not a navigation to a separate
page/URL. A close action (`✕ Back to grid`) returns to the grid, replacing
the editor back in place. This was an explicit, deliberate choice over both
alternatives considered (a Bootstrap-style modal like the old platform's
`frame_modal.html`, and a fully separate routed page) — in-place replacement
keeps the "which sequence am I in" context always visible without either a
heavyweight modal chrome or a page navigation round-trip.

### Select mode — bulk frame cleanup

A **"Select" toggle button** in the grid's toolbar switches the grid into
multi-select mode: every thumbnail grows a checkbox, and clicking a
thumbnail now toggles its checkbox instead of opening the editor. Toggling
"Select" off exits the mode and hides the checkboxes again.

While active, an additional toolbar appears with:

- A **threshold input** (percentage) next to two buttons: **"Find
  similar"** (auto-checks frames that are near-duplicates of each other,
  above the given similarity threshold) and **"Rank quality"** (auto-checks
  the worst N% of frames by an image-quality heuristic). Both are
  *suggestions* — they only pre-check candidate frames (marked with a red
  outline and a small reason badge like `dup 96%` or `low quality`); the
  final decision to delete stays with the annotator, who can uncheck any
  suggestion first.
- **"Delete selected"** — bulk-deletes every currently checked frame.
- **"✕ Cancel"** — exits Select mode without deleting.

### Frame editor (replaces the grid in place)

Two-column layout: the frame image takes **all remaining horizontal space**
(not a fixed proportion against the tools panel — the image should be as
large as possible, since larger images make point/box clicking easier and
more precise); the tools panel is a **fixed narrow width** (~270px), not a
percentage of the layout, so it doesn't shrink the image as the window
grows.

**Prompt input is mouse-driven, no explicit Point/Box mode buttons**: left
click = positive point, left-click-drag = box, Ctrl+left-click = remove a
shape — the same convention the old platform's `frame_modal.html` used.
This is a deliberate omission of a Point/Box toggle: the old platform proved
these gestures are unambiguous on their own, adding mode buttons on top
would only duplicate a choice the mouse action already makes. A **"Mask"**
prompt-input option is the one addition beyond mouse gestures, and it does
need an explicit mode button — unlike point/box, "draw a rough mask" is not
a single unambiguous mouse gesture, so it's selected from a small
Point/Box/Mask row before drawing.

**Model tabs — SAM-3 / SAM 2.1, identical surrounding UI:** the two tabs
switch which segmentation adapter a "Run"/"Add mask" action targets, but do
**not** get different surrounding widgets, since both adapters expose the
same functional surface (point, box, and — see below — tracking) except
one real difference: **SAM 2.1 adds a Mask prompt-input option that SAM-3
does not have** (SAM-3 has no mask-prompt input at all). Everything else —
Category/Classification/Tag picker, color picker, the mask list, the track
controls — is one shared block of markup, not duplicated per tab. **SAM 2.1
is the default tab** when the editor opens (not SAM-3), reflecting that it
is expected to be the more reliable adapter for interactive point/box
segmentation on this hardware — see ROADMAP.md's Phase 2a deviation log for
why SAM-3's `predict()` was found unreliable in practice.

**Label picker — Category → Classification → Tag, three cascading
selects**, matching the hierarchy already used on the Tags screen (see
below): `Category` picks the root tag (e.g. `lesion`), `Classification`
filters by `label_type` (`geometric`/`morphological`/`quality`), `Tag`
picks the concrete leaf tag the mask is actually attached to (e.g. `0-Ip`).
Classification is a real filtering select in the middle of the chain, not a
decorative badge shown after the fact — narrowing it changes what's
selectable in the Tag select.

**Color picker**: a native color input plus a small row of preset swatches,
next to a compact "Add mask" button (not a large full-width call-to-action
— this is a frequent, low-ceremony action during an annotation session, not
a rare commit-style action).

**Track across sequence**: two labeled numeric inputs, **Backward** and
**Forward**, each defaulting to a small explicit number rather than being
left blank (blank does not mean "to the end of the sequence" — an unbounded
propagation request is exactly the kind of request that can exhaust GPU
VRAM, per this session's own motivating incident, see ROADMAP.md). Setting both to nonzero
values and pressing the single **"Track"** button propagates in both
directions in one job — this replaces an earlier draft's separate "Both"
button, which turned out to be redundant once both directions became
explicit numeric fields rather than open-ended toggles. `0` in either field
means "don't track that direction." The actual maximum is capped by both
the sequence's length and a server-side GPU memory budget (not shown as a
raw number in this mockup — the exact cap is an implementation decision for
the following plan, not a UI decision).

**Masks list**: below the track controls, a scrollable list of masks
already applied to the current frame — one row per mask, colored swatch +
`category / tag` label (e.g. `lesion / 0-Ip`). **Clicking a row in this
list highlights that mask on the image** (brighter outline) **and
auto-fills the Category/Classification/Tag/Color fields with that mask's
values** — so correcting an existing mask's label/color doesn't require
re-finding which mask is which by eye first.

### Deviations from the old platform (Sequences/frame editor)

- The old platform's real working editor was a full-screen Bootstrap
  modal (`frame_modal.html`) opened from a grid of frame cards
  (`edit_sequence.html`); a separate `edit_mask.html` page existed but was
  an unfinished placeholder, never the real editing surface. This spec
  keeps the "grid → editor" relationship but replaces the modal with an
  in-place content swap on the same screen (see above) — explicitly
  requested over both the old modal (called out as looking poor visually)
  and a separate routed page (rejected as adding unnecessary navigation
  overhead for a very frequent action).
- The old platform's SAM2 tab had a Category/Classification/Tag select
  trio, a 10-swatch color palette, separate Forward/Backward numeric
  fields with checkboxes, and a "Subtract from existing masks" toggle. This
  spec keeps the three-select label picker, the color picker, and the
  Forward/Backward numeric fields (unifying them into one "Track" action
  instead of the old "Add Masks" button conflating labeling and
  propagation). The "Subtract from existing masks" checkbox and the old
  YOLO tab's confidence/NMS/max-objects/image-size controls are **not**
  carried into this spec — YOLO-based segmentation is Phase 2b scope (per
  ROADMAP.md, "explicitly out of scope right now"), not part of this
  session's frame editor.
- Point/Box/Mask as mouse-gesture-first (no mode buttons for point/box) is
  a deliberate simplification versus even the old platform, which also
  didn't have Point/Box buttons — an earlier draft of *this* spec mistakenly
  added them and was corrected back to gesture-only during this session.

## Tags

Flat table rendering a two-level tree (`Label`/`LabelRelation`: a parent tag
like `lesion` or `landmark`, its children indented with a `↳` marker, like
`0-Ip`, `0-Is`, `scar`). `Classification` (the tag's `label_type`) is shown
as a small badge only on child/leaf tags — parent tags are pure grouping
nodes and don't carry a classification themselves. Each row also shows a
mask-count column (how many existing annotations use that tag) and
edit/delete actions.

Filters above the table: Classification (all/geometric/morphological/
quality), Procedure, and a text search. A "+ New tag" button opens a form:
Name, Parent tag (select), Classification (select), Color (native picker +
presets, the same color space used for mask overlays), optional
Description.

This picker pattern (Category/parent → Classification → Tag) intentionally
matches the one used in the frame editor's Label picker — the same mental
model in both places, not two different taxonomy UIs.

### Deviations from the old platform

The old platform's tag hierarchy allowed arbitrary depth in principle (a
recursive `tag_recursive.html` include); this spec fixes the depth at
exactly two levels (parent → child) for UI simplicity, matching what the
frame editor's three-select picker can express (Category = parent,
Classification = the child's own `label_type` attribute, Tag = the child
itself) — not a fourth freely-nested level.

## Dataset

Two-column form: left side picks **which sequences** go into the dataset
(checkbox list, filterable by procedure and a text search, running total of
selected sequences and masked-frame count) and the **dataset config**
(Name, Type e.g. `yolo_geometric`, Train/Val percentages with Test computed
automatically as the remainder). Right side shows a **live class-balance
analysis** (per-tag horizontal bar chart of mask counts, updating as
sequences are selected/deselected) with a warning callout for
underrepresented classes and an "Auto-apply balance recommendations"
checkbox.

Below the form, a table of already-created datasets (name, type, created
date, actions: view balance Metrics, Download, Delete).

This screen was approved at a rough/draft level ("правки по ходу" — the
user expects to revise details as implementation proceeds), not pixel-final
like the frame editor above.

## Train

Tabs by model family (YOLO now; RT-DETRv2 and others follow in Phase 2b,
per ROADMAP.md's explicit scope boundary — this screen's *structure* is
being fixed now, not its full set of model-specific config fields for
adapters that don't exist yet). Left side: a config form (Dataset select,
Base model, Epochs, Batch, and a collapsed "Advanced" section for
augmentation/optimizer/loss knobs) with a "Start training" action. Right
side: live run status (running/stopped/completed badge, progress bar,
current epoch, a scrolling monospace log stream) with a "Stop" action while
running.

Below: a table of already-trained model versions (version name, model
type, a headline metric like mAP50, actions: Info, Download, Delete).

Approved at the same rough/draft level as Dataset.

## Results

> **Superseded 2026-10-06:** this screen is replaced by `QC` (`/qc`), designed in
> [2026-10-06-qc-inference-runs-design.md](2026-10-06-qc-inference-runs-design.md).
> The text below is kept for history.

Left side: model select + drag-and-drop video upload + "Run inference".
Right side: live inference progress (status badge, progress bar, frame
counter) — explicitly a real progress indicator, not the old platform's
`view_video.html`, which had no progress/status feedback at all during a
run. Below: the rendered result (video or annotated frame preview with
detections/masks overlaid) and a history table of previous inference runs
(video name, model used, date, a "View" action to reopen that run's
result).

Approved at the same rough/draft level as Dataset and Train.

## What this spec does not cover

- Exact pixel values, spacing, and typography — the mockups used placeholder
  gray boxes and rough proportions; visual polish is a later, separate pass
  once each section is actually implemented.
- The GPU-memory cap enforced on the frame editor's Track Forward/Backward
  inputs (a real number, e.g. derived from sequence length and available
  VRAM) — an implementation detail for the following plan, not a UI
  decision.
- Any backend/API contract (endpoint shapes, Celery task names, adapter
  selection payload format) — this spec is UI/UX only; the adapter-choice
  API design (SAM-3 vs SAM 2.1 selection mechanism) is a separate decision
  to be brainstormed against this now-approved frame editor layout.
- Roles/permissions differences between sections (which user types see
  which sections) — out of scope per the original design spec's own
  "Явно вне рамок этого документа" section, unchanged by this one.
