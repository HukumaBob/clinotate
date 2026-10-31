# Tag regions: copy region annotations to another label in bulk

Date: 2026-10-31
Status: approved, implemented (browser check pending)

Extends the sequence grid's Select mode described in
[2026-08-06-sequence-grid-frame-delete-toolbar-design.md](2026-08-06-sequence-grid-frame-delete-toolbar-design.md)
and [2026-08-13-sequence-grid-frame-classification-design.md](2026-08-13-sequence-grid-frame-classification-design.md).
The Select-mode section of the UI/UX spec
([docs/specs/2026-07-23-platform-ui-ux-design.md](../../specs/2026-07-23-platform-ui-ux-design.md))
is extended, not replaced.

Decisions marked **(my call)** were made by the author, not the user.

## Why

The taxonomy has two region-scoped evaluation types: `geometric` (coarse
shape: polyp, ulcer, an area of mucosa) and `morphological` (fine structure:
hyperplastic, adenoma, SSL, ...). An annotation carries exactly **one** label
(`Annotation.label_id`; the dataset export, the balance panel, the grouping
rules and the `taxonomy_version` rule all rest on that), so a region that is
both "polyp" and "adenoma" has to be two annotations with the same geometry.

Until now that meant drawing the mask twice: once for geometry, once again for
the morphological tag. Histology also arrives later than the geometry, and it
belongs to the whole lesion, which spans many frames. The second drawing is
pure repeated work and is the thing this feature removes.

The morphological annotations are the training data for the DINOv3 crop
classifier (see
[2026-10-28-dinov3-histology-classifier-design.md](2026-10-28-dinov3-histology-classifier-design.md)).

## What the user decided

- Do it in the **sequence grid**, in Select mode, over the ticked frames.
- It must work for **any** region label as the source (polyp, ulcer, an area
  of mucosa, ...) and any region label as the target. No class is special.
- The action is **one button, "Tag regions...", opening a small panel** with a
  preview of the effect before anything is created.
- A lesion can also be annotated by hand as several sub-regions, each with its
  own morphological label (for example adenomatous tissue and a focus of
  malignancy). This must keep working and must not be overwritten.
- **A "Select all" button** in Select mode (new; it does not exist today).
- Usually one lesion per sequence, but not always.

## Goals

1. In Select mode, a **Tag regions...** button opens a panel acting on the
   ticked frames.
2. The panel has a **source label** and a **target label**. Source: any region
   label that occurs on the ticked frames, listed with its count; choosing a
   parent label includes its subtypes **(my call)**. One source label at a time
   **(my call)**. Target: any region-scoped, non-abstract label, chosen with the
   same Category -> Label cascade used elsewhere in the grid toolbar.
3. Before applying, the panel shows a **preview**: how many regions will be
   created on how many frames; how many source regions are skipped because a
   morphological copy already exists (naming its label); and how many frames carry other, manually drawn regions
   of the target's evaluation type, with a checkbox "Skip those frames",
   **on by default**.
4. **Create** adds, for every eligible source region, a second annotation on
   the same frame: same geometry, same type (mask or box), the target label.
5. **Remove copies** (second mode of the same panel) deletes only the copies
   made by this feature (the ones that have a source link) that carry the chosen
   target label on the ticked frames. Hand-drawn regions are never touched.
   This is the undo for a wrong histology.
   Implementation deviation: it removes DRAFT and REJECTED copies (REVIEWED are kept), because a rejected copy would otherwise block re-tagging.
6. **Select all** (and Deselect all) in Select mode, for every bulk action.

## Non-goals

- Automatic sync of a copy when its source mask is edited afterwards. A copy is
  independent once created; the user removes the copies and creates them again.
- A copy-this-one-mask button in the frame editor's mask list. The backend
  operation is written so that button can be added later, but it is not part of
  this work.
- Any change to dataset building, export, the balance panel or the DINOv3
  adapter.
- Several source labels in one operation, or label-to-label mapping tables.
- Changing the one-label-per-annotation rule.

## Anti-goals

- Silently overwriting, deleting or altering any manually drawn annotation.
- Creating duplicates when the same operation is run twice.
- Changing the source annotation in any way.
- A preview that disagrees with what Create then does.
- Labelling an annotation with a stale `taxonomy_version`.

## Behaviour

**Eligible source region:** an annotation of type MASK or BBOX (never
CLASSIFICATION) on a ticked frame whose label is the chosen source or one of
its descendants, resolved recursively through `parent_label_id` **(my call)**.
Abstract labels never appear in the source list themselves; choosing a parent
that has descendants on the frames includes them.

A source region is **skipped** if a copy of it already exists whose label has
**the same evaluation type as the target**, whatever that label is **(my call)**.
This blocks both re-running the same operation (no duplicates) and stacking a
second, conflicting morphological label on the same geometry. The preview names
the existing label ("already tagged as adenoma"); to change it the user first
uses Remove copies, then Create. A copy in a different evaluation type (for
example a geometric shape label) does not block.

