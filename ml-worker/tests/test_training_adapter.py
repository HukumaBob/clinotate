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
            on_epoch(epoch, total, {"train/loss": 1.0 / epoch, "val/map50": 0.1 * epoch})
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
        on_epoch=lambda e, t, m=None: epochs.append((e, t)),
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
        on_epoch=lambda e, t, m=None: epochs.append((e, t)),
        # True from the first boundary onwards.
        should_stop=lambda: True,
    )

    assert epochs == [(1, 10)]
    assert result.metrics["epochs_completed"] == 1
    # Stopped runs still yield weights -- the boundary is after a save.
    assert result.weights_path == tmp_path / "last.pt"


class FakeSilentLoopAdapter:
    """A loop that computes no metrics -- the contract must accept None."""

    def train(self, request, on_log, on_epoch, should_stop):
        for epoch in range(1, request.config["epochs"] + 1):
            on_epoch(epoch, request.config["epochs"], None)
        return TrainingResult(weights_path=request.output_dir / "last.pt")


def test_adapter_reports_per_epoch_metrics(tmp_path):
    points: list[tuple[int, dict | None]] = []
    adapter: TrainingAdapter = FakeLoopAdapter()

    adapter.train(
        TrainingRequest(
            dataset_dir=tmp_path / "ds",
            task_type="detection",
            base_model="yolo11n.pt",
            config={"epochs": 2},
            output_dir=tmp_path,
        ),
        on_log=lambda line: None,
        on_epoch=lambda e, t, m: points.append((e, m)),
        should_stop=lambda: False,
    )

    assert [e for e, _ in points] == [1, 2]
    assert points[0][1] == {"train/loss": 1.0, "val/map50": 0.1}


def test_a_loop_that_computes_nothing_passes_none(tmp_path):
    points: list[dict | None] = []
    adapter: TrainingAdapter = FakeSilentLoopAdapter()

    adapter.train(
        TrainingRequest(
            dataset_dir=tmp_path / "ds",
            task_type="detection",
            base_model="yolo11n.pt",
            config={"epochs": 2},
            output_dir=tmp_path,
        ),
        on_log=lambda line: None,
        on_epoch=lambda e, t, m: points.append(m),
        should_stop=lambda: False,
    )

    assert points == [None, None]


def test_result_carries_optional_metric_collections(tmp_path):
    result = TrainingResult(weights_path=tmp_path / "best.pt")

    assert result.history == []
    assert result.per_class == []
    assert result.confusion is None
    assert result.artifacts == []

    filled = TrainingResult(
        weights_path=tmp_path / "best.pt",
        history=[{"epoch": 1, "loss": 0.5}],
        per_class=[{"class": "polyp", "mAP50": 0.7}],
        confusion={"labels": ["polyp", "background"], "matrix": [[5, 1], [2, 0]]},
        artifacts=[tmp_path / "results.csv"],
    )

    assert filled.confusion["labels"][-1] == "background"
