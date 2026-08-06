from unittest.mock import MagicMock, patch

import app.tasks as tasks_module


def test_run_sam3_predict_records_vram_usage():
    fake_adapter = MagicMock()
    fake_adapter.predict.return_value = MagicMock(mask_png=b"png-bytes", score=0.9)

    mock_session = MagicMock()
    mock_job = MagicMock(payload={"frame_id": 1, "label_id": 2, "prompts": []}, created_by_id=1)
    mock_frame = MagicMock(id=1, storage_key="frames/1.png")
    mock_label = MagicMock(id=2, taxonomy_version=1)

    def get_side_effect(model, pk):
        from app.models import Frame, Job
        if model is Job:
            return mock_job
        if model is Frame:
            return mock_frame
        return None

    mock_session.get.side_effect = get_side_effect

    with (
        patch.object(tasks_module, "_get_default_sam3_adapter", return_value=fake_adapter),
        patch.object(tasks_module, "_evict_sam2_models"),
        patch.object(tasks_module, "_load_label", return_value=mock_label),
        patch("app.tasks.SessionLocal", return_value=mock_session),
        patch("app.tasks.get_storage_service"),
        patch("torch.cuda.mem_get_info", return_value=(1_073_741_824, 8_589_934_592)),
    ):
        tasks_module.run_sam3_predict(job_id=1)

    # free=1 GiB, total=8 GiB -> used = 7 GiB
    assert mock_job.vram_used_bytes == 7_516_192_768
    assert mock_job.vram_total_bytes == 8_589_934_592


def test_run_sam3_track_records_vram_usage_per_frame():
    fake_adapter = MagicMock()
    fake_adapter.track.return_value = [
        MagicMock(mask_png=b"png-1", score=0.81),
        MagicMock(mask_png=b"png-2", score=0.82),
    ]

    mock_session = MagicMock()
    mock_job = MagicMock(
        payload={"sequence_id": 10, "label_id": 2, "prompts": []},
        created_by_id=1,
    )
    mock_label = MagicMock(id=2, taxonomy_version=1)

    all_frames = [
        MagicMock(id=100, frame_index=0, storage_key="frames/100.png"),
        MagicMock(id=101, frame_index=1, storage_key="frames/101.png"),
    ]

    def get_side_effect(model, pk):
        from app.models import Job
        if model is Job:
            return mock_job
        return None

    mock_session.get.side_effect = get_side_effect
    mock_session.query.return_value.filter.return_value.order_by.return_value.all.return_value = all_frames

    with (
        patch.object(tasks_module, "_get_default_sam3_adapter", return_value=fake_adapter),
        patch.object(tasks_module, "_evict_sam2_models"),
        patch.object(tasks_module, "_load_label", return_value=mock_label),
        patch("app.tasks.SessionLocal", return_value=mock_session),
        patch("app.tasks.get_storage_service"),
        patch("torch.cuda.mem_get_info", return_value=(3_221_225_472, 8_589_934_592)),
    ):
        tasks_module.run_sam3_track(job_id=1)

    # free=3 GiB, total=8 GiB -> used = 5 GiB
    assert mock_job.vram_used_bytes == 5_368_709_120
    assert mock_job.vram_total_bytes == 8_589_934_592
