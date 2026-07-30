import uuid
from pathlib import Path

from botocore.exceptions import ClientError

from app.main import app  # noqa: F401  (import registers all models on Base.metadata)
from app.db import SessionLocal
from app.media.models import Frame, Sequence, Video
from app.media.service import compute_checksum, extract_frames, recut_sequence
from app.storage import get_storage_service

FIXTURE_VIDEO = Path(__file__).parent / "fixtures" / "tiny.mp4"


def _make_video_and_sequence(session, crop_box=None):
    storage = get_storage_service()
    video_bytes = FIXTURE_VIDEO.read_bytes()
    checksum = compute_checksum(video_bytes)
    storage_key = f"videos/{checksum}-recut-test-{uuid.uuid4().hex}.mp4"
    storage.upload(storage_key, video_bytes, content_type="video/mp4")

    video = Video(
        storage_key=storage_key,
        filename="tiny.mp4",
        title="recut source",
        fps=30.0,
        duration_seconds=5.0,
        size_bytes=len(video_bytes),
        checksum=checksum,
    )
    session.add(video)
    session.commit()
    session.refresh(video)

    sequence = Sequence(
        video_id=video.id, name="original cut", start_time=0, duration=2, crop_box=crop_box
    )
    session.add(sequence)
    session.commit()
    session.refresh(sequence)

    return video, sequence


def test_recut_sequence_replaces_frames_and_updates_timing():
    session = SessionLocal()
    storage = get_storage_service()
    video, sequence = _make_video_and_sequence(session)

    original_frame = Frame(
        sequence_id=sequence.id, storage_key="frames/original/0.png",
        frame_index=0, width=10, height=10,
    )
    session.add(original_frame)
    session.commit()
    original_frame_id = original_frame.id  # captured before recut_sequence's internal commit
    # expires this instance; accessing .id after commit would try to reload the
    # now-deleted row and raise ObjectDeletedError instead of comparing IDs.

    recut_sequence(session, storage, sequence, video, start_time=0, duration=1, fps=1.0)

    session.refresh(sequence)
    assert sequence.start_time == 0
    assert sequence.duration == 1

    remaining_frames = session.query(Frame).filter(Frame.sequence_id == sequence.id).all()
    assert original_frame_id not in [f.id for f in remaining_frames]
    assert len(remaining_frames) >= 1
    session.close()


def _create_user_and_label(session):
    """Builds a minimal User + Label (with its Category/EvaluationType/Procedure
    FK chain) inline, so tests using this helper don't depend on rows left
    behind by other test files running first against a shared dev database.
    """
    from app.auth.models import User, UserRole
    from app.taxonomy.models import Category, EvaluationType, Label, Procedure

    unique = uuid.uuid4().hex[:8]

    user = User(
        email=f"recut-test-{unique}@example.com",
        hashed_password="not-a-real-hash",
        role=UserRole.ANNOTATOR,
    )
    session.add(user)

    procedure = Procedure(name=f"recut-test-procedure-{unique}")
    session.add(procedure)
    session.commit()
    session.refresh(user)
    session.refresh(procedure)

    category = Category(name=f"recut-test-category-{unique}", procedure_id=procedure.id)
    evaluation_type = EvaluationType(name=f"recut-test-evaluation-type-{unique}")
    session.add(category)
    session.add(evaluation_type)
    session.commit()
    session.refresh(category)
    session.refresh(evaluation_type)

    label = Label(
        name="recut-test-landmark",
        category_id=category.id,
        evaluation_type_id=evaluation_type.id,
        taxonomy_version=1,
    )
    session.add(label)
    session.commit()
    session.refresh(label)

    return user, label


def test_recut_sequence_deletes_annotations_on_removed_frames():
    from app.annotation.models import Annotation, AnnotationType

    session = SessionLocal()
    storage = get_storage_service()
    video, sequence = _make_video_and_sequence(session)

    old_frame = Frame(
        sequence_id=sequence.id, storage_key="frames/original/0.png",
        frame_index=0, width=10, height=10,
    )
    session.add(old_frame)
    session.commit()
    session.refresh(old_frame)

    user, label = _create_user_and_label(session)

    annotation = Annotation(
        frame_id=old_frame.id,
        label_id=label.id,
        taxonomy_version=label.taxonomy_version,
        annotation_type=AnnotationType.CLASSIFICATION,
        created_by_id=user.id,
    )
    session.add(annotation)
    session.commit()
    annotation_id = annotation.id

    recut_sequence(session, storage, sequence, video, start_time=0, duration=1, fps=1.0)

    assert session.get(Annotation, annotation_id) is None
    session.close()


