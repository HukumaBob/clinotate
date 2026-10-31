# Tag Regions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the sequence grid's Select mode, copy region annotations (mask/box) of any source label to a second annotation with a target label on the same geometry, in bulk, with a dry-run preview, an undo ("Remove copies"), and a "Select all" button.

**Architecture:** A new nullable `annotations.source_annotation_id` links each copy to its source. A new backend module `app/annotation/tag_regions.py` holds three pure-session functions (list region labels, tag regions with dry-run, remove copies with dry-run); three thin routes expose them. The frontend adds query/mutation hooks, a `TagRegionsPanel` opened from `SequenceGridToolbar`, and Select all / Deselect all.

**Tech Stack:** FastAPI, SQLAlchemy, Alembic, MinIO via `StorageService`; React, TanStack Query, `apiClient` (openapi-typescript), Vitest + Testing Library.

**Spec:** [docs/superpowers/specs/2026-10-31-tag-regions-design.md](../specs/2026-10-31-tag-regions-design.md)

## Global Constraints

- Work directly on `master`, no branches/worktrees; do not push (CLAUDE.md).
- English only in code, comments, UI copy. Dark theme only; no light-background classes.
- Binary media only through `StorageService` (`upload(key, data, content_type)`, `download(key) -> bytes`, `delete(key)`); there is no server-side copy.
- New annotation gets `taxonomy_version` copied from the **target** label at creation (see `create_classification_annotation` in `backend/app/annotation/service.py`).
- Backend tests must never touch the real `endoscopy` DB: use the `db_session` fixture or `db_module.SessionLocal()` (never `from app.db import SessionLocal`); use an in-memory fake storage, not MinIO.
- Frontend calls only through `apiClient` (`frontend/src/shared/api/client.ts`); never edit `frontend/src/shared/api/generated/`. After backend schema/route changes: `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py` and check `git diff --stat openapi.json`.
- Cap: **1000 source regions per request**, above it HTTP 422.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Pre-existing red tests (16 backend failures, red `npm run build`) are not yours; run only the files you touch.

## Review Focus

