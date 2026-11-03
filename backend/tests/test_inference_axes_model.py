import app.db as db_module
import app.main  # noqa: F401 -- registers every model on Base.metadata

from app.inference.models import InferenceRun, InferenceRunStatus
from app.inference.schemas import InferenceRunRead

AXES = [
    {
        "model_version_id": None,
        "model_name": "m",
        "name": "Anatomy",
        "category_id": None,
        "classes": ["a", "b"],
    }
]


def _run(rows, **extra) -> InferenceRun:
    return InferenceRun(
        video_id=rows.video_id,
        model_version_id=None,
        model_name="axes-test",
        frame_stride=1,
        status=InferenceRunStatus.SUCCEEDED,
        created_by_id=rows.user_id,
        **extra,
    )


def test_a_run_stores_and_returns_axes(committed_inference_rows):
    rows = committed_inference_rows
    session = db_module.SessionLocal()
    try:
        with_axes = _run(rows, axes=AXES)
        without = _run(rows)
        session.add_all([with_axes, without])
        session.commit()
        ids = (with_axes.id, without.id)
        session.expire_all()

        loaded = session.get(InferenceRun, ids[0])
        assert loaded.axes == AXES
        read = InferenceRunRead.model_validate(loaded)
        assert read.task_type == "classification"
        assert read.axes[0].name == "Anatomy"
        assert read.axes[0].classes == ["a", "b"]

        plain = InferenceRunRead.model_validate(session.get(InferenceRun, ids[1]))
        assert plain.axes is None
        assert plain.task_type is None
    finally:
        session.query(InferenceRun).filter(InferenceRun.id.in_(ids)).delete()
        session.commit()
        session.close()