def test_recut_sequence_reuses_the_persisted_crop_box():
    session = SessionLocal()
    storage = get_storage_service()
    crop_box = {"left": 20, "right": 20, "top": 10, "bottom": 10}
    video, sequence = _make_video_and_sequence(session, crop_box=crop_box)

    video_bytes = storage.download(video.storage_key)
    uncropped = extract_frames(video_bytes, sample_fps=1.0)
    assert uncropped, "fixture video should yield at least one frame"
    uncropped_width, uncropped_height = uncropped[0][2], uncropped[0][3]

    recut_sequence(session, storage, sequence, video, start_time=0, duration=1, fps=1.0)

    new_frames = (
        session.query(Frame)
        .filter(Frame.sequence_id == sequence.id)
        .order_by(Frame.frame_index)
        .all()
    )
    assert new_frames, "expected recut_sequence to produce frames"
    # A 20%+20% horizontal / 10%+10% vertical crop must shrink both dimensions
    # relative to the uncropped extraction of the same source video -- proving
    # the sequence's persisted crop_box was actually replayed, not dropped.
    assert new_frames[0].width < uncropped_width
    assert new_frames[0].height < uncropped_height
    session.close()


def test_recut_sequence_persists_a_new_crop_box_when_provided():
    from app.media.schemas import CropBox

    session = SessionLocal()
    storage = get_storage_service()
    old_crop_box = {"left": 20, "right": 20, "top": 10, "bottom": 10}
    video, sequence = _make_video_and_sequence(session, crop_box=old_crop_box)

    new_crop = CropBox(left=5, right=5, top=5, bottom=5)
    recut_sequence(session, storage, sequence, video, start_time=0, duration=1, fps=1.0, crop=new_crop)

    session.refresh(sequence)
    assert sequence.crop_box == {"left": 5.0, "right": 5.0, "top": 5.0, "bottom": 5.0}

    frames = session.query(Frame).filter(Frame.sequence_id == sequence.id).all()
    no_crop_frames = extract_frames(FIXTURE_VIDEO.read_bytes(), sample_fps=1.0)
    small_crop_frames = extract_frames(FIXTURE_VIDEO.read_bytes(), sample_fps=1.0, crop=new_crop)
    assert frames[0].width == small_crop_frames[0][2]
    assert frames[0].width != no_crop_frames[0][2]
    session.close()


def test_recut_sequence_keeps_old_crop_box_when_none_provided():
    session = SessionLocal()
    storage = get_storage_service()
    old_crop_box = {"left": 20, "right": 20, "top": 10, "bottom": 10}
    video, sequence = _make_video_and_sequence(session, crop_box=old_crop_box)

    recut_sequence(session, storage, sequence, video, start_time=0, duration=1, fps=1.0)

    session.refresh(sequence)
    assert sequence.crop_box == old_crop_box
    session.close()


def test_recut_sequence_uses_unique_storage_keys_and_deletes_old_objects():
    session = SessionLocal()
    storage = get_storage_service()
    video, sequence = _make_video_and_sequence(session)

    recut_sequence(session, storage, sequence, video, start_time=0, duration=1, fps=1.0)
    first_gen_keys = {
        frame.storage_key
        for frame in session.query(Frame).filter(Frame.sequence_id == sequence.id).all()
    }
    assert first_gen_keys, "expected first re-cut to produce frames"

    recut_sequence(session, storage, sequence, video, start_time=0, duration=1, fps=1.0)
    second_gen_keys = {
        frame.storage_key
        for frame in session.query(Frame).filter(Frame.sequence_id == sequence.id).all()
    }
    assert second_gen_keys, "expected second re-cut to produce frames"

    # The two generations must not collide on storage keys.
    assert first_gen_keys.isdisjoint(second_gen_keys)

    # The first generation's storage objects must have been deleted from
    # storage once the second re-cut committed -- not merely orphaned.
    for key in first_gen_keys:
        try:
            storage.download(key)
            raised = False
        except ClientError:
            raised = True
        assert raised, f"expected {key} to have been deleted from storage"

    session.close()
