from unittest.mock import MagicMock, patch

import app.tasks as tasks_module


def test_run_sam2_predict_creates_annotation_and_marks_job_succeeded():
    fake_adapter = MagicMock()
    fake_adapter.predict.return_value = MagicMock(mask_png=b"png-bytes", score=0.87)

    mock_session = MagicMock()
    mock_job = MagicMock(payload={"frame_id": 1, "label_id": 2, "prompts": []}, created_by_id=1)
    mock_frame = MagicMock(id=1, storage_key="frames/1.png")
    mock_label = MagicMock(id=2, taxonomy_version=3)

    def get_side_effect(model, pk):
        from app.models import Frame, Job
        if model is Job:
            return mock_job
        if model is Frame:
            return mock_frame
        return None

    mock_session.get.side_effect = get_side_effect

    with (
        patch.object(tasks_module, "_get_default_sam2_adapter", return_value=fake_adapter),
        patch.object(tasks_module, "_evict_sam3_models"),
        patch.object(tasks_module, "_load_label", return_value=mock_label),
        patch("app.tasks.SessionLocal", return_value=mock_session),
        patch("app.tasks.get_storage_service") as mock_get_storage,
    ):
        tasks_module.run_sam2_predict(job_id=1)

    fake_adapter.predict.assert_called_once()
    assert mock_job.status == "succeeded"
    mock_session.add.assert_called_once()
