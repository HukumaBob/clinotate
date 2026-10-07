import app.db as db_module
import app.main  # noqa: F401 -- registers every model on Base.metadata
import pytest
from sqlalchemy.exc import IntegrityError

from app.inference.models import InferenceRun, InferenceRunStatus, QcFlag, QcFlagKind
from app.media.models import Frame, Sequence


def _run(session, rows) -> InferenceRun:
    run = InferenceRun(
        video_id=rows.video_id,
        model_version_id=rows.detect_version_id,
        model_name="seed-detection",
        frame_stride=5,
        status=InferenceRunStatus.SUCCEEDED,
        created_by_id=rows.user_id,
    )
    session.add(run)
    session.commit()
    return run


def _flag(run_id: int, user_id: int, frame_index: int = 5, **overrides) -> QcFlag:
    return QcFlag(
        run_id=run_id,
        kind=QcFlagKind.FP,
        frame_index=frame_index,
        timestamp_ms=frame_index * 100,
        created_by_id=user_id,
        **overrides,
    )


def test_a_frame_of_a_run_can_be_flagged_only_once(committed_inference_rows):
    rows = committed_inference_rows
    session = db_module.SessionLocal()
    try:
        run = _run(session, rows)
        session.add(_flag(run.id, rows.user_id))
        session.commit()
        session.add(_flag(run.id, rows.user_id))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()
        # A different frame of the same run is fine.
        session.add(_flag(run.id, rows.user_id, frame_index=10))
        session.commit()
    finally:
        session.close()


def test_deleting_a_run_deletes_its_flags(committed_inference_rows):
    rows = committed_inference_rows
    session = db_module.SessionLocal()
    try:
        run = _run(session, rows)
        run_id = run.id
        session.add(_flag(run_id, rows.user_id))
        session.commit()

        session.query(InferenceRun).filter(InferenceRun.id == run_id).delete()
        session.commit()

        assert session.query(QcFlag).filter(QcFlag.run_id == run_id).count() == 0
    finally:
        session.close()


def test_deleting_the_frame_keeps_the_flag_as_history(committed_inference_rows):
    rows = committed_inference_rows
    session = db_module.SessionLocal()
    try:
        run = _run(session, rows)
        sequence = Sequence(video_id=rows.video_id, name="qc", origin_qc_run_id=run.id)
        session.add(sequence)
        session.flush()
        frame = Frame(
            sequence_id=sequence.id, storage_key="frames/x/0.png", frame_index=0, width=1, height=1
        )
        session.add(frame)
        session.flush()
        flag = _flag(run.id, rows.user_id, frame_id=frame.id)
        session.add(flag)
        session.commit()
        flag_id, frame_id = flag.id, frame.id

        session.query(Frame).filter(Frame.id == frame_id).delete()
        session.commit()
        session.expire_all()

        assert session.get(QcFlag, flag_id).frame_id is None
    finally:
        session.close()


def test_a_sequence_keeps_its_origin_after_the_run_is_deleted(committed_inference_rows):
    """origin_qc_run_id has no foreign key on purpose."""
    rows = committed_inference_rows
    session = db_module.SessionLocal()
    try:
        run = _run(session, rows)
        run_id = run.id
        sequence = Sequence(video_id=rows.video_id, name="qc", origin_qc_run_id=run_id)
        session.add(sequence)
        session.commit()
        sequence_id = sequence.id

        session.query(InferenceRun).filter(InferenceRun.id == run_id).delete()
        session.commit()
        session.expire_all()

        assert session.get(Sequence, sequence_id).origin_qc_run_id == run_id
    finally:
        session.close()
