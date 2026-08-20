import app.main  # noqa: F401 -- registers every model on Base.metadata for create_all
import sqlalchemy as sa

from app.datasets.service import grouping_key, grouping_keys_for_sequences
import app.db as db_module
from app.media.models import Sequence, Video


def test_video_backed_sequences_share_one_key():
    assert grouping_key(2113, 2074) == grouping_key(2113, 2075)


def test_a_videoless_sequence_is_its_own_key():
    assert grouping_key(None, 2094) == ("sequence", 2094)


def test_a_videoless_sequence_never_collides_with_a_video_key():
    # ("video", 7) and ("sequence", 7) must be different units even though
    # the integer is the same.
    assert grouping_key(7, 99) != grouping_key(None, 7)


def test_grouping_keys_for_sequences_maps_every_requested_id():
    session = db_module.SessionLocal()
    try:
        video = Video(title="gk-video", storage_key="gk/v.mp4", checksum="gk-checksum",
                      fps=25.0, duration_seconds=1.0)
        session.add(video)
        session.flush()
        with_video_a = Sequence(name="gk-a", start_time=0, duration=1, video_id=video.id)
        with_video_b = Sequence(name="gk-b", start_time=0, duration=1, video_id=video.id)
        without_video = Sequence(name="gk-c", start_time=0, duration=1, video_id=None)
        session.add_all([with_video_a, with_video_b, without_video])
        session.flush()

        keys = grouping_keys_for_sequences(
            session, [with_video_a.id, with_video_b.id, without_video.id]
        )

        assert keys[with_video_a.id] == keys[with_video_b.id]
        assert keys[without_video.id] == ("sequence", without_video.id)
        assert len(set(keys.values())) == 2
    finally:
        session.rollback()
        session.close()


def test_grouping_keys_for_sequences_handles_an_empty_request():
    session = db_module.SessionLocal()
    try:
        assert grouping_keys_for_sequences(session, []) == {}
    finally:
        session.close()