**Frames with manual target-type regions:** frames that already carry
annotations whose label has the same evaluation type as the target and that
have no source link (drawn by hand). With "Skip those frames" on, no region is
created on those frames; with it off, copies are created there as well. The
preview reports the count either way.

**New annotation:** `frame_id` of the source; `annotation_type` of the source;
`label_id` of the target; `taxonomy_version` copied from the target label at
creation time (CLAUDE.md rule, see `backend/app/annotation/service.py`);
`payload` copied from the source; `status` DRAFT even if the source was
reviewed, because the label is new information **(my call)**; `created_by`
the current user; `source_annotation_id` the source's id; `job_id` is NULL **(my call)**: a copy is its own annotation, not
a product of the SAM job that made the source, so discarding that job does not
delete it. The mask file is copied to a new object in MinIO (shared objects
would make deleting one annotation destroy the other); `StorageService` has no
server-side copy, so this is download then upload. `raw_mask_storage_key` is
copied the same way when present. A BBOX source has no object, only `payload`:
copy the object only when the key is non-null.

**Validation (422):** source and target must both be region-scoped; the target
must not be abstract; source and target must differ; source and target must
belong to different evaluation types; frame ids must exist and belong to one
sequence.

**Different evaluation types (added after the final review):** a source label
of the target's own evaluation type (for example adenoma -> ssl, both
morphological) is rejected with 422, for the preview as well as the real run.
Copying within one evaluation type would put two conflicting labels of that
type on one geometry, which the skip rule above exists to prevent, and once the
source is later removed the copies lose their link, so Remove copies can no
longer reach them.

**Atomicity:** one request is one transaction; either every copy is created or
none. Object copies made before a failure are removed.

**Preview and Create share one code path.** The preview is a dry run of the
same function, so the numbers cannot drift from the result.

**Remove copies:** deletes the annotation rows and **both** their objects
(`storage_key` and `raw_mask_storage_key`; the existing delete paths only remove
`storage_key`, which is a pre-existing leak this feature must not repeat and
does not fix elsewhere) for annotations that have a non-null source link and the
chosen target label on the ticked frames, **only when their status is DRAFT**
**(my call)**. Copies that were since reviewed are kept and counted in the
preview ("N reviewed copies kept"), so work that someone has already confirmed
is never deleted silently. Same dry-run preview with the counts.

**Select all:** ticks every frame of the sequence currently shown by the grid;
the button reads "Deselect all" while everything is ticked. The existing
two-step confirmation on Delete selected stays the only protection against a
"Select all, Delete selected" slip.

## Data model

New nullable column `annotations.source_annotation_id`, foreign key to
`annotations.id` with `ON DELETE SET NULL`, indexed, with an Alembic migration.
Deleting a source leaves its copies as ordinary independent annotations.
ml-worker keeps its own copy of the models; mirror the column there only if the
worker reads it.

## API

Backend, under the annotation module, with OpenAPI regenerated and the frontend
client generated from it (never a hand-written fetch). Route names and exact
payload shapes are the builder's call; the behaviour above is the contract:

- a way to list the region labels present on a set of frames with counts (the
  grid does not necessarily hold every annotation);
- a tag-regions operation taking frame ids, source label id, target label id,
  the skip-manual flag and a dry-run flag, returning counts: would create /
  created, skipped as already copied, frames with manual regions, frames
  skipped for that reason;
- a remove-copies operation with the same inputs, same dry-run.

## Frontend

Inside the existing Select-mode toolbar of `SequenceGridToolbar.tsx`: a
**Tag regions...** button and a **Select all / Deselect all** button. The panel
is a popover or small dialog anchored to the button, dark theme only, English
copy, with the preview recalculated when the labels, the checkbox or the
selection change. The Create button states the number it will create ("Create
28 regions") and is disabled when that number is zero. After success the grid's
annotation data is refreshed and a short result message is shown.

## Testing

TDD. Backend (`db_module.SessionLocal()`, never the real database): eligible
and skipped counts; idempotency (second run creates nothing); parent source
includes subtypes; frames with manual regions skipped or not by the flag;
validation errors; copies independent after the source is deleted; mask objects
copied, not shared; transaction rolls back and leaves no objects behind on a
mid-way failure; remove deletes only linked copies; `taxonomy_version` taken
from the target. Frontend: panel preview and Create wiring, button disabled at
zero, Select all / Deselect all, the toolbar still behaves as before. A real
browser check against the dev stack, cleaning up every row it creates.

## Left to the builder

Route names and payload shapes; how the present-labels list is obtained; the
popover versus dialog choice; wording of messages; the exact preview layout.

## Risks

- **Overlap of whole-lesion and sub-region labels** on one frame is handled by
  the skip flag, not by geometry tests; the user can still create overlapping
  regions with the flag off.
- **Large selections:** every copy is a download and an upload. The operation
  is synchronous with a **cap of 1000 source regions per request**; above it the
  request is a 422 telling the user to tick fewer frames **(my call)**. The cap
  counts source regions, not frames, so "Select all" on a long sequence is
  usually fine because only annotated frames contribute. If real sequences
  exceed the cap, the next step is a background job, which changes the API and
  comes back for a decision.
