from pathlib import Path

from app.main import app  # noqa: F401  (import registers all models on Base.metadata)
from app.db import SessionLocal
from app.media.models import Frame, Sequence, Video
from app.media.service import compute_checksum, recut_sequence
from app.storage import get_storage_service

FIXTURE_VIDEO = Path(__file__).parent / "fixtures" / "tiny.mp4"


def _make_video_and_sequence(session):
    storage = get_storage_service()
    video_bytes = FIXTURE_VIDEO.read_bytes()
    checksum = compute_checksum(video_bytes)
    storage_key = f"videos/{checksum}-recut-test.mp4"
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

    sequence = Sequence(video_id=video.id, name="original cut", start_time=0, duration=2)
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

    from app.auth.models import User

    user = session.query(User).first()
    assert user is not None, "expected at least one user to exist from a prior test run"

    from app.taxonomy.models import Label

    label = session.query(Label).first()
    assert label is not None, "expected at least one label to exist from a prior test run"

    annotation = Annotation(
        frame_id=old_frame.id,
        label_id=label.id,
        taxonomy_version=1,
        annotation_type=AnnotationType.CLASSIFICATION,
        created_by_id=user.id,
    )
    session.add(annotation)
    session.commit()
    annotation_id = annotation.id

    recut_sequence(session, storage, sequence, video, start_time=0, duration=1, fps=1.0)

    assert session.get(Annotation, annotation_id) is None
    session.close()
