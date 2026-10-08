import app.main  # noqa: F401 -- registers every model on Base.metadata
import app.db as db_module
from app.datasets.service import qc_origin_for_sequences
from app.media.models import Frame, Sequence


def _sequence(session, name, origin_qc_run_id, frame_count):
    sequence = Sequence(
        name=name, start_time=0, duration=1, origin_qc_run_id=origin_qc_run_id
    )
    session.add(sequence)
    session.flush()
    session.add_all(
        Frame(sequence_id=sequence.id, storage_key=f"{name}-{i}", frame_index=i, width=8, height=8)
        for i in range(frame_count)
    )
    session.flush()
    return sequence


def test_only_sequences_made_from_a_qc_run_are_reported():
    session = db_module.SessionLocal()
    try:
        plain = _sequence(session, "qco-plain", None, 2)
        from_qc = _sequence(session, "qco-flagged", 7, 3)

        result = qc_origin_for_sequences(session, [plain.id, from_qc.id])

        assert result == [
            {"sequence_id": from_qc.id, "run_id": 7, "frame_count": 3}
        ]
        assert qc_origin_for_sequences(session, [plain.id]) == []
        assert qc_origin_for_sequences(session, []) == []
    finally:
        session.rollback()
        session.close()
