import app.db as db_module
import app.main  # noqa: F401 -- registers every model on Base.metadata
from fastapi.testclient import TestClient

from app.inference.models import InferenceRun, InferenceRunStatus
from app.main import app
from app.training.models import ModelVersion

client = TestClient(app)


def _register_and_login(email: str) -> dict[str, str]:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "admin"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_a_run_survives_deletion_of_its_model_version(committed_inference_rows):
    """The overlay never needs the live ModelVersion: the run keeps its own
    model_name, and the FK is SET NULL rather than blocking or cascading."""
    rows = committed_inference_rows
    session = db_module.SessionLocal()
    try:
        run = InferenceRun(
            video_id=rows.video_id,
            model_version_id=rows.detect_version_id,
            model_name="seed-detection",
            frame_stride=1,
            status=InferenceRunStatus.SUCCEEDED,
            created_by_id=rows.user_id,
        )
        session.add(run)
        session.commit()
        run_id = run.id

        session.query(ModelVersion).filter(ModelVersion.id == rows.detect_version_id).delete()
        session.commit()
        session.expire_all()

        survivor = session.get(InferenceRun, run_id)
        assert survivor is not None
        assert survivor.model_version_id is None
        assert survivor.model_name == "seed-detection"
    finally:
        session.close()
