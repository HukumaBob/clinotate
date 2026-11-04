"""POST /media/sequences/{id}/frames/crop and .../frames/detect-crop."""

import uuid

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

import app.db as db_module
from app.annotation.models import Annotation, AnnotationType
from app.auth.models import User
from app.main import app
from app.media.models import Frame, Sequence, Video
from app.storage import get_storage_service
from app.taxonomy.models import Category, EvaluationType, Label, Procedure
from tests.tag_regions_helpers import FakeStorage, add_region, build_world

client = TestClient(app)


def _headers() -> dict[str, str]:
    email = f"frame-crop-{uuid.uuid4().hex[:8]}@example.com"
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "annotator"})
    token = client.post("/auth/login", json={"email": email, "password": "pass1234"}).json()[
        "access_token"
    ]
    return {"Authorization": f"Bearer {token}"}


def _pattern_png(width: int, height: int) -> bytes:
    """Pixel (x, y) is (B=x, G=y, R=0), so a pixel's value names where it came from."""
    image = np.zeros((height, width, 3), dtype=np.uint8)
    ys, xs = np.indices((height, width))
    image[:, :, 0] = xs % 256
    image[:, :, 1] = ys % 256
    return cv2.imencode(".png", image)[1].tobytes()


def _mask_png(width: int, height: int, box: tuple[int, int, int, int]) -> bytes:
    """White box (x0, y0, x1, y1) on black."""
    mask = np.zeros((height, width), dtype=np.uint8)
    x0, y0, x1, y1 = box
    mask[y0:y1, x0:x1] = 255
    return cv2.imencode(".png", mask)[1].tobytes()


def _decode(data: bytes, flags=cv2.IMREAD_UNCHANGED) -> np.ndarray:
    return cv2.imdecode(np.frombuffer(data, np.uint8), flags)


@pytest.fixture()
def crop_world():
    storage = FakeStorage()
    app.dependency_overrides[get_storage_service] = lambda: storage
    session = db_module.SessionLocal()
    world = build_world(session)
    world.storage = storage
    world.session = session
    for frame in world.frames_a + world.frames_b:
        frame.width, frame.height = 64, 48
        storage.objects[frame.storage_key] = _pattern_png(64, 48)
    session.commit()
    yield world
    app.dependency_overrides.pop(get_storage_service, None)
    session.rollback()
    frame_ids = [f.id for f in world.frames_a + world.frames_b]
    annotations = session.query(Annotation).filter(Annotation.frame_id.in_(frame_ids))
    annotations.filter(Annotation.source_annotation_id.isnot(None)).delete(
        synchronize_session=False
    )
    annotations.delete(synchronize_session=False)
    session.query(Frame).filter(Frame.id.in_(frame_ids)).delete(synchronize_session=False)
    session.query(Sequence).filter(
        Sequence.id.in_([world.sequence_a.id, world.sequence_b.id])
    ).delete(synchronize_session=False)
    session.query(Video).filter(Video.id == world.sequence_a.video_id).delete()
    session.query(Label).filter(Label.category_id == world.category.id).filter(
        Label.parent_label_id.isnot(None)
    ).delete(synchronize_session=False)
    session.query(Label).filter(Label.category_id == world.category.id).delete(
        synchronize_session=False
    )
    session.query(Category).filter(Category.id == world.category.id).delete()
    session.query(EvaluationType).filter(
        EvaluationType.id.in_([world.geometric.id, world.morphological.id, world.frame_scope.id])
    ).delete(synchronize_session=False)
    session.query(Procedure).filter(Procedure.id == world.procedure.id).delete()
    session.query(User).filter(User.id == world.user.id).delete()
    session.commit()
    session.close()


def _crop(world, frames, crop, dry_run=False, sequence=None):
    sequence = sequence or world.sequence_a
    return client.post(
        f"/media/sequences/{sequence.id}/frames/crop",
        headers=_headers(),
        json={"frame_ids": [f.id for f in frames], "crop": crop, "dry_run": dry_run},
    )


def _reload(world, frame):
    world.session.expire_all()
    return world.session.get(Frame, frame.id)


def test_crop_cuts_frames_to_the_requested_insets(crop_world):
    world = crop_world
    frames = world.frames_a[:2]
    old_keys = [f.storage_key for f in frames]

    response = _crop(world, frames, {"left": 25})

    assert response.status_code == 200, response.text
    assert response.json()["applied"] is True and response.json()["frames"] == 2
    for frame, old_key in zip(frames, old_keys):
        row = _reload(world, frame)
        assert (row.width, row.height) == (48, 48)
        assert row.storage_key != old_key
        data = world.storage.objects[row.storage_key]
        assert row.size_bytes == len(data)
        image = _decode(data)
        assert image.shape[:2] == (48, 48)
        assert tuple(image[0, 0]) == (16, 0, 0)  # old pixel (x=16, y=0)
        assert old_key not in world.storage.objects


