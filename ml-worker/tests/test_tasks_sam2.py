import io
from unittest.mock import MagicMock, patch

from PIL import Image

import app.tasks as tasks_module

def _small_frame_png_bytes() -> bytes:
    """A small real PNG (not a MagicMock) so run_sam2_track's pre-flight
    VRAM estimate -- which calls Image.open() on the first downloaded
    frame's bytes -- has something real to decode. Used by tests below
    that aren't specifically exercising the pre-flight check itself."""
    buf = io.BytesIO()
    Image.new("RGB", (64, 48)).save(buf, format="PNG")
    return buf.getvalue()


def test_estimate_track_vram_bytes_scales_with_frame_count_and_resolution():
    from app.tasks import _estimate_track_vram_bytes

    small = _estimate_track_vram_bytes(frame_count=5, width=800, height=640)
    large = _estimate_track_vram_bytes(frame_count=20, width=1920, height=1080)

    assert small > 0
    assert large > small


def test_run_sam2_track_fails_fast_without_calling_adapter_when_vram_insufficient():
    """When the pre-flight estimate exceeds free VRAM (with margin), the
    job must fail immediately and resolved_adapter.track() must never be
    called -- the whole point of this check is to avoid spending GPU time
    on a request already known to be too big."""
    fake_adapter = MagicMock()

    mock_session = MagicMock()
    mock_job = MagicMock(
        payload={
            "sequence_id": 10, "label_id": 2, "prompts": [],
            "anchor_frame_id": 101, "backward": 5, "forward": 5,
        },
        created_by_id=1,
    )
    mock_label = MagicMock(id=2, taxonomy_version=3)

    all_frames = [
        MagicMock(id=100 + i, frame_index=i, storage_key=f"frames/{100+i}.png")
        for i in range(11)
    ]

    def get_side_effect(model, pk):
        from app.models import Job
        if model is Job:
            return mock_job
        return None

    mock_session.get.side_effect = get_side_effect
    mock_session.query.return_value.filter.return_value.order_by.return_value.all.return_value = all_frames

    # A tiny 1x1 PNG so Image.open(...).size works without a real frame download.
    import io as _io

    from PIL import Image as _Image

    tiny_png = _io.BytesIO()
    _Image.new("RGB", (1920, 1080)).save(tiny_png, format="PNG")
    tiny_png_bytes = tiny_png.getvalue()

    with (
        patch.object(tasks_module, "_get_default_sam2_adapter", return_value=fake_adapter),
        patch.object(tasks_module, "_evict_sam3_models"),
        patch.object(tasks_module, "_load_label", return_value=mock_label),
        patch("app.tasks.SessionLocal", return_value=mock_session),
        patch("app.tasks.get_storage_service") as mock_get_storage,
        # Almost no free VRAM: 1 MiB free out of 8 GiB total.
        patch("torch.cuda.mem_get_info", return_value=(1_048_576, 8_589_934_592)),
    ):
        mock_get_storage.return_value.download.return_value = tiny_png_bytes
        tasks_module.run_sam2_track(job_id=1)

    fake_adapter.track.assert_not_called()
    assert mock_job.status == "failed"
    assert mock_job.error


def test_run_sam2_track_maps_results_to_correct_frame_window():
    """Non-trivial window case (mirrors the reviewer's hand-derived example):
    5 frames in the sequence, anchor in the middle, both backward and
    forward nonzero. This is exactly the shape that would catch an
    off-by-one in `frames[max(0, anchor_index - backward):anchor_index + forward + 1]`
    -- anchor_index=0 or backward=forward=0 would not, since those
    degenerate cases can't distinguish an off-by-one from the correct
    slice."""
    fake_adapter = MagicMock()
    # anchor_index=2, backward=1, forward=1 -> tracked window is frame
    # indices [1, 2, 3] (3 frames), so track() returns 3 results.
    fake_adapter.track.return_value = [
        MagicMock(mask_png=b"png-1", score=0.81),
        MagicMock(mask_png=b"png-2", score=0.82),
        MagicMock(mask_png=b"png-3", score=0.83),
    ]

    mock_session = MagicMock()
    mock_job = MagicMock(
        payload={
            "sequence_id": 10,
            "label_id": 2,
            "prompts": [],
            "anchor_frame_id": 102,  # frame_index 2
            "backward": 1,
            "forward": 1,
        },
        created_by_id=1,
    )
    mock_label = MagicMock(id=2, taxonomy_version=3)

    # 5 frames, ordered by frame_index 0..4, with distinct ids 100..104.
    all_frames = [
        MagicMock(id=100, frame_index=0, storage_key="frames/100.png"),
        MagicMock(id=101, frame_index=1, storage_key="frames/101.png"),
        MagicMock(id=102, frame_index=2, storage_key="frames/102.png"),
        MagicMock(id=103, frame_index=3, storage_key="frames/103.png"),
        MagicMock(id=104, frame_index=4, storage_key="frames/104.png"),
    ]

    def get_side_effect(model, pk):
        from app.models import Job
        if model is Job:
            return mock_job
        return None

    mock_session.get.side_effect = get_side_effect
    mock_session.query.return_value.filter.return_value.order_by.return_value.all.return_value = all_frames

    with (
        patch.object(tasks_module, "_get_default_sam2_adapter", return_value=fake_adapter),
        patch.object(tasks_module, "_evict_sam3_models"),
        patch.object(tasks_module, "_load_label", return_value=mock_label),
        patch("app.tasks.SessionLocal", return_value=mock_session),
        patch("app.tasks.get_storage_service") as mock_get_storage,
        patch("torch.cuda.mem_get_info", return_value=(4_294_967_296, 8_589_934_592)),
    ):
        mock_get_storage.return_value.download.return_value = _small_frame_png_bytes()
        tasks_module.run_sam2_track(job_id=1)

    assert mock_job.status == "succeeded"
    assert mock_session.add.call_count == 3

    created_annotations = [call.args[0] for call in mock_session.add.call_args_list]
    created_frame_ids = [a.frame_id for a in created_annotations]

    # Expected window: frames[max(0, 2-1):2+1+1] = frames[1:4] -> ids [101, 102, 103]
    assert created_frame_ids == [101, 102, 103]


