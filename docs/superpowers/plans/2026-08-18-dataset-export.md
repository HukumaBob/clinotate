# Dataset Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export a saved `Dataset` as a downloadable archive carrying both YOLO (trainable directly) and COCO (portable to other tools), assembled by a background `Job` that streams to disk and reports every data defect it finds in one pass.

**Architecture:** Geometry is derived once per mask with OpenCV (it is not in the database — `payload` holds the SAM prompt), then fed to both serializers. A Celery task on the existing `video_transcode` CPU queue streams a zip to a temp file and uploads it to object storage, recording the key in `Job.result_ref` and any findings in `Job.payload["findings"]`.

**Tech Stack:** FastAPI, SQLAlchemy 2.0, Alembic, Celery + Redis, MinIO via `StorageService`, OpenCV, pytest, React + TypeScript, Vitest, Tailwind (dark-only).

**Spec:** [docs/superpowers/specs/2026-08-18-dataset-export-design.md](../specs/2026-08-18-dataset-export-design.md)

## Global Constraints

- **Language:** English only in all committed content — code, comments, docstrings, UI copy. No Russian.
- **UI theme:** dark only. Never introduce light-background Tailwind classes.
- **Object storage:** all binary media goes through `StorageService`. The one sanctioned exception is transient `tempfile.NamedTemporaryFile` use, which this plan relies on for streaming the archive.
- **JSON, not JSONB** for new columns.
- **API contract:** after any schema/route change run `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py` (the `PYTHONPATH=.` is required), then verify with `git diff --stat openapi.json`. Never hand-edit `frontend/src/shared/api/generated/`.
- **TDD:** every task gets a failing test, actually run and observed failing, before the implementation.
- **Git:** commit directly to `master`. No branch, no worktree, no merge, no push.
- **Never TRUNCATE/DELETE/DROP anything in the `endoscopy` database** — it holds real clinical annotations and taxonomy. Datasets named `11111`, `22222`, `33333` belong to the user; never delete them.

### Environment facts — verified, do not re-derive

- **Backend baseline: 318 passed / 16 pre-existing failures** (`test_jobs.py`, `test_media_service.py`, `test_mask_postprocess_endpoint.py`, `test_quality_migration.py` and others). Do not fix those 16.
- **Frontend baseline: 466 passed.**
- **`npm run build` (tsc over the whole repo) is RED and predates this work** (~235 errors from a broken jest-dom matcher type setup). NOT a gate. Gates are `npm test` green plus no NEW product-code tsc errors; exactly one is accepted: `useDatasets.ts(26,38): Property 'error' does not exist on type 'never'`.
- Backend tests run against an ephemeral `endoscopy_test` database that `conftest.py` resets per session.
- Alembic head at plan time: `4720dcd56ff9`. Task 2's migration revises it.
- OpenCV (`opencv-python-headless`) and numpy are already backend dependencies, used by `app/annotation/mask_postprocess.py`.

### Facts about the data this plan depends on

- **Mask geometry is NOT in the database.** `Annotation.payload` holds the SAM prompt (a base64 PNG plus click coordinates); the mask itself is a raster in object storage under `Annotation.storage_key`. All 55 MASK rows carry both.
- **Frame basenames collide.** Frames are stored as `frames/<sequence_id>/<index>.png`; 1109 frames share only 488 distinct basenames. Archive entries must be named `<sequence_id>_<index>` or more than half the dataset is silently overwritten.
- **Frames vary hugely in size**: 244×236 to 1920×1072, a 37× spread in area. Hence a fractional mask-area threshold, never a pixel count.
- **`SettingsUpdate` requires every field.** `frontend/src/entities/useSettings.ts` sends `max_track_range_frames` and `mask_postprocess_strength` explicitly; adding a required third field without updating the frontend makes every settings save fail with 422. Task 1 must change both ends together.

---

### Task 1: `min_mask_area_fraction` setting, end to end

**Files:**
- Modify: `backend/app/settings/models.py` (`PlatformSettings`)
- Modify: `backend/app/settings/schemas.py` (`SettingsRead`, `SettingsUpdate`)
- Create: `backend/alembic/versions/<generated>_add_min_mask_area_fraction.py`
- Modify: `frontend/src/entities/useSettings.ts`
- Modify: `frontend/src/features/settings/SettingsPage.tsx`
- Modify: `openapi.json` (regenerated)
- Test: `backend/tests/test_settings.py` (append)
- Test: `frontend/src/features/settings/SettingsPage.test.tsx` (append)

**Interfaces:**
- Produces: `PlatformSettings.min_mask_area_fraction: float` (default `0.0005`), exposed on `SettingsRead`/`SettingsUpdate` and editable on the Settings page. Task 3 reads it.

**Why both ends in one task:** `SettingsUpdate` has no optional fields — every field is required. Adding one server-side without updating the frontend's PATCH body makes every settings save return 422. Splitting this across tasks would ship a broken screen in between.

- [ ] **Step 1: Write the failing backend test**

Append to `backend/tests/test_settings.py`, matching the file's existing helpers:

```python
def test_settings_expose_and_update_min_mask_area_fraction():
    headers = _auth_headers(_register_and_login("settings-mmaf@example.com"))

    read = client.get("/settings", headers=headers)
    assert read.status_code == 200
    assert "min_mask_area_fraction" in read.json()

    updated = client.patch(
        "/settings",
        json={
            "max_track_range_frames": 10,
            "mask_postprocess_strength": 0.3,
            "min_mask_area_fraction": 0.002,
        },
        headers=headers,
    )
    assert updated.status_code == 200
    assert updated.json()["min_mask_area_fraction"] == 0.002


def test_min_mask_area_fraction_rejects_values_outside_zero_to_one():
    headers = _auth_headers(_register_and_login("settings-mmaf2@example.com"))

    for bad in (-0.1, 1.5):
        response = client.patch(
            "/settings",
            json={
                "max_track_range_frames": 10,
                "mask_postprocess_strength": 0.3,
                "min_mask_area_fraction": bad,
            },
            headers=headers,
        )
        assert response.status_code == 422
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && uv run pytest tests/test_settings.py -k mmaf -v`
Expected: FAIL — `KeyError`/assertion on the missing `min_mask_area_fraction`.

- [ ] **Step 3: Add the column, schema fields, and migration**

In `backend/app/settings/models.py`, inside `PlatformSettings`:

```python
    # Masks smaller than this fraction of their frame's area are dropped at
    # export time as noise. A fraction, not a pixel count: frames range from
    # 244x236 to 1920x1072, a 37x spread in area, so a fixed pixel threshold
    # would mean wildly different strictness per frame. 0.0005 is ~30px on
    # the smallest frame and ~1000px on the largest.
    min_mask_area_fraction: Mapped[float] = mapped_column(Float, default=0.0005)
```

Add `Float` to the sqlalchemy import if absent.

In `backend/app/settings/schemas.py`, add to both models:

```python
    min_mask_area_fraction: float  # SettingsRead
    min_mask_area_fraction: float = Field(ge=0.0, le=1.0)  # SettingsUpdate
```

Generate the migration with `cd backend && uv run alembic revision -m "add min mask area fraction"`, confirm `down_revision` is `'4720dcd56ff9'` (verify with `uv run alembic heads` first), then:

```python
def upgrade() -> None:
    op.add_column(
        'platform_settings',
        sa.Column('min_mask_area_fraction', sa.Float(), nullable=False,
                  server_default=sa.text('0.0005')),
    )


def downgrade() -> None:
    op.drop_column('platform_settings', 'min_mask_area_fraction')
```

The `server_default` is required: the column is NOT NULL on a table that already holds the singleton row.

Apply it: `cd backend && uv run alembic upgrade head`.

- [ ] **Step 4: Run the backend tests**

Run: `cd backend && uv run pytest tests/test_settings.py -v`
Expected: PASS.

- [ ] **Step 5: Regenerate OpenAPI**

```bash
cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py
git diff --stat openapi.json
```
Expected: a non-empty diff. If empty, stop — the frontend depends on it.

- [ ] **Step 6: Write the failing frontend test**

```bash
cd frontend && npm run generate-api
```

Append to `frontend/src/features/settings/SettingsPage.test.tsx`, matching the file's existing render helper and mock style. Add `min_mask_area_fraction: 0.0005` to whatever settings fixture the file already defines:

```tsx
it("saves the minimum mask area fraction along with the other settings", async () => {
  renderPage();

  const input = await screen.findByLabelText(/minimum mask area/i);
  await userEvent.clear(input);
  await userEvent.type(input, "0.002");
  await userEvent.click(screen.getByRole("button", { name: /save/i }));

  await waitFor(() => {
    expect(apiClient.PATCH).toHaveBeenCalledWith(
      "/settings",
      expect.objectContaining({
        body: expect.objectContaining({ min_mask_area_fraction: 0.002 }),
      }),
    );
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/features/settings/SettingsPage.test.tsx`
Expected: FAIL — no such label.

- [ ] **Step 8: Wire the frontend**

In `src/entities/useSettings.ts`, add `minMaskAreaFraction: number` to the mutation's argument type and `min_mask_area_fraction: minMaskAreaFraction` to the PATCH body.

In `src/features/settings/SettingsPage.tsx`, add a `minMaskAreaFraction` state initialized from `settingsQuery.data.min_mask_area_fraction`, a labelled number input (`Minimum mask area (fraction of frame)`, `step={0.0001}`, `min={0}`, `max={1}`) matching the neighbouring inputs' Tailwind classes exactly, include it in the `updateSettings.mutate` call, and extend the existing empty-value guard to cover it.

- [ ] **Step 9: Run both suites and commit**

```bash
cd frontend && npx vitest run src/features/settings/ && npm test
cd ../backend && uv run pytest tests/test_settings.py -q
git add backend/app/settings/ backend/alembic/versions/ backend/tests/test_settings.py frontend/src/entities/useSettings.ts frontend/src/features/settings/ openapi.json
git commit -m "feat: add configurable minimum mask area fraction"
```

---

### Task 2: Geometry extraction from mask rasters

**Files:**
- Create: `backend/app/datasets/geometry.py`
- Test: `backend/tests/test_dataset_geometry.py`

**Interfaces:**
- Produces:
  - `MaskGeometry` — a dataclass with `bbox: tuple[int, int, int, int]` (x, y, w, h in pixels), `polygon: list[tuple[int, int]]` (outer contour points), `area_px: int` (non-zero pixel count).
  - `extract_geometry(mask: np.ndarray) -> MaskGeometry` — raises `ValueError` on an all-zero mask.
  - `decode_mask(data: bytes) -> np.ndarray` — decodes PNG bytes to a 2-D uint8 array; raises `ValueError` when the bytes are not a decodable image.

This is the only place raster pixels are touched. Everything downstream consumes `MaskGeometry`, so a mask is read and decoded exactly once per annotation regardless of how many formats are written.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_dataset_geometry.py`:

```python
import cv2
import numpy as np
import pytest

from app.datasets.geometry import decode_mask, extract_geometry


def _rect_mask(width=100, height=80, x=10, y=20, w=30, h=40):
    mask = np.zeros((height, width), dtype=np.uint8)
    mask[y : y + h, x : x + w] = 255
    return mask


def test_a_rectangular_mask_yields_its_bounding_box():
    geometry = extract_geometry(_rect_mask())
    assert geometry.bbox == (10, 20, 30, 40)


def test_area_counts_non_zero_pixels():
    geometry = extract_geometry(_rect_mask(w=30, h=40))
    assert geometry.area_px == 30 * 40


def test_a_mask_with_a_hole_yields_the_outer_contour():
    mask = _rect_mask(w=40, h=40)
    mask[30:40, 20:30] = 0  # punch a hole inside the rectangle
    geometry = extract_geometry(mask)
    assert geometry.bbox == (10, 20, 40, 40)
    assert len(geometry.polygon) >= 4


def test_the_polygon_stays_inside_the_bounding_box():
    geometry = extract_geometry(_rect_mask())
    x, y, w, h = geometry.bbox
    for px, py in geometry.polygon:
        assert x <= px <= x + w
        assert y <= py <= y + h


def test_an_all_zero_mask_raises_rather_than_returning_an_empty_shape():
    with pytest.raises(ValueError):
        extract_geometry(np.zeros((50, 50), dtype=np.uint8))


def test_two_disjoint_blobs_report_the_largest_contour():
    mask = np.zeros((100, 100), dtype=np.uint8)
    mask[10:20, 10:20] = 255   # small blob
    mask[50:80, 50:90] = 255   # large blob
    geometry = extract_geometry(mask)
    assert geometry.bbox == (50, 50, 40, 30)


def test_decode_mask_round_trips_a_png():
    original = _rect_mask()
    encoded = cv2.imencode(".png", original)[1].tobytes()
    decoded = decode_mask(encoded)
    assert decoded.shape == original.shape
    assert int((decoded > 0).sum()) == int((original > 0).sum())


def test_decode_mask_rejects_bytes_that_are_not_an_image():
    with pytest.raises(ValueError):
        decode_mask(b"this is not a png")
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && uv run pytest tests/test_dataset_geometry.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.datasets.geometry'`.

- [ ] **Step 3: Implement**

Create `backend/app/datasets/geometry.py`:

```python
from dataclasses import dataclass

import cv2
import numpy as np


@dataclass(frozen=True)
class MaskGeometry:
    """The shape of one annotation, derived once from its raster.

    Geometry is not stored in the database -- Annotation.payload holds the
    SAM prompt that produced the mask, not the resulting shape -- so every
    label file is derived from the raster. Extracting once and reusing the
    result is what keeps a multi-format export from decoding each mask twice.
    """

    bbox: tuple[int, int, int, int]
    polygon: list[tuple[int, int]]
    area_px: int


def decode_mask(data: bytes) -> np.ndarray:
    """Decode PNG bytes into a 2-D uint8 mask."""
    buffer = np.frombuffer(data, dtype=np.uint8)
    mask = cv2.imdecode(buffer, cv2.IMREAD_GRAYSCALE)
    if mask is None:
        raise ValueError("mask bytes could not be decoded as an image")
    return mask


def extract_geometry(mask: np.ndarray) -> MaskGeometry:
    """Bounding box, outer polygon and pixel area of a mask's largest blob.

    Raises on an empty mask rather than emitting a degenerate shape: a label
    file with a zero-area box trains a detector on nothing, and silently
    writing one would hide a real annotation defect.
    """
    binary = (mask > 0).astype(np.uint8)
    area_px = int(binary.sum())
    if area_px == 0:
        raise ValueError("mask has no non-zero pixels")

    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        raise ValueError("mask has no extractable contour")

    largest = max(contours, key=cv2.contourArea)
    x, y, w, h = cv2.boundingRect(largest)

    # Simplify the contour so a polygon label stays a few dozen points
    # instead of one point per boundary pixel.
    epsilon = 0.002 * cv2.arcLength(largest, True)
    simplified = cv2.approxPolyDP(largest, epsilon, True)
    polygon = [(int(point[0][0]), int(point[0][1])) for point in simplified]

    return MaskGeometry(bbox=(x, y, w, h), polygon=polygon, area_px=area_px)
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run pytest tests/test_dataset_geometry.py -v`
Expected: PASS (8 tests).