- Source label's own evaluation type equals the target's (e.g. relabel adenoma to SSL): the eligible sources themselves must not count as "manual target-type regions", or every frame would be skipped.
- A MASK source with `storage_key` NULL or a missing object: NULL-key MASK is ineligible (not counted); a failure mid-copy rolls back and deletes every object already uploaded.
- Duplicate ids in `frame_ids` are deduped; empty `frame_ids` is 422.
- A REJECTED copy must not trap the user: Remove deletes DRAFT and REJECTED copies, keeps REVIEWED (deviation from the spec's "only DRAFT", flagged to the user).
- A cycle or deep chain in `parent_label_id` must not hang the descendant lookup.

---

### Task 1: `source_annotation_id` column and migration

**Files:**
- Modify: `backend/app/annotation/models.py` (add column after `job_id`)
- Create: `backend/alembic/versions/a1b2c3d4e5f6_add_annotation_source_annotation_id.py` (`down_revision = "f7a8b9c0d1e2"`, current single head)
- Test: `backend/tests/test_annotation_source_link.py`

**Interfaces:**
- Produces: `Annotation.source_annotation_id: Mapped[int | None]`, FK `annotations.id`, `ondelete="SET NULL"`, `index=True`.

- [ ] **Step 1: Failing test** `test_deleting_source_nulls_copy_link` (using `db_session`): create user, procedure/category/region evaluation type/label, sequence, frame, two MASK annotations where the second has `source_annotation_id=first.id`; flush; `db_session.execute(delete(Annotation).where(id==first.id))` then `db_session.refresh(second)` asserts `second.source_annotation_id is None`. Note `Base.metadata.create_all` builds the test schema, so `ON DELETE SET NULL` must be on the model's `ForeignKey`.
- [ ] **Step 2:** Run `cd backend && uv run pytest tests/test_annotation_source_link.py -v`; expect FAIL (unknown kwarg).
- [ ] **Step 3:** Add `source_annotation_id: Mapped[int | None] = mapped_column(ForeignKey("annotations.id", ondelete="SET NULL"), nullable=True, index=True)` plus a short comment (copy made by tag-regions; NULL for hand-drawn). Write the migration (add column, FK with SET NULL, index; downgrade drops them). Match the style of `d579d22f6d08_add_raw_mask_storage_key_to_annotations.py`.
- [ ] **Step 4:** Test passes; `uv run alembic heads` shows exactly one head (the new revision). Do not run `alembic upgrade` against the real database.
- [ ] **Step 5:** Commit `feat(annotation): link a copied region to its source annotation`.

### Task 2: `tag_regions` service

**Files:**
- Create: `backend/app/annotation/tag_regions.py`
- Test: `backend/tests/test_tag_regions_service.py` (contains the `FakeStorage` and the row-building helpers used by Tasks 3–4)

**Interfaces:**
- Consumes: `Annotation.source_annotation_id` (Task 1); `StorageService` methods.
- Produces (all in `app.annotation.tag_regions`):
  - `MAX_SOURCE_REGIONS = 1000`
  - `@dataclass TagRegionsResult`: `dry_run: bool`, `regions: int` (would create / created), `frames: int` (frames receiving regions), `skipped_already_copied: int`, `already_copied_label_names: list[str]` (sorted, unique), `frames_with_manual_regions: int`, `skipped_manual_frames: int`.
  - `descendant_label_ids(session: Session, label_id: int) -> set[int]` (includes itself; cycle-safe via visited set; reuse an existing helper from taxonomy/datasets code if one already exists).
  - `tag_regions(session: Session, storage: StorageService, frame_ids: list[int], source_label_id: int, target_label_id: int, created_by: User, skip_manual_frames: bool = True, dry_run: bool = False) -> TagRegionsResult`
  - `require_one_sequence(session, frame_ids) -> list[int]` (dedupes, 404 if a frame is missing, 422 if empty or frames span more than one sequence; returns the deduped list). Reused by Task 3.

Rules to implement (spec "Behaviour"): eligible source = annotation on a frame in `frame_ids`, type MASK or BBOX, label in `descendant_label_ids(source)`, and for MASK a non-NULL `storage_key`. Validation 422: both labels region-scoped (`EvaluationType.annotation_scope == REGION`), target not abstract, source != target; 404 for unknown labels. Eligible count > `MAX_SOURCE_REGIONS` -> 422. A source is skipped if some annotation has `source_annotation_id == source.id` and a label with `evaluation_type_id == target.evaluation_type_id`; that label's name goes into `already_copied_label_names`. Manual frames = frames having an annotation with that same evaluation type, `source_annotation_id IS NULL`, and not itself an eligible source; counted in `frames_with_manual_regions` always, and with `skip_manual_frames` their sources are not copied and counted in `skipped_manual_frames` (frames, not regions). New annotation: source's `frame_id` and `annotation_type`, target `label_id`, `taxonomy_version=target.taxonomy_version`, `payload` copy (deep copy), status DRAFT, `created_by_id=created_by.id`, `job_id=None`, `source_annotation_id=source.id`. MASK objects: download then upload to new keys `masks/{frame_id}/copy-{uuid4().hex}.png` and, when `raw_mask_storage_key` is set, `masks/{frame_id}/copy-{uuid4().hex}-raw.png`, content type `image/png`. BBOX: no objects. `dry_run` runs the same selection code, writes nothing and never touches storage. One transaction: on any exception delete every object uploaded so far, `session.rollback()`, re-raise.

- [ ] **Step 1: Failing tests** in `test_tag_regions_service.py`. Helpers: `FakeStorage` (dict-backed `upload/download/delete`, records deletes), a `build_world(db_session)` returning user, two sequences' frames, region evaluation types (`geometric`, `morphological`), labels `polyp`(parent, non-abstract), `polyp_ip` (child of `polyp`), `adenoma`, `ssl` (morphological), plus an abstract label and a frame-scoped label. Tests (names exact):
  - `test_dry_run_counts_match_real_run_and_write_nothing`
  - `test_create_copies_geometry_label_and_taxonomy_version` (target label has `taxonomy_version=3` while source has 1; copy has 3; payload equal but not the same object; status DRAFT; `job_id` None; link set; the source row unchanged)
  - `test_mask_objects_are_copied_not_shared` (new keys differ, bytes equal, raw key copied too)
  - `test_bbox_copy_has_no_objects`
  - `test_second_run_creates_nothing_and_names_existing_label`
  - `test_other_morphological_label_blocks_second_copy` (copy as adenoma exists, then target ssl: 0 created, names `adenoma`)
  - `test_geometric_copy_does_not_block_morphological_copy`
  - `test_parent_source_includes_descendants`
  - `test_manual_target_type_frames_skipped_by_flag_and_not_when_off`
  - `test_sources_of_target_evaluation_type_do_not_count_as_manual` (adenoma -> ssl relabel)
  - `test_mask_without_storage_key_is_ineligible`
  - `test_over_cap_is_422` (monkeypatch `MAX_SOURCE_REGIONS` to 2 with 3 sources)
  - `test_validation_errors` (frame-scoped label, abstract target, source == target, unknown label 404, empty ids 422, frames from two sequences 422, duplicate ids deduped)
  - `test_failure_midway_rolls_back_and_deletes_uploaded_objects` (FakeStorage raises on the 2nd upload)
  - `test_copy_survives_source_deletion`
- [ ] **Step 2:** Run `cd backend && uv run pytest tests/test_tag_regions_service.py -v`; expect FAIL (module missing).
- [ ] **Step 3:** Implement the module per the rules above. Use `session.flush()` not commit inside the create path until all copies exist, then `session.commit()`.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `feat(annotation): tag-regions service with dry run`.

### Task 3: region-label listing and `remove_copies`

**Files:**
- Modify: `backend/app/annotation/tag_regions.py`
- Test: `backend/tests/test_tag_regions_service.py` (extend)

**Interfaces:**
- Consumes: `require_one_sequence`, `descendant_label_ids`, `FakeStorage`/`build_world` helpers (Task 2).
- Produces:
  - `@dataclass RegionLabelCount`: `label_id: int`, `name: str`, `count: int`, `category_name: str`.
  - `list_region_labels(session: Session, frame_ids: list[int]) -> list[RegionLabelCount]`: candidates are non-abstract labels that have MASK/BBOX annotations on the frames directly or through descendants (so a non-abstract parent appears with the summed count); abstract labels never appear; the count is the number of eligible source regions (same eligibility as Task 2, including the NULL-key MASK exclusion), sorted by name.
  - `@dataclass RemoveCopiesResult`: `dry_run: bool`, `removed: int`, `kept_reviewed: int`.
  - `remove_copies(session: Session, storage: StorageService, frame_ids: list[int], target_label_id: int, dry_run: bool = False) -> RemoveCopiesResult`: copies = `source_annotation_id IS NOT NULL` and `label_id == target_label_id` on the frames. DRAFT and REJECTED are deleted (rows, then after a successful commit both `storage_key` and `raw_mask_storage_key` objects); REVIEWED are kept and counted. 404 for unknown label; frames validated with `require_one_sequence`. Hand-drawn annotations (link NULL) are never touched.

- [ ] **Step 1: Failing tests:** `test_list_region_labels_counts_and_excludes_abstract_and_classification`, `test_list_includes_nonabstract_parent_with_descendant_counts`, `test_remove_deletes_only_linked_copies_with_target_label`, `test_remove_deletes_both_objects`, `test_remove_keeps_reviewed_and_counts_them`, `test_remove_deletes_rejected_copies`, `test_remove_dry_run_changes_nothing`, `test_remove_then_create_again_works`.
- [ ] **Step 2:** Run the file; expect the new tests to FAIL.
- [ ] **Step 3:** Implement both functions.
- [ ] **Step 4:** Whole file passes.
- [ ] **Step 5:** Commit `feat(annotation): region-label listing and removal of tag-regions copies`.

### Task 4: routes, schemas, OpenAPI

**Files:**
- Modify: `backend/app/annotation/schemas.py`, `backend/app/annotation/router.py`, `openapi.json` (regenerated)
- Test: `backend/tests/test_tag_regions_api.py`

**Interfaces:**
- Consumes: Task 2–3 functions.
- Produces routes (prefix `/annotation`, any authenticated user, like the other bulk routes):
  - `POST /annotation/frames/region-labels`, body `RegionLabelsRequest{frame_ids: list[int] (min_length=1)}` -> `list[RegionLabelCountRead{label_id, name, count, category_name}]`
  - `POST /annotation/frames/tag-regions`, body `TagRegionsRequest{frame_ids (min_length=1), source_label_id, target_label_id, skip_manual_frames: bool = True, dry_run: bool = False}` -> `TagRegionsResultRead` (same fields as `TagRegionsResult`)
  - `POST /annotation/frames/remove-region-copies`, body `RemoveCopiesRequest{frame_ids (min_length=1), target_label_id, dry_run: bool = False}` -> `RemoveCopiesResultRead{dry_run, removed, kept_reviewed}`
  Place them above the `/annotations/{annotation_id}` routes next to the other `/frames/bulk-*` routes.

- [ ] **Step 1: Failing tests** using `TestClient` with `app.dependency_overrides[get_storage_service]` set to `FakeStorage` (move `FakeStorage` and the world builder into `backend/tests/tag_regions_helpers.py` and import from both test files), committed rows created through `db_module.SessionLocal()` and deleted in a fixture teardown (children before parents), auth via the register/login helper pattern from `tests/test_annotation.py`. Tests: `test_region_labels_endpoint`, `test_tag_regions_dry_run_then_create_round_trip` (dry-run numbers equal create numbers; copy visible via `GET /annotation/frames/{id}/annotations`), `test_tag_regions_validation_returns_422`, `test_remove_copies_endpoint`, `test_endpoints_require_auth`.
- [ ] **Step 2:** Run; expect FAIL (404 routes).
- [ ] **Step 3:** Add schemas and routes; routes pass `current_user` (`Depends(get_current_user)`) and `get_storage_service`.
- [ ] **Step 4:** Tests pass. Run `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py` and confirm `git diff --stat openapi.json` shows a change. Run `uv run pytest tests/test_annotation.py tests/test_tag_regions_service.py tests/test_tag_regions_api.py -q`.
- [ ] **Step 5:** Commit `feat(annotation): tag-regions, region-labels and remove-copies endpoints` including `openapi.json`.

### Task 5: frontend hooks

**Files:**
- Modify: `frontend/src/entities/useAnnotations.ts`
- Test: `frontend/src/entities/useAnnotations.test.tsx` (extend, same mocking style as the existing tests)

**Interfaces:**
- Consumes: the three routes (types come from regenerated `schema.d.ts`; run `cd frontend && npm run generate-api`).
- Produces in `useAnnotations.ts`:
  - `useRegionLabels(frameIds: number[], enabled: boolean)` -> `useQuery`, key `["region-labels", sortedIds]`, POSTs `/annotation/frames/region-labels`.
  - `useTagRegionsPreview(params: { frameIds: number[]; sourceLabelId: number; targetLabelId: number; skipManualFrames: boolean } | null)` -> `useQuery` that POSTs `/annotation/frames/tag-regions` with `dry_run: true`; `enabled` only when `params` is non-null.
  - `useTagRegions(sequenceId: number)` -> mutation taking the same params (without dry run) and POSTing `dry_run: false`; on success invalidates `["annotations", frameId]` per frame, `["frames", sequenceId]`, `["region-labels"]` and the preview keys.
  - `useRemoveCopiesPreview(params: { frameIds: number[]; targetLabelId: number } | null)` and `useRemoveRegionCopies(sequenceId: number)` with the same pattern against `/annotation/frames/remove-region-copies`.
  - If `result.data` is undefined (API error) hooks throw so Query reports `isError`.

- [ ] **Step 1: Failing tests:** `useTagRegionsPreview posts dry_run true and snake_case body`, `useTagRegionsPreview does not fire when params is null`, `useTagRegions posts dry_run false and invalidates annotations for every frame`, `useRegionLabels posts frame_ids`, `useRemoveRegionCopies posts target_label_id and invalidates`.
- [ ] **Step 2:** `cd frontend && npx vitest run src/entities/useAnnotations.test.tsx`; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5:** Commit `feat(frontend): hooks for tag-regions`.

### Task 6: Select all / Deselect all

**Files:**
- Modify: `frontend/src/features/annotation/SequenceGridToolbar.tsx`, `frontend/src/features/annotation/SequenceGridPage.tsx`
- Test: `frontend/src/features/annotation/SequenceGridToolbar.test.tsx`, `frontend/src/features/annotation/SequenceGridPage.test.tsx`

**Interfaces:**
- Produces toolbar props (all optional with no-op defaults so existing tests still compile): `totalCount?: number` (default 0), `onSelectAll?: () => void`, `onDeselectAll?: () => void`. The button appears in Select mode before the "N selected" text, `aria-label` "Select all" or "Deselect all" (when `totalCount > 0 && selectedCount === totalCount`), disabled when `totalCount === 0`.
- Page: `handleSelectAll` sets `selectedFrameIds` to every id in `framesQuery.data`; `handleDeselectAll` clears `selectedFrameIds`, `autoCheckedFrameIds`, `frameMarkReasons` (does not leave Select mode). Pass `totalCount={framesQuery.data?.length ?? 0}`.

- [ ] **Step 1: Failing tests:** toolbar `shows "Select all" and calls onSelectAll`, `reads "Deselect all" when every frame is selected and calls onDeselectAll`, `is disabled with no frames`, `is absent outside Select mode`; page `Select all ticks every frame and shows the count`, `Deselect all clears the selection and keeps Select mode`.
- [ ] **Step 2:** Run both files; expect the new tests FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Both files pass in full (existing toolbar/page tests must not regress).
- [ ] **Step 5:** Commit `feat(frontend): select all / deselect all in the sequence grid`.

### Task 7: `TagRegionsPanel` and toolbar wiring

**Files:**
- Create: `frontend/src/features/annotation/TagRegionsPanel.tsx`, `frontend/src/features/annotation/TagRegionsPanel.test.tsx`
- Modify: `frontend/src/features/annotation/SequenceGridToolbar.tsx`, `frontend/src/features/annotation/SequenceGridPage.tsx`, `SequenceGridToolbar.test.tsx`

**Interfaces:**
- Consumes: Task 5 hooks; Task 6 toolbar; `TaxonomyTreeNode` shape used in the toolbar (`evaluation_types[].evaluation_type.annotation_scope`, `.labels[]` with `is_abstract`).
- Produces: `TagRegionsPanel({ sequenceId, frameIds, taxonomyTree, onClose })`; toolbar new optional props `sequenceId?: number` and `selectedFrameIds?: number[]` (default `[]`), a "Tag regions…" button (`aria-label="Tag regions"`, disabled when `selectedCount === 0`) that toggles an anchored dark panel under the button. The page passes `sequenceId={sequenceIdNumber}` and `selectedFrameIds={Array.from(selectedFrameIds)}`.

Panel behaviour (English copy): header "Tag regions on N selected frames"; a mode switch "Create" / "Remove copies"; **Create:** source `<select aria-label="Source label">` fed by `useRegionLabels` ("polyp (12)" style, empty state "No regions on the selected frames"), target Category `<select aria-label="Target category">` then Label `<select aria-label="Target label">` from region-scoped, non-abstract labels (same cascade as the toolbar's classification pickers), the checkbox "Skip frames that already have hand-drawn regions of this type" checked by default; the preview box shows "Will create N regions on M frames." plus, when present, "Skipped: K already tagged as <names>." and "<F> frames have hand-drawn regions of this type" (with "— skipped" when the checkbox is on); button `Create N regions`, disabled when N is 0 or the preview is loading/errored; a preview error shows its message. After success: a short result line and the panel stays open (preview refreshes to 0). **Remove copies:** target picker as above, preview "Will remove N copies. K reviewed copies are kept.", button `Remove N copies`, disabled at 0, with the same two-step confirm as the toolbar's Delete (first click arms and the label becomes "Confirm"). Esc and "Close" call `onClose`.

- [ ] **Step 1: Failing tests** (`TagRegionsPanel.test.tsx`, hooks module mocked with `vi.mock("../../entities/useAnnotations")`): `lists source labels with counts`, `shows the empty state`, `preview text reflects the dry-run numbers and names skipped labels`, `Create button states the number and is disabled at zero`, `Create calls useTagRegions with the chosen labels and skip flag`, `unchecking the skip box changes the preview params`, `target list excludes abstract and frame-scoped labels`, `Remove mode shows reviewed-kept note and needs a second click to confirm`. Toolbar test: `Tag regions button is disabled with nothing selected and opens the panel`.
- [ ] **Step 2:** `cd frontend && npx vitest run src/features/annotation/TagRegionsPanel.test.tsx src/features/annotation/SequenceGridToolbar.test.tsx`; expect FAIL.
- [ ] **Step 3:** Implement panel and wiring; keep the panel in its own file (the toolbar is already ~275 lines).
- [ ] **Step 4:** Both files pass; also run `src/features/annotation/SequenceGridPage.test.tsx` and `npx tsc --noEmit -p .` limited to confirming no new type errors in touched files.
- [ ] **Step 5:** Commit `feat(frontend): Tag regions panel in the sequence grid`.

### Task 8: docs and real-browser check

**Files:**
- Modify: `ROADMAP.md` (new section "Tag regions (2026-10-31)": what was built, deviations incl. REJECTED removal), `CHANGELOG.md` (Unreleased), spec header `Status:` -> `approved, implemented`.

- [ ] **Step 1:** Update the three docs.
- [ ] **Step 2 (controller, not a subagent):** Real-browser check against the dev stack with the `manualcheck@example.com` login: create a throwaway sequence with frames and one geometric mask + one box, run Select all -> Tag regions preview -> Create -> confirm the copy in the frame editor -> run again (0 to create) -> Remove copies. Respect the "don't touch dev ports/servers" memory (ask before stopping or starting servers). Afterwards sweep every row and MinIO object created, per CLAUDE.md.
- [ ] **Step 3:** Commit `docs: record the tag-regions feature`.