def test_run_sam2_track_sets_job_id_on_every_created_annotation():
    fake_adapter = MagicMock()
    fake_adapter.track.return_value = [
        MagicMock(mask_png=b"png-1", score=0.81),
        MagicMock(mask_png=b"png-2", score=0.82),
    ]

    mock_session = MagicMock()
    mock_job = MagicMock(
        payload={
            "sequence_id": 10, "label_id": 2, "prompts": [],
            "anchor_frame_id": 101, "backward": 0, "forward": 1,
        },
        created_by_id=1,
    )
    mock_label = MagicMock(id=2, taxonomy_version=3)

    all_frames = [
        MagicMock(id=100, frame_index=0, storage_key="frames/100.png"),
        MagicMock(id=101, frame_index=1, storage_key="frames/101.png"),
        MagicMock(id=102, frame_index=2, storage_key="frames/102.png"),
    ]

    def get_side_effect(model, pk):
        from app.models import Job
        if model is Job:
            return mock_job
        return None

    mock_session.get.side_effect = get_side_effect
    mock_session.query.return_value.filter.return_value.order_by.return_value.all.return_value = all_frames

    with (
        patch.object(tasks_module, "_get_default_sam2_adapter", return_value=fake_adapter),
        patch.object(tasks_module, "_evict_sam3_models"),
        patch.object(tasks_module, "_load_label", return_value=mock_label),
        patch("app.tasks.SessionLocal", return_value=mock_session),
        patch("app.tasks.get_storage_service") as mock_get_storage,
        patch("torch.cuda.mem_get_info", return_value=(4_294_967_296, 8_589_934_592)),
    ):
        mock_get_storage.return_value.download.return_value = _small_frame_png_bytes()
        tasks_module.run_sam2_track(job_id=77)

    created_annotations = [call.args[0] for call in mock_session.add.call_args_list]
    assert all(a.job_id == 77 for a in created_annotations)


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


def test_run_sam2_predict_sets_job_id_on_created_annotation():
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
        patch("app.tasks.get_storage_service"),
    ):
        tasks_module.run_sam2_predict(job_id=42)

    created_annotation = mock_session.add.call_args.args[0]
    assert created_annotation.job_id == 42


def test_run_sam2_predict_records_vram_usage():
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
        patch("app.tasks.get_storage_service"),
        patch("torch.cuda.mem_get_info", return_value=(4_294_967_296, 8_589_934_592)),
    ):
        tasks_module.run_sam2_predict(job_id=1)

    # free=4 GiB, total=8 GiB -> used = total - free = 4 GiB
    assert mock_job.vram_used_bytes == 4_294_967_296
    assert mock_job.vram_total_bytes == 8_589_934_592


def test_run_sam2_track_records_vram_usage_per_frame():
    fake_adapter = MagicMock()
    fake_adapter.track.return_value = [
        MagicMock(mask_png=b"png-1", score=0.81),
        MagicMock(mask_png=b"png-2", score=0.82),
    ]

    mock_session = MagicMock()
    mock_job = MagicMock(
        payload={
            "sequence_id": 10, "label_id": 2, "prompts": [],
            "anchor_frame_id": 101, "backward": 0, "forward": 1,
        },
        created_by_id=1,
    )
    mock_label = MagicMock(id=2, taxonomy_version=3)

    all_frames = [
        MagicMock(id=100, frame_index=0, storage_key="frames/100.png"),
        MagicMock(id=101, frame_index=1, storage_key="frames/101.png"),
        MagicMock(id=102, frame_index=2, storage_key="frames/102.png"),
    ]

    def get_side_effect(model, pk):
        from app.models import Job
        if model is Job:
            return mock_job
        return None

    mock_session.get.side_effect = get_side_effect
    mock_session.query.return_value.filter.return_value.order_by.return_value.all.return_value = all_frames

    with (
        patch.object(tasks_module, "_get_default_sam2_adapter", return_value=fake_adapter),
        patch.object(tasks_module, "_evict_sam3_models"),
        patch.object(tasks_module, "_load_label", return_value=mock_label),
        patch("app.tasks.SessionLocal", return_value=mock_session),
        patch("app.tasks.get_storage_service") as mock_get_storage,
        patch("torch.cuda.mem_get_info", return_value=(2_147_483_648, 8_589_934_592)),
    ):
        mock_get_storage.return_value.download.return_value = _small_frame_png_bytes()
        tasks_module.run_sam2_track(job_id=1)

    # free=2 GiB, total=8 GiB -> used = 6 GiB
    assert mock_job.vram_used_bytes == 6_442_450_944
    assert mock_job.vram_total_bytes == 8_589_934_592