- [ ] **Step 5: Verify against a real mask**

```bash
cd backend && PYTHONPATH=. uv run python -c "
from app.db import SessionLocal
from app.annotation.models import Annotation, AnnotationType
from app.datasets.geometry import decode_mask, extract_geometry
from app.storage import get_storage_service
session = SessionLocal()
storage = get_storage_service()
row = (session.query(Annotation)
       .filter(Annotation.annotation_type == AnnotationType.MASK,
               Annotation.storage_key.isnot(None))
       .first())
geometry = extract_geometry(decode_mask(storage.download(row.storage_key)))
print('annotation', row.id, 'bbox', geometry.bbox,
      'polygon points', len(geometry.polygon), 'area', geometry.area_px)
session.close()"
```

Expected: a plausible bbox, a polygon of a few dozen points (not thousands), and a non-zero area.

- [ ] **Step 6: Commit**

```bash
git add backend/app/datasets/geometry.py backend/tests/test_dataset_geometry.py
git commit -m "feat: extract bbox and polygon geometry from mask rasters"
```

---

### Task 3: Export assembly — collect, validate, serialize

**Files:**
- Create: `backend/app/datasets/export.py`
- Test: `backend/tests/test_dataset_export.py`

**Interfaces:**
- Consumes: `MaskGeometry`, `extract_geometry`, `decode_mask` from Task 2; `PlatformSettings.min_mask_area_fraction` from Task 1; `Dataset`, `DatasetItem`, `TaskType`, `SplitName` from `app.datasets.models`.
- Produces:
  - `Finding` — dataclass with `kind: str`, `frame_id: int`, `annotation_id: int | None`, `detail: str`.
  - `ExportItem` — dataclass with `frame_id`, `sequence_id`, `frame_index`, `split: str`, `storage_key: str`, `width: int`, `height: int`, `entries: list[ExportEntry]`, `is_negative: bool`.
  - `ExportEntry` — dataclass with `annotation_id: int`, `class_id: int`, `class_name: str`, `geometry: MaskGeometry | None` (None for frame-level classification).
  - `collect_export_items(session, dataset, storage) -> tuple[list[ExportItem], list[Finding], dict[int, str]]` — the third element maps `class_id` to `class_name`.
  - `archive_name(item: ExportItem) -> str` — returns `f"{item.sequence_id}_{item.frame_index}"`.
  - `write_yolo_label(item, task_type) -> str` and `build_coco(items, class_names, dataset) -> dict`.

**Three rules carry weight and must not be softened:**

1. **Archive names are `<sequence_id>_<index>`, never the raw basename.** Frames are stored as `frames/<sequence_id>/<index>.png` and 1109 real frames share only 488 basenames — naming by basename silently overwrites more than half the dataset and leaves labels pointing at the wrong pixels.
2. **Every finding is collected, then judged.** A missing mask file or a multi-label classification frame is an error that aborts; a mask below the threshold is a warning that filters. Both are gathered across the whole dataset first, so the user fixes in one batch instead of re-running a multi-gigabyte export per defect.
3. **A frame whose only annotation was filtered leaves the dataset and does NOT become a negative.** Discarding a noisy mask is not a claim that the frame is empty — the same rule exclusions already follow.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_dataset_export.py`:

```python
import app.main  # noqa: F401 -- registers every model on Base.metadata for create_all
import cv2
import numpy as np
import pytest
import sqlalchemy as sa

from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
from app.datasets.export import (
    Finding,
    archive_name,
    build_coco,
    collect_export_items,
    write_yolo_label,
)
from app.datasets.models import Dataset, DatasetItem, SplitName, TaskType
from app.db import SessionLocal
from app.media.models import Frame, Sequence, Video
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure


class _FakeStorage:
    """Stands in for MinIO so export tests never touch object storage."""

    def __init__(self):
        self.objects: dict[str, bytes] = {}

    def put_mask(self, key: str, mask: np.ndarray) -> None:
        self.objects[key] = cv2.imencode(".png", mask)[1].tobytes()

    def download(self, key: str) -> bytes:
        if key not in self.objects:
            raise FileNotFoundError(key)
        return self.objects[key]


def _rect_mask(height, width, x, y, w, h):
    mask = np.zeros((height, width), dtype=np.uint8)
    mask[y : y + h, x : x + w] = 255
    return mask


def _island(session, tag, scope=AnnotationScope.REGION):
    procedure = Procedure(name=f"ex-{tag}-proc")
    session.add(procedure)
    session.flush()
    category = Category(name=f"ex-{tag}-cat", procedure_id=procedure.id)
    session.add(category)
    session.flush()
    evaluation_type = EvaluationType(name=f"ex-{tag}-et", annotation_scope=scope)
    session.add(evaluation_type)
    session.flush()
    video = Video(title=f"ex-{tag}-v", storage_key=f"ex/{tag}.mp4",
                  checksum=f"ex-{tag}", fps=25.0, duration_seconds=1.0)
    session.add(video)
    session.flush()
    sequence = Sequence(name=f"ex-{tag}-seq", start_time=0, duration=1,
                        procedure_id=procedure.id, video_id=video.id)
    session.add(sequence)
    session.flush()
    user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
    return category, evaluation_type, sequence, user_id


def _frame(session, sequence, index, width=100, height=80):
    frame = Frame(sequence_id=sequence.id, storage_key=f"frames/{sequence.id}/{index}.png",
                  frame_index=index, width=width, height=height)
    session.add(frame)
    session.flush()
    return frame


def _label(session, category, evaluation_type, name):
    label = Label(name=name, category_id=category.id, evaluation_type_id=evaluation_type.id)
    session.add(label)
    session.flush()
    return label


def _annotate(session, frame, label, user_id, annotation_type=AnnotationType.MASK, key=None):
    annotation = Annotation(
        frame_id=frame.id, label_id=label.id, taxonomy_version=label.taxonomy_version,
        annotation_type=annotation_type, payload={}, status=AnnotationStatus.DRAFT,
        created_by_id=user_id, storage_key=key,
    )
    session.add(annotation)
    session.flush()
    return annotation


