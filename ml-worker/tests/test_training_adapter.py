from pathlib import Path

from app.training_adapter import TrainingAdapter, TrainingRequest, TrainingResult


class FakeLoopAdapter:
    """Stands in for a hand-written PyTorch loop -- the shape the interface
    is designed for, not Ultralytics'."""

    def train(self, request, on_log, on_epoch, should_stop):
        total = request.config["epochs"]
        completed = 0
        for epoch in range(1, total + 1):
            on_log(f"epoch {epoch}/{total} loss 0.5")
            on_epoch(epoch, total)
            completed = epoch
            if should_stop():
                break
        return TrainingResult(
            weights_path=request.output_dir / "last.pt",
            metrics={"epochs_completed": completed},
        )


def test_adapter_reports_every_epoch_and_line(tmp_path):
    lines: list[str] = []
    epochs: list[tuple[int, int]] = []
    adapter: TrainingAdapter = FakeLoopAdapter()

    result = adapter.train(
        TrainingRequest(
            dataset_dir=tmp_path / "ds",
            task_type="detection",
            base_model="yolo11n.pt",
            config={"epochs": 3},
            output_dir=tmp_path,
        ),
        on_log=lines.append,
        on_epoch=lambda e, t: epochs.append((e, t)),
        should_stop=lambda: False,
    )

    assert epochs == [(1, 3), (2, 3), (3, 3)]
    assert len(lines) == 3
    assert result.metrics["epochs_completed"] == 3


def test_should_stop_ends_the_run_early(tmp_path):
    epochs: list[tuple[int, int]] = []
    adapter: TrainingAdapter = FakeLoopAdapter()

    result = adapter.train(
        TrainingRequest(
            dataset_dir=tmp_path / "ds",
            task_type="detection",
            base_model="yolo11n.pt",
            config={"epochs": 10},
            output_dir=tmp_path,
        ),
        on_log=lambda line: None,
        on_epoch=lambda e, t: epochs.append((e, t)),
        # True from the first boundary onwards.
        should_stop=lambda: True,
    )

    assert epochs == [(1, 10)]
    assert result.metrics["epochs_completed"] == 1
    # Stopped runs still yield weights -- the boundary is after a save.
    assert result.weights_path == tmp_path / "last.pt"