def test_masks_are_cut_with_the_same_rectangle(crop_world):
    world = crop_world
    frame = world.frames_a[0]
    mask = add_region(world.session, world.storage, frame, world.polyp, world.user)
    classification = add_region(
        world.session, world.storage, frame, world.frame_label, world.user,
        annotation_type=AnnotationType.CLASSIFICATION,
    )
    old_keys = [mask.storage_key, mask.raw_mask_storage_key]
    for key in old_keys:
        world.storage.objects[key] = _mask_png(64, 48, (20, 10, 40, 30))

    response = _crop(world, [frame], {"left": 25})

    assert response.status_code == 200, response.text
    assert response.json()["annotations"] == 1  # the classification has no geometry
    world.session.expire_all()
    cut = world.session.get(Annotation, mask.id)
    for new_key, old_key in ((cut.storage_key, old_keys[0]), (cut.raw_mask_storage_key, old_keys[1])):
        assert new_key != old_key
        assert _decode(world.storage.objects[new_key]).shape[:2] == (48, 48)
        assert old_key not in world.storage.objects
    assert world.session.get(Annotation, classification.id).storage_key is None


def test_masks_clipped_counts_masks_with_pixels_in_the_removed_area(crop_world):
    world = crop_world
    inside = add_region(world.session, world.storage, world.frames_a[0], world.polyp, world.user)
    touching = add_region(world.session, world.storage, world.frames_a[1], world.polyp, world.user)
    for annotation, box in ((inside, (30, 10, 40, 20)), (touching, (2, 10, 10, 20))):
        for key in (annotation.storage_key, annotation.raw_mask_storage_key):
            world.storage.objects[key] = _mask_png(64, 48, box)

    response = _crop(world, world.frames_a[:2], {"left": 25})

    assert response.json()["masks_clipped"] == 1
    assert response.json()["annotations"] == 2  # both are still cut
    world.session.expire_all()
    for annotation in (inside, touching):
        key = world.session.get(Annotation, annotation.id).storage_key
        assert _decode(world.storage.objects[key]).shape[:2] == (48, 48)


def test_a_mixed_size_selection_uses_each_frames_own_size(crop_world):
    world = crop_world
    small, large = world.frames_a[0], world.frames_a[1]
    large.width, large.height = 128, 96
    world.storage.objects[large.storage_key] = _pattern_png(128, 96)
    world.session.commit()

    response = _crop(world, [small, large], {"left": 25, "top": 10})

    assert response.status_code == 200, response.text
    assert (_reload(world, small).width, _reload(world, small).height) == (48, 44)
    assert (_reload(world, large).width, _reload(world, large).height) == (96, 87)


def test_dry_run_reports_the_counts_and_writes_nothing(crop_world):
    world = crop_world
    frame = world.frames_a[0]
    mask = add_region(world.session, world.storage, frame, world.polyp, world.user)
    for key in (mask.storage_key, mask.raw_mask_storage_key):
        world.storage.objects[key] = _mask_png(64, 48, (2, 10, 10, 20))
    keys_before = dict(world.storage.objects)
    frame_key = frame.storage_key

    response = _crop(world, [frame], {"left": 25}, dry_run=True)

    assert response.status_code == 200, response.text
    assert response.json() == {"frames": 1, "annotations": 1, "masks_clipped": 1, "applied": False}
    assert world.storage.objects == keys_before
    assert world.storage.uploads == [] and world.storage.deleted == []
    row = _reload(world, frame)
    assert (row.storage_key, row.width, row.height) == (frame_key, 64, 48)


def test_ids_and_indexes_do_not_change(crop_world):
    world = crop_world
    frame = world.frames_a[0]
    mask = add_region(world.session, world.storage, frame, world.polyp, world.user)
    for key in (mask.storage_key, mask.raw_mask_storage_key):
        world.storage.objects[key] = _mask_png(64, 48, (30, 10, 40, 20))
    before = (frame.id, frame.frame_index, frame.sequence_id, mask.id, mask.label_id, mask.taxonomy_version)

    assert _crop(world, [frame], {"left": 25}).status_code == 200

    world.session.expire_all()
    row, annotation = world.session.get(Frame, frame.id), world.session.get(Annotation, mask.id)
    after = (row.id, row.frame_index, row.sequence_id, annotation.id, annotation.label_id, annotation.taxonomy_version)
    assert after == before