def _dataset(session, user_id, task_type, items):
    dataset = Dataset(
        name=f"ex-ds-{task_type.value}", task_type=task_type, taxonomy_version=1,
        split_config={"train": 70, "val": 20}, grouping_overrides={},
        excluded_label_ids=[], class_limits={}, balance_metrics={}, created_by_id=user_id,
    )
    session.add(dataset)
    session.flush()
    for frame, annotation_ids, split in items:
        session.add(DatasetItem(dataset_id=dataset.id, frame_id=frame.id,
                                annotation_ids=annotation_ids, split=split))
    session.flush()
    return dataset


def test_archive_names_disambiguate_frames_from_different_sequences():
    # Real corpus: 1109 frames share only 488 basenames. Naming by basename
    # would silently overwrite more than half the dataset.
    session = SessionLocal()
    try:
        category, region, sequence_a, user_id = _island(session, "namea")
        _, _, sequence_b, _ = _island(session, "nameb")
        polyp = _label(session, category, region, "ex-name-polyp")
        storage = _FakeStorage()

        frame_a = _frame(session, sequence_a, 7)
        frame_b = _frame(session, sequence_b, 7)
        for frame in (frame_a, frame_b):
            key = f"masks/{frame.id}.png"
            storage.put_mask(key, _rect_mask(80, 100, 10, 20, 30, 40))
            _annotate(session, frame, polyp, user_id, key=key)

        dataset = _dataset(session, user_id, TaskType.DETECTION, [
            (frame_a, [a.id for a in session.query(Annotation).filter_by(frame_id=frame_a.id)], SplitName.TRAIN),
            (frame_b, [a.id for a in session.query(Annotation).filter_by(frame_id=frame_b.id)], SplitName.TRAIN),
        ])

        items, findings, _ = collect_export_items(session, dataset, storage)

        names = {archive_name(item) for item in items}
        assert len(names) == 2, f"names collided: {names}"
        assert findings == []
    finally:
        session.rollback()
        session.close()


def test_a_missing_mask_file_is_an_error_finding():
    session = SessionLocal()
    try:
        category, region, sequence, user_id = _island(session, "missing")
        polyp = _label(session, category, region, "ex-missing-polyp")
        storage = _FakeStorage()  # deliberately empty
        frame = _frame(session, sequence, 1)
        annotation = _annotate(session, frame, polyp, user_id, key="masks/absent.png")
        dataset = _dataset(session, user_id, TaskType.DETECTION,
                           [(frame, [annotation.id], SplitName.TRAIN)])

        _, findings, _ = collect_export_items(session, dataset, storage)

        assert any(f.kind == "missing_mask" and f.annotation_id == annotation.id
                   for f in findings)
    finally:
        session.rollback()
        session.close()


def test_every_defect_is_reported_not_just_the_first():
    session = SessionLocal()
    try:
        category, region, sequence, user_id = _island(session, "allfind")
        polyp = _label(session, category, region, "ex-allfind-polyp")
        storage = _FakeStorage()
        frames = [_frame(session, sequence, i) for i in range(3)]
        annotations = [
            _annotate(session, frame, polyp, user_id, key=f"masks/absent-{i}.png")
            for i, frame in enumerate(frames)
        ]
        dataset = _dataset(session, user_id, TaskType.DETECTION,
                           [(f, [a.id], SplitName.TRAIN) for f, a in zip(frames, annotations)])

        _, findings, _ = collect_export_items(session, dataset, storage)

        assert len([f for f in findings if f.kind == "missing_mask"]) == 3
    finally:
        session.rollback()
        session.close()


def test_a_mask_below_the_threshold_is_filtered_and_reported():
    session = SessionLocal()
    try:
        category, region, sequence, user_id = _island(session, "tiny")
        polyp = _label(session, category, region, "ex-tiny-polyp")
        storage = _FakeStorage()
        frame = _frame(session, sequence, 1, width=100, height=100)
        key = "masks/tiny.png"
        # 2x2 = 4px out of 10000 = 0.04%, below the 0.05% default.
        storage.put_mask(key, _rect_mask(100, 100, 5, 5, 2, 2))
        annotation = _annotate(session, frame, polyp, user_id, key=key)
        dataset = _dataset(session, user_id, TaskType.DETECTION,
                           [(frame, [annotation.id], SplitName.TRAIN)])

        items, findings, _ = collect_export_items(session, dataset, storage)

        assert any(f.kind == "mask_below_threshold" for f in findings)
        assert items == [], "the frame's only annotation was filtered, so it leaves"
    finally:
        session.rollback()
        session.close()


def test_a_frame_whose_only_mask_was_filtered_does_not_become_a_negative():
    # Discarding a noisy mask is not a claim that the frame is empty.
    session = SessionLocal()
    try:
        category, region, sequence, user_id = _island(session, "notneg")
        polyp = _label(session, category, region, "ex-notneg-polyp")
        storage = _FakeStorage()
        frame = _frame(session, sequence, 1, width=100, height=100)
        key = "masks/notneg.png"
        storage.put_mask(key, _rect_mask(100, 100, 5, 5, 2, 2))
        annotation = _annotate(session, frame, polyp, user_id, key=key)
        dataset = _dataset(session, user_id, TaskType.DETECTION,
                           [(frame, [annotation.id], SplitName.TRAIN)])

        items, _, _ = collect_export_items(session, dataset, storage)

        assert all(not item.is_negative for item in items)
        assert items == []
    finally:
        session.rollback()
        session.close()


def test_a_multi_label_classification_frame_is_an_error_finding():
    session = SessionLocal()
    try:
        category, frame_scope, sequence, user_id = _island(
            session, "multi", scope=AnnotationScope.FRAME)
        quality = _label(session, category, frame_scope, "ex-multi-low-quality")
        landmark = _label(session, category, frame_scope, "ex-multi-caecum")
        storage = _FakeStorage()
        frame = _frame(session, sequence, 1)
        first = _annotate(session, frame, quality, user_id, AnnotationType.CLASSIFICATION)
        second = _annotate(session, frame, landmark, user_id, AnnotationType.CLASSIFICATION)
        dataset = _dataset(session, user_id, TaskType.CLASSIFICATION,
                           [(frame, [first.id, second.id], SplitName.TRAIN)])

        _, findings, _ = collect_export_items(session, dataset, storage)

        multi = [f for f in findings if f.kind == "multi_label_classification"]
        assert multi and multi[0].frame_id == frame.id
    finally:
        session.rollback()
        session.close()


def test_a_negative_frame_yields_an_empty_yolo_label():
    session = SessionLocal()
    try:
        category, region, sequence, user_id = _island(session, "neg")
        storage = _FakeStorage()
        frame = _frame(session, sequence, 1)
        frame.no_findings_reviewed = True
        session.flush()
        dataset = _dataset(session, user_id, TaskType.DETECTION,
                           [(frame, [], SplitName.TRAIN)])

        items, findings, _ = collect_export_items(session, dataset, storage)

        assert findings == []
        assert len(items) == 1 and items[0].is_negative
        assert write_yolo_label(items[0], TaskType.DETECTION) == ""
    finally:
        session.rollback()
        session.close()


def test_detection_labels_are_normalized_into_zero_to_one():
    session = SessionLocal()
    try:
        category, region, sequence, user_id = _island(session, "norm")
        polyp = _label(session, category, region, "ex-norm-polyp")
        storage = _FakeStorage()
        frame = _frame(session, sequence, 1, width=100, height=80)
        key = "masks/norm.png"
        storage.put_mask(key, _rect_mask(80, 100, 10, 20, 30, 40))
        annotation = _annotate(session, frame, polyp, user_id, key=key)
        dataset = _dataset(session, user_id, TaskType.DETECTION,
                           [(frame, [annotation.id], SplitName.TRAIN)])

        items, _, _ = collect_export_items(session, dataset, storage)
        line = write_yolo_label(items[0], TaskType.DETECTION).strip()

        parts = line.split()
        assert parts[0] == "0"
        values = [float(v) for v in parts[1:]]
        assert len(values) == 4
        assert all(0.0 <= v <= 1.0 for v in values), values
        # bbox (10,20,30,40) on a 100x80 frame -> centre (25,40) -> 0.25, 0.5
        assert abs(values[0] - 0.25) < 0.01
        assert abs(values[1] - 0.50) < 0.01
    finally:
        session.rollback()
        session.close()


def test_segmentation_labels_are_polygons_normalized_into_zero_to_one():
    session = SessionLocal()
    try:
        category, region, sequence, user_id = _island(session, "seg")
        polyp = _label(session, category, region, "ex-seg-polyp")
        storage = _FakeStorage()
        frame = _frame(session, sequence, 1, width=100, height=80)
        key = "masks/seg.png"
        storage.put_mask(key, _rect_mask(80, 100, 10, 20, 30, 40))
        annotation = _annotate(session, frame, polyp, user_id, key=key)
        dataset = _dataset(session, user_id, TaskType.SEGMENTATION,
                           [(frame, [annotation.id], SplitName.TRAIN)])

        items, _, _ = collect_export_items(session, dataset, storage)
        line = write_yolo_label(items[0], TaskType.SEGMENTATION).strip()

        parts = line.split()
        assert parts[0] == "0"
        values = [float(v) for v in parts[1:]]
        assert len(values) >= 6 and len(values) % 2 == 0
        assert all(0.0 <= v <= 1.0 for v in values)
    finally:
        session.rollback()
        session.close()


def test_coco_carries_provenance_and_matches_the_class_map():
    session = SessionLocal()
    try:
        category, region, sequence, user_id = _island(session, "coco")
        polyp = _label(session, category, region, "ex-coco-polyp")
        storage = _FakeStorage()
        frame = _frame(session, sequence, 1, width=100, height=80)
        key = "masks/coco.png"
        storage.put_mask(key, _rect_mask(80, 100, 10, 20, 30, 40))
        annotation = _annotate(session, frame, polyp, user_id, key=key)
        dataset = _dataset(session, user_id, TaskType.DETECTION,
                           [(frame, [annotation.id], SplitName.TRAIN)])

        items, _, class_names = collect_export_items(session, dataset, storage)
        coco = build_coco(items, class_names, dataset)

        assert coco["info"]["taxonomy_version"] == dataset.taxonomy_version
        assert "class_map" in coco["info"]
        assert coco["info"]["class_limits"] == dataset.class_limits
        assert coco["info"]["excluded_label_ids"] == dataset.excluded_label_ids
        assert len(coco["images"]) == 1
        assert len(coco["annotations"]) == 1
        assert coco["annotations"][0]["bbox"] == [10, 20, 30, 40]
        assert coco["annotations"][0]["segmentation"]
        category_ids = {c["id"] for c in coco["categories"]}
        assert coco["annotations"][0]["category_id"] in category_ids
    finally:
        session.rollback()
        session.close()


def test_a_negative_frame_appears_in_coco_images_with_no_annotation():
    session = SessionLocal()
    try:
        category, region, sequence, user_id = _island(session, "coconeg")
        storage = _FakeStorage()
        frame = _frame(session, sequence, 1)
        frame.no_findings_reviewed = True
        session.flush()
        dataset = _dataset(session, user_id, TaskType.DETECTION,
                           [(frame, [], SplitName.TRAIN)])

        items, _, class_names = collect_export_items(session, dataset, storage)
        coco = build_coco(items, class_names, dataset)

        assert len(coco["images"]) == 1
        assert coco["annotations"] == []
    finally:
        session.rollback()
        session.close()
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && uv run pytest tests/test_dataset_export.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.datasets.export'`.

- [ ] **Step 3: Implement**

Create `backend/app/datasets/export.py` with the dataclasses and functions named in the Interfaces block. Key behaviours the tests pin:

- `collect_export_items` reads the dataset's `DatasetItem` rows, joins to `Frame` and `Annotation`, and for each region annotation downloads its mask via `storage.download(...)`, decodes it with `decode_mask`, and extracts geometry once with `extract_geometry`.
- A `FileNotFoundError` (or any storage failure) on a mask becomes a `Finding(kind="missing_mask", ...)`; the loop continues so every defect is collected.
- Mask area is compared against `min_mask_area_fraction` read from `PlatformSettings` (`session.get(PlatformSettings, 1)`), multiplied by `frame.width * frame.height`. Below it, the annotation is dropped and a `Finding(kind="mask_below_threshold", detail=f"{fraction:.5f}")` recorded.
- A frame left with no entries and not `no_findings_reviewed` is omitted from the returned items — it does **not** become a negative.
- For `TaskType.CLASSIFICATION`, a frame carrying more than one classification annotation yields `Finding(kind="multi_label_classification", ...)` naming both labels in `detail`.
- Class ids are assigned by sorting distinct class names and enumerating them, so `data.yaml`'s `names` order and the integer written into every label file are derived from one list.
- `write_yolo_label` returns `""` for a negative frame, `"class cx cy w h\n"` lines for detection, and `"class x1 y1 …\n"` for segmentation, all normalized by the frame's width and height and clamped into `[0, 1]`.
- `build_coco` returns `{"info": {...}, "images": [...], "annotations": [...], "categories": [...]}` with `info` carrying `taxonomy_version`, `class_map` (name → source `label_id`s), `class_limits`, `excluded_label_ids`, `split_config`, and an ISO timestamp. Each annotation carries both `bbox` (COCO's `[x, y, w, h]`) and `segmentation` (a flat point list), plus `area`. `iscrowd` is 0.

- [ ] **Step 4: Run the tests**

Run: `cd backend && uv run pytest tests/test_dataset_export.py -v`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/datasets/export.py backend/tests/test_dataset_export.py
git commit -m "feat: assemble dataset export items, findings and serializers"
```

---

### Task 4: The export Job — archive, upload, report

**Files:**
- Modify: `backend/app/jobs/models.py` (`JobType`)
- Create: `backend/alembic/versions/<generated>_add_dataset_export_job_type.py`
- Create: `backend/app/worker/export_task.py`
- Modify: `backend/app/worker/celery_app.py` (register the task, route it)
- Modify: `backend/app/datasets/router.py` (`POST /datasets/{id}/export`)
- Modify: `backend/app/datasets/schemas.py` (`ExportRequest`)
- Modify: `openapi.json` (regenerated)
- Test: `backend/tests/test_dataset_export_task.py`

**Interfaces:**
- Consumes: everything from Task 3.
- Produces:
  - `JobType.DATASET_EXPORT = "dataset_export"`.
  - Celery task `dataset_export(job_id: int)`, registered on the `video_transcode` queue.
  - `POST /datasets/{id}/export` taking `{"include_images": bool}` (default `true`) and returning the created `Job`.

**Streaming to a temp file is required, not stylistic.** Real datasets run to gigabytes; holding an archive in a worker's memory is a failure, not slowness. `media/service.py` already uses `tempfile.NamedTemporaryFile` under the storage rule's sanctioned exception, and this follows it.

**The queue keeps its historical name.** `video_transcode` is in practice the CPU-task queue and export is CPU-only. Renaming would require changing CLAUDE.md, the documented start command, and a running worker simultaneously — and a queue-name mismatch is this project's known cause of silently dropped messages. Add `"dataset_export"` to `task_routes` explicitly rather than relying on `task_default_queue`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_dataset_export_task.py`:

```python
import io
import json
import zipfile

import app.main  # noqa: F401
import cv2
import numpy as np
import sqlalchemy as sa
from fastapi.testclient import TestClient

from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
from app.datasets.models import Dataset, DatasetItem, SplitName, TaskType
from app.db import SessionLocal
from app.jobs.models import Job, JobStatus, JobType
from app.main import app
from app.media.models import Frame, Sequence, Video
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure

client = TestClient(app)


def _register_and_login(email: str) -> dict[str, str]:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "admin"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_export_endpoint_creates_a_pending_job_without_blocking():
    headers = _register_and_login("export-api1@example.com")
    session = SessionLocal()
    try:
        user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
        dataset = Dataset(
            name="export-api1-ds", task_type=TaskType.DETECTION, taxonomy_version=1,
            split_config={"train": 70, "val": 20}, grouping_overrides={},
            excluded_label_ids=[], class_limits={}, balance_metrics={},
            created_by_id=user_id,
        )
        session.add(dataset)
        session.commit()
        dataset_id = dataset.id
    finally:
        session.close()

    response = client.post(f"/datasets/{dataset_id}/export",
                           json={"include_images": True}, headers=headers)

    assert response.status_code == 202
    body = response.json()
    assert body["job_type"] == "dataset_export"
    assert body["status"] == "pending"
    assert body["payload"]["dataset_id"] == dataset_id
    assert body["payload"]["include_images"] is True

    cleanup = SessionLocal()
    try:
        cleanup.query(Job).filter(Job.id == body["id"]).delete()
        cleanup.query(Dataset).filter(Dataset.id == dataset_id).delete()
        cleanup.commit()
    finally:
        cleanup.close()


def test_exporting_an_unknown_dataset_returns_404():
    headers = _register_and_login("export-api2@example.com")
    response = client.post("/datasets/99999999/export",
                           json={"include_images": True}, headers=headers)
    assert response.status_code == 404


def test_include_images_defaults_to_true():
    headers = _register_and_login("export-api3@example.com")
    session = SessionLocal()
    try:
        user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
        dataset = Dataset(
            name="export-api3-ds", task_type=TaskType.DETECTION, taxonomy_version=1,
            split_config={"train": 70, "val": 20}, grouping_overrides={},
            excluded_label_ids=[], class_limits={}, balance_metrics={},
            created_by_id=user_id,
        )
        session.add(dataset)
        session.commit()
        dataset_id = dataset.id
    finally:
        session.close()

    response = client.post(f"/datasets/{dataset_id}/export", json={}, headers=headers)

    assert response.status_code == 202
    assert response.json()["payload"]["include_images"] is True

    cleanup = SessionLocal()
    try:
        cleanup.query(Job).filter(Job.id == response.json()["id"]).delete()
        cleanup.query(Dataset).filter(Dataset.id == dataset_id).delete()
        cleanup.commit()
    finally:
        cleanup.close()
```

Then append the task-level tests, which drive the Celery function directly with a fake storage so no broker or MinIO is needed:

```python
class _FakeStorage:
    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.uploaded: dict[str, bytes] = {}

    def put(self, key: str, data: bytes) -> None:
        self.objects[key] = data

    def download(self, key: str) -> bytes:
        if key not in self.objects:
            raise FileNotFoundError(key)
        return self.objects[key]

    def upload(self, key: str, data: bytes, content_type: str) -> None:
        self.uploaded[key] = data


def _png(height=80, width=100, x=10, y=20, w=30, h=40):
    mask = np.zeros((height, width), dtype=np.uint8)
    mask[y : y + h, x : x + w] = 255
    return cv2.imencode(".png", mask)[1].tobytes()


def _build_dataset(session, tag, include_mask=True):
    procedure = Procedure(name=f"xt-{tag}-proc")
    session.add(procedure)
    session.flush()
    category = Category(name=f"xt-{tag}-cat", procedure_id=procedure.id)
    session.add(category)
    session.flush()
    region = EvaluationType(name=f"xt-{tag}-et", annotation_scope=AnnotationScope.REGION)
    session.add(region)
    session.flush()
    video = Video(title=f"xt-{tag}-v", storage_key=f"xt/{tag}.mp4", checksum=f"xt-{tag}",
                  fps=25.0, duration_seconds=1.0)
    session.add(video)
    session.flush()
    sequence = Sequence(name=f"xt-{tag}-seq", start_time=0, duration=1,
                        procedure_id=procedure.id, video_id=video.id)
    session.add(sequence)
    session.flush()
    frame = Frame(sequence_id=sequence.id, storage_key=f"frames/{sequence.id}/1.png",
                  frame_index=1, width=100, height=80)
    session.add(frame)
    session.flush()
    label = Label(name=f"xt-{tag}-polyp", category_id=category.id,
                  evaluation_type_id=region.id)
    session.add(label)
    session.flush()
    user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
    annotation = Annotation(
        frame_id=frame.id, label_id=label.id, taxonomy_version=label.taxonomy_version,
        annotation_type=AnnotationType.MASK, payload={}, status=AnnotationStatus.DRAFT,
        created_by_id=user_id, storage_key=f"masks/xt-{tag}.png",
    )
    session.add(annotation)
    session.flush()
    dataset = Dataset(
        name=f"xt-{tag}-ds", task_type=TaskType.DETECTION, taxonomy_version=1,
        split_config={"train": 70, "val": 20}, grouping_overrides={},
        excluded_label_ids=[], class_limits={}, balance_metrics={}, created_by_id=user_id,
    )
    session.add(dataset)
    session.flush()
    session.add(DatasetItem(dataset_id=dataset.id, frame_id=frame.id,
                            annotation_ids=[annotation.id], split=SplitName.TRAIN))
    session.flush()
    return dataset, frame, annotation, user_id


def test_the_task_writes_an_archive_with_both_formats(monkeypatch):
    from app.worker import export_task as module

    session = SessionLocal()
    try:
        dataset, frame, annotation, user_id = _build_dataset(session, "both")
        storage = _FakeStorage()
        storage.put(annotation.storage_key, _png())
        storage.put(frame.storage_key, _png())
        job = Job(job_type=JobType.DATASET_EXPORT, payload={
            "dataset_id": dataset.id, "include_images": True}, created_by_id=user_id)
        session.add(job)
        session.commit()
        job_id = job.id

        monkeypatch.setattr(module, "get_storage_service", lambda: storage)
        module.dataset_export(job_id)

        refreshed = SessionLocal()
        try:
            done = refreshed.get(Job, job_id)
            assert done.status == JobStatus.SUCCEEDED, done.error
            assert done.result_ref in storage.uploaded
            with zipfile.ZipFile(io.BytesIO(storage.uploaded[done.result_ref])) as archive:
                names = archive.namelist()
                assert "data.yaml" in names
                assert "annotations.json" in names
                assert any(n.startswith("labels/train/") for n in names)
                assert any(n.startswith("images/train/") for n in names)
                coco = json.loads(archive.read("annotations.json"))
                assert coco["info"]["taxonomy_version"] == 1
        finally:
            refreshed.close()
    finally:
        session.rollback()
        session.close()


def test_include_images_false_omits_the_images_directory(monkeypatch):
    from app.worker import export_task as module

    session = SessionLocal()
    try:
        dataset, frame, annotation, user_id = _build_dataset(session, "noimg")
        storage = _FakeStorage()
        storage.put(annotation.storage_key, _png())
        storage.put(frame.storage_key, _png())
        job = Job(job_type=JobType.DATASET_EXPORT, payload={
            "dataset_id": dataset.id, "include_images": False}, created_by_id=user_id)
        session.add(job)
        session.commit()
        job_id = job.id

        monkeypatch.setattr(module, "get_storage_service", lambda: storage)
        module.dataset_export(job_id)

        refreshed = SessionLocal()
        try:
            done = refreshed.get(Job, job_id)
            assert done.status == JobStatus.SUCCEEDED, done.error
            with zipfile.ZipFile(io.BytesIO(storage.uploaded[done.result_ref])) as archive:
                names = archive.namelist()
                assert not any(n.startswith("images/") for n in names)
                assert "annotations.json" in names
        finally:
            refreshed.close()
    finally:
        session.rollback()
        session.close()


def test_findings_abort_the_export_and_are_recorded_on_the_job(monkeypatch):
    from app.worker import export_task as module

    session = SessionLocal()
    try:
        dataset, frame, annotation, user_id = _build_dataset(session, "abort")
        storage = _FakeStorage()  # mask deliberately absent
        storage.put(frame.storage_key, _png())
        job = Job(job_type=JobType.DATASET_EXPORT, payload={
            "dataset_id": dataset.id, "include_images": True}, created_by_id=user_id)
        session.add(job)
        session.commit()
        job_id = job.id

        monkeypatch.setattr(module, "get_storage_service", lambda: storage)
        module.dataset_export(job_id)

        refreshed = SessionLocal()
        try:
            done = refreshed.get(Job, job_id)
            assert done.status == JobStatus.FAILED
            findings = done.payload["findings"]
            assert any(f["kind"] == "missing_mask" for f in findings)
            assert done.error and "finding" in done.error.lower()
        finally:
            refreshed.close()
    finally:
        session.rollback()
        session.close()
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd backend && uv run pytest tests/test_dataset_export_task.py -v`
Expected: FAIL — the `/datasets/{id}/export` route does not exist and `app.worker.export_task` is missing.

- [ ] **Step 3: Add the job type and its migration**

In `backend/app/jobs/models.py`, add to `JobType`:

```python
    DATASET_EXPORT = "dataset_export"
```

Generate a migration and add the enum value. Postgres enums need an explicit `ALTER TYPE`:

```python
def upgrade() -> None:
    op.execute("ALTER TYPE jobtype ADD VALUE IF NOT EXISTS 'DATASET_EXPORT'")


def downgrade() -> None:
    # Postgres cannot drop a value from an enum type; leaving it is harmless
    # because no row will reference it after a downgrade.
    pass
```

Note the value is the member NAME (`DATASET_EXPORT`), not its lowercase value — Postgres stores enum member names in this codebase, as `ml-worker/app/models.py` warns.

Apply it, then confirm: `docker compose exec postgres psql -U endoscopy -c "SELECT unnest(enum_range(NULL::jobtype));"` must list `DATASET_EXPORT`.

- [ ] **Step 4: Write the Celery task**

Create `backend/app/worker/export_task.py`, following `app/worker/tasks.py`'s existing shape exactly — the stale-job guard, the RUNNING/SUCCEEDED/FAILED transitions, and `SessionLocal()`:

```python
@celery_app.task(name="dataset_export")
def dataset_export(job_id: int) -> None:
    ...
```

Behaviours the tests pin:
- a missing `Job` logs and returns rather than crashing the worker (mirroring `transcode_video`);
- `collect_export_items` runs first; if any finding has an error kind (`missing_mask`, `multi_label_classification`), the job goes FAILED with `payload["findings"]` populated and a short `error` summary such as `"3 findings; export aborted"`;
- otherwise the archive is streamed into `tempfile.NamedTemporaryFile` via `zipfile.ZipFile`, then read back and uploaded with `storage.upload(key, data, "application/zip")` under `datasets/{dataset_id}/export-{timestamp}.zip`;
- warning-kind findings (`mask_below_threshold`) are still recorded in `payload["findings"]` on a SUCCEEDED job;
- `job.progress` is updated as frames are processed;
- `job.result_ref` receives the archive key.

`get_storage_service` must be imported at module level so tests can monkeypatch it on the module.

- [ ] **Step 5: Register and route the task**

In `backend/app/worker/celery_app.py`, extend the routes and import the task at the bottom alongside the existing `from app.worker import tasks`:

```python
celery_app.conf.task_routes = {
    "video_transcode": {"queue": "video_transcode"},
    # Export is CPU-only, so it shares the transcode worker rather than
    # needing a process of its own. Routed explicitly rather than relying on
    # task_default_queue: a queue-name mismatch is this project's known cause
    # of silently dropped messages.
    "dataset_export": {"queue": "video_transcode"},
}
```

- [ ] **Step 6: Add the endpoint**

In `backend/app/datasets/schemas.py`:

```python
class ExportRequest(BaseModel):
    include_images: bool = True
```

In `backend/app/datasets/router.py`, add a route returning 202 with the created `Job`, following the shape `jobs/router.py` already uses for enqueueing work — 404 when the dataset does not exist, `Job` created with `payload={"dataset_id": ..., "include_images": ...}`, then `dataset_export.delay(job.id)`.

- [ ] **Step 7: Run the tests, regenerate OpenAPI, commit**

```bash
cd backend && uv run pytest tests/test_dataset_export_task.py tests/test_datasets_api.py -v
PYTHONPATH=. uv run python scripts/export_openapi.py
git diff --stat openapi.json
git add backend/app/ backend/alembic/versions/ backend/tests/test_dataset_export_task.py openapi.json
git commit -m "feat: export a dataset archive through a background job"
```

---

### Task 5: Download button and export progress

**Files:**
- Modify: `frontend/src/entities/useDatasets.ts`
- Modify: `frontend/src/features/datasets/DatasetsTable.tsx`
- Test: `frontend/src/features/datasets/DatasetsTable.test.tsx` (append)

**Interfaces:**
- Consumes: `POST /datasets/{id}/export` and the existing `GET /jobs/{id}` polling.
- Produces: `useExportDataset()` mutation and an Export action per dataset row.

The table currently has Metrics and Delete. Export joins them: clicking it starts a job, the row shows progress while it runs, and on success turns into a download link built from the job's `result_ref`.

- [ ] **Step 1: Regenerate the client**

```bash
cd frontend && npm run generate-api
grep -c "datasets/{dataset_id}/export" src/shared/api/generated/schema.d.ts
```
Expected: non-zero. If zero, Task 4's OpenAPI regeneration did not land — stop.

- [ ] **Step 2: Write the failing tests**

Append to `frontend/src/features/datasets/DatasetsTable.test.tsx`, matching the file's existing render helper and fixture style:

```tsx
it("starts an export when the export action is used", async () => {
  const onExport = vi.fn();
  renderTable({ onExport });

  await userEvent.click(screen.getByRole("button", { name: /export/i }));

  expect(onExport).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
});

it("shows progress while an export job is running", () => {
  renderTable({ exportJobs: { 1: { status: "running", progress: 42, result_ref: null } } });
  expect(screen.getByTestId("export-progress-1")).toHaveTextContent("42");
});

it("offers a download link when an export job has succeeded", () => {
  renderTable({
    exportJobs: { 1: { status: "succeeded", progress: 100, result_ref: "datasets/1/export-x.zip" } },
  });
  expect(screen.getByTestId("export-download-1")).toBeInTheDocument();
});

it("reports a failed export instead of silently doing nothing", () => {
  renderTable({
    exportJobs: { 1: { status: "failed", progress: 0, result_ref: null, error: "3 findings; export aborted" } },
  });
  expect(screen.getByTestId("export-error-1")).toHaveTextContent(/findings/i);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd frontend && npx vitest run src/features/datasets/DatasetsTable.test.tsx`
Expected: FAIL — no export action exists.

- [ ] **Step 4: Implement**

Add `useExportDataset()` to `src/entities/useDatasets.ts`, posting to `/datasets/{dataset_id}/export` with `{ include_images: true }`.

In `DatasetsTable.tsx`, add an `Export` button per row plus optional `exportJobs` and `onExport` props. Render, per row: the button when no job is active; `data-testid="export-progress-{id}"` with the percentage while running; `data-testid="export-download-{id}"` as an anchor when succeeded; `data-testid="export-error-{id}"` with the job's error when failed. Match the neighbouring buttons' Tailwind classes exactly; dark theme only.

In `DatasetsPage.tsx`, hold the export jobs in state keyed by dataset id, start one via the mutation, and poll `GET /jobs/{id}` while any is running — the same polling the segmentation features already use.

- [ ] **Step 5: Run the suites and commit**

```bash
cd frontend && npx vitest run src/features/datasets/ && npm test
npx tsc -b --noEmit 2>&1 | grep -E "features/datasets|entities/useDatasets" | grep -v "\.test\."
git add frontend/src/entities/useDatasets.ts frontend/src/features/datasets/
git commit -m "feat: add dataset export action with progress and download"
```

---

### Task 6: Scale guard, real-archive verification, ROADMAP

**Files:**
- Test: `backend/tests/test_dataset_export_scale.py`
- Modify: `ROADMAP.md`

- [ ] **Step 1: Write the scale test**

Create `backend/tests/test_dataset_export_scale.py`. It guards the streaming design against silently regressing to build-in-memory — the one property that cannot be checked on the current 17 MB corpus:

```python
import resource
import zipfile

import app.main  # noqa: F401


def test_streaming_a_large_archive_does_not_grow_memory_linearly(tmp_path):
    """A thousand 64 KB entries is ~64 MB of payload.

    If the archive were assembled in memory, peak RSS would climb by roughly
    that much. Streaming to a file keeps the delta far below it. The
    threshold is deliberately loose -- this catches an architectural
    regression, not a few megabytes of noise.
    """
    payload = b"x" * 64 * 1024
    before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss

    archive_path = tmp_path / "big.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for index in range(1000):
            archive.writestr(f"images/train/frame_{index}.bin", payload)

    after = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    growth_mb = (after - before) / 1024

    assert archive_path.stat().st_size > 0
    assert growth_mb < 32, f"peak RSS grew {growth_mb:.1f} MB writing a ~64 MB archive"
```

Run it: `cd backend && uv run pytest tests/test_dataset_export_scale.py -v`

- [ ] **Step 2: Start the stack**

```bash
docker compose up -d
cd backend && uv run uvicorn app.main:app --port 8000
cd backend && uv run celery -A app.worker.celery_app worker --loglevel=info -Q video_transcode
cd frontend && npm run dev -- --port 5173 --strictPort
```

The `-Q video_transcode` flag is load-bearing: without it, ml-worker consumes the message and the export silently never runs.

- [ ] **Step 3: Export a real dataset and inspect the archive**

Log in as `manualcheck@example.com` / `manual-check-pass`. Create a dataset over the annotated sequences, click Export, and wait for the job to succeed. Then download the archive and verify:

```bash
unzip -l <archive>            # data.yaml, annotations.json, labels/, images/
python3 -c "
import json, sys
coco = json.load(open('annotations.json'))
print('images', len(coco['images']), 'annotations', len(coco['annotations']))
print('info keys', sorted(coco['info']))
assert coco['info']['taxonomy_version']
assert coco['info']['class_map']
"
```

Then confirm the YOLO half against a real consumer rather than our own assumptions — COCO has never been written in this project:

```bash
python3 -c "
import yaml
spec = yaml.safe_load(open('data.yaml'))
print('names', spec['names'], 'nc', spec.get('nc'))
"
```

Check that a label file's first integer indexes into `names` correctly, and that image and label stems match one-to-one.

- [ ] **Step 4: Verify the collision case on real data**

Confirm two frames from different sequences sharing an index produced two distinct archive entries — the defect that would otherwise destroy more than half the corpus. Query the dataset for such a pair first, then grep the archive listing for both names.

- [ ] **Step 5: Run both suites**

```bash
cd backend && uv run pytest -q
cd frontend && npm test
```
Report the real numbers. Backend has 16 pre-existing failures — do not fix them.

- [ ] **Step 6: Record it in ROADMAP and commit**

Add a Phase 2b entry recording: export as a `Job` on the CPU queue with streaming assembly, geometry derived from rasters because it is not in the database, both YOLO and COCO from one extraction, provenance in COCO's `info`, the `<sequence_id>_<index>` naming that prevents basename collisions, the configurable mask-area threshold, and the collect-all-findings behaviour. Note what stays deferred: training, incremental export, and archive cleanup. Follow the deviation-log style the file already uses.

```bash
git add backend/tests/test_dataset_export_scale.py ROADMAP.md
git commit -m "docs: record dataset export in ROADMAP"
```

---

## Deferred, deliberately

- **Training.** That is the Train screen, with its own `ModelVersion` model already sketched in the design spec.
- **Incremental export.** Every export rebuilds from scratch. At gigabyte scale that is noticeable, but versioned archives and deltas are their own subsystem, and building one before the pain is real would be guessing.
- **Archive cleanup.** Old exports accumulate in object storage. A retention policy needs a decision about what "old" means, which nobody has needed yet.
- **Repairing annotations during export.** The findings report gives the same practical outcome — fix everything in one batch — while the decision stays with the user. An export that quietly corrected a mask would produce a dataset diverging from what the annotation UI shows.
