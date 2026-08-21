"""Focused unit coverage for the three review-round-1 fixes in
UltralyticsYoloAdapter -- none of this needs a GPU or a real training run.
A fake trainer/YOLO stands in for Ultralytics' real classes, mirroring the
exact shapes the real library uses (confirmed by reading Ultralytics
8.4.123's installed source): a plain stdlib LOGGER whose StreamHandler is
bound directly to a stream object (not looked up via sys.stdout at emit
time), and a Model.trainer with .best/.last Path attributes set after
train() returns.
"""

import logging
from pathlib import Path
from unittest import mock

import pytest

from app.training_adapter import TrainingRequest
from app.ultralytics_yolo_adapter import UltralyticsYoloAdapter


class _FakeTrainer:
    """Stands in for ultralytics.engine.trainer.BaseTrainer."""

    def __init__(self, weights_dir: Path):
        self.epoch = 0
        self.stop = False
        self.best = weights_dir / "best.pt"
        self.last = weights_dir / "last.pt"


class _FakeConfusionMatrix:
    def __init__(self):
        import numpy as np

        self.names = {0: "polyp", 1: "erosion"}
        # (nc+1, nc+1): the trailing row/column is background.
        self.matrix = np.array([[8.0, 1.0, 2.0], [0.0, 5.0, 1.0], [3.0, 2.0, 0.0]])


class _FakeResults:
    results_dict = {"metrics/mAP50-95(B)": 0.42, "fitness": 0.5}
    confusion_matrix = _FakeConfusionMatrix()

    def summary(self):
        return [
            {"Class": "polyp", "Images": 10, "Instances": 12, "Box-P": 0.8, "mAP50": 0.7},
            {"Class": "erosion", "Images": 6, "Instances": 7, "Box-P": 0.6, "mAP50": 0.5},
        ]


def _make_fake_yolo(*, epochs, weights_dir, log_lines_via_print, log_lines_via_logger, raise_error=False):
    """Builds a fake YOLO class whose train() drives the on_epoch_end
    callback, writes to stdout (like Ultralytics' progress table) and to
    ultralytics.utils.LOGGER (like Ultralytics' epoch summaries/warnings),
    and leaves a `.trainer` with real-shaped `.best`/`.last` Paths -- the
    same three things the real train() call does that this adapter must
    now handle correctly.
    """
    from ultralytics.utils import LOGGER as real_logger

    class _FakeYOLO:
        def __init__(self, base_model):
            self.base_model = base_model
            self._callbacks = {}
            self.trainer = None

        def add_callback(self, event, fn):
            self._callbacks[event] = fn

        def train(self, **kwargs):
            weights_dir.mkdir(parents=True, exist_ok=True)
            self.trainer = _FakeTrainer(weights_dir)
            on_epoch_end = self._callbacks.get("on_train_epoch_end")
            for i in range(epochs):
                self.trainer.epoch = i
                print(log_lines_via_print[i] if i < len(log_lines_via_print) else f"print line {i}")
                real_logger.info(
                    log_lines_via_logger[i] if i < len(log_lines_via_logger) else f"logger line {i}"
                )
                if on_epoch_end is not None:
                    on_epoch_end(self.trainer)
                if self.trainer.stop:
                    break
            if raise_error:
                # Simulate a mid/late-buffer crash: a partial final line
                # written but never newline-terminated, then an exception.
                print("CUDA out of memory", end="")
                raise RuntimeError("CUDA out of memory")
            self.trainer.best.write_bytes(b"fake-weights")
            return _FakeResults()

    return _FakeYOLO


def test_partial_final_line_reaches_on_log_when_train_raises(monkeypatch, tmp_path):
    """Finding 1: stream.flush() must run even when model.train() raises,
    so a buffered partial line (e.g. a CUDA OOM message with no trailing
    newline) is not silently dropped."""
    lines: list[str] = []
    fake_yolo_cls = _make_fake_yolo(
        epochs=1,
        weights_dir=tmp_path / "out" / "run" / "weights",
        log_lines_via_print=["epoch 1 progress"],
        log_lines_via_logger=["epoch 1 summary"],
        raise_error=True,
    )
    monkeypatch.setattr("app.ultralytics_yolo_adapter.YOLO", fake_yolo_cls)

    adapter = UltralyticsYoloAdapter()
    request = TrainingRequest(
        dataset_dir=tmp_path / "ds",
        task_type="detection",
        base_model="yolo11n.pt",
        config={"epochs": 1},
        output_dir=tmp_path / "out",
    )

    with pytest.raises(RuntimeError, match="CUDA out of memory"):
        adapter.train(request, on_log=lines.append, on_epoch=lambda e, t, m=None: None, should_stop=lambda: False)

    assert any("CUDA out of memory" in line for line in lines), (
        f"buffered partial line was dropped on the failure path; got {lines!r}"
    )


def test_logger_info_line_reaches_on_log_exactly_once(monkeypatch, tmp_path):
    """Finding 2: ultralytics.utils.LOGGER binds its StreamHandler directly
    to a stream object at import time, so contextlib.redirect_stdout (which
    only rebinds the *name* sys.stdout) never reaches it. LOGGER.info(...)
    lines must still reach on_log, and exactly once (not duplicated with
    the print-based capture)."""
    lines: list[str] = []
    fake_yolo_cls = _make_fake_yolo(
        epochs=2,
        weights_dir=tmp_path / "out" / "run" / "weights",
        log_lines_via_print=["progress row 1", "progress row 2"],
        log_lines_via_logger=["distinctive logger summary line", "second logger line"],
    )
    monkeypatch.setattr("app.ultralytics_yolo_adapter.YOLO", fake_yolo_cls)

    adapter = UltralyticsYoloAdapter()
    request = TrainingRequest(
        dataset_dir=tmp_path / "ds",
        task_type="detection",
        base_model="yolo11n.pt",
        config={"epochs": 2},
        output_dir=tmp_path / "out",
    )

    adapter.train(request, on_log=lines.append, on_epoch=lambda e, t, m=None: None, should_stop=lambda: False)

    logger_matches = [line for line in lines if "distinctive logger summary line" in line]
    assert len(logger_matches) == 1, f"expected exactly one match, got {logger_matches!r} in {lines!r}"
    # The print-based progress rows must still come through too.
    assert any("progress row 1" in line for line in lines)


def test_logger_handler_removed_after_run_does_not_double_log_on_second_run(monkeypatch, tmp_path):
    """Part of Finding 2's fix: the temporary handler attached to LOGGER
    must be removed afterwards, or a second run double-logs."""
    from ultralytics.utils import LOGGER as real_logger

    handlers_before = list(real_logger.handlers)

    lines: list[str] = []
    fake_yolo_cls = _make_fake_yolo(
        epochs=1,
        weights_dir=tmp_path / "out" / "run" / "weights",
        log_lines_via_print=["p"],
        log_lines_via_logger=["only once please"],
    )
    monkeypatch.setattr("app.ultralytics_yolo_adapter.YOLO", fake_yolo_cls)
    adapter = UltralyticsYoloAdapter()
    request = TrainingRequest(
        dataset_dir=tmp_path / "ds",
        task_type="detection",
        base_model="yolo11n.pt",
        config={"epochs": 1},
        output_dir=tmp_path / "out",
    )
    adapter.train(request, on_log=lines.append, on_epoch=lambda e, t, m=None: None, should_stop=lambda: False)

    assert list(real_logger.handlers) == handlers_before, "adapter left a handler attached to the shared LOGGER"


def test_relative_output_dir_still_yields_correct_weights_path(monkeypatch, tmp_path):
    """Finding 3: Ultralytics' get_save_dir() reroutes a relative `project`
    through SETTINGS['runs_dir'] + task + project + name -- it is not used
    as a literal base the way `output_dir / "run" / "weights"` assumes. The
    adapter must derive the real path from what Ultralytics itself resolved
    (model.trainer.best/.last), not reconstruct it by hand."""
    real_save_dir = tmp_path / "somewhere" / "else" / "entirely"
    weights_dir = real_save_dir / "weights"

    lines: list[str] = []
    fake_yolo_cls = _make_fake_yolo(
        epochs=1,
        weights_dir=weights_dir,
        log_lines_via_print=["p"],
        log_lines_via_logger=["l"],
    )
    monkeypatch.setattr("app.ultralytics_yolo_adapter.YOLO", fake_yolo_cls)

    adapter = UltralyticsYoloAdapter()
    # A relative output_dir -- the exact case the review flagged as unsafe.
    request = TrainingRequest(
        dataset_dir=tmp_path / "ds",
        task_type="detection",
        base_model="yolo11n.pt",
        config={"epochs": 1},
        output_dir=Path("relative_run_dir"),
    )

    result = adapter.train(request, on_log=lines.append, on_epoch=lambda e, t, m=None: None, should_stop=lambda: False)

    # The adapter must report the path Ultralytics itself used (best.pt,
    # written by the fake train()), not a guess reconstructed from
    # output_dir -- the fake's save dir bears no relation to output_dir at
    # all, mirroring what get_save_dir() does to a relative project path.
    assert result.weights_path == weights_dir / "best.pt"
    assert result.weights_path.exists()


def test_task_type_picks_the_weights_and_the_data_argument(monkeypatch, tmp_path):
    """Each task trains from its own pretrained weights and its own data shape.

    Detection weights cannot train a classifier, and YOLO classification is
    handed a DIRECTORY (its subfolder names are the classes) where detection
    and segmentation are handed a data.yaml. Running everything as detection
    made a classification run die inside Ultralytics complaining about a
    missing images/val path -- a message that says nothing about the real
    mismatch.
    """
    from app.training_adapter import TrainingRequest
    from app.ultralytics_yolo_adapter import UltralyticsYoloAdapter

    seen: dict[str, dict] = {}

    cases = [
        ("detection", "yolo11n.pt", "yolo11n.pt", True),
        ("segmentation", "yolo11n.pt", "yolo11n-seg.pt", True),
        ("classification", "yolo11n.pt", "yolo11n-cls.pt", False),
    ]

    for task_type, requested, expected_weights, expects_yaml in cases:
        captured = {}

        class _Recorder:
            def __init__(self, base_model):
                captured["base_model"] = base_model
                self._callbacks = {}
                self.trainer = _FakeTrainer(tmp_path / task_type / "weights")

            def add_callback(self, event, fn):
                self._callbacks[event] = fn

            def train(self, **kwargs):
                captured["data"] = kwargs["data"]
                self.trainer.best.parent.mkdir(parents=True, exist_ok=True)
                self.trainer.best.write_bytes(b"w")
                return _FakeResults()

        monkeypatch.setattr("app.ultralytics_yolo_adapter.YOLO", _Recorder)

        dataset_dir = tmp_path / f"ds-{task_type}"
        dataset_dir.mkdir(exist_ok=True)
        UltralyticsYoloAdapter().train(
            TrainingRequest(
                dataset_dir=dataset_dir,
                task_type=task_type,
                base_model=requested,
                config={"epochs": 1},
                output_dir=tmp_path / f"out-{task_type}",
            ),
            on_log=lambda line: None,
            on_epoch=lambda e, t, m=None: None,
            should_stop=lambda: False,
        )
        seen[task_type] = dict(captured)

    assert seen["detection"]["base_model"] == "yolo11n.pt"
    assert seen["segmentation"]["base_model"] == "yolo11n-seg.pt"
    assert seen["classification"]["base_model"] == "yolo11n-cls.pt"

    assert seen["detection"]["data"].endswith("data.yaml")
    assert seen["segmentation"]["data"].endswith("data.yaml")
    # Classification gets the directory itself, not a yaml inside it.
    assert not seen["classification"]["data"].endswith("data.yaml")
    assert seen["classification"]["data"].endswith("ds-classification")


def test_per_class_rows_keep_the_trainers_own_keys(tmp_path):
    from app.ultralytics_yolo_adapter import _per_class_rows

    rows = _per_class_rows(_FakeResults())

    assert rows[0]["class"] == "polyp"
    assert rows[0]["mAP50"] == 0.7
    assert rows[0]["Box-P"] == 0.8
    assert "Class" not in rows[0]


def test_confusion_matrix_appends_background_for_detection():
    from app.ultralytics_yolo_adapter import _confusion_from

    confusion = _confusion_from(_FakeResults(), "detection")

    assert confusion["labels"] == ["polyp", "erosion", "background"]
    assert confusion["matrix"] == [[8, 1, 2], [0, 5, 1], [3, 2, 0]]


def test_confusion_matrix_has_no_background_for_classification():
    from app.ultralytics_yolo_adapter import _confusion_from

    class _ClsResults:
        class confusion_matrix:
            import numpy as _np

            names = {0: "clean", 1: "dirty"}
            matrix = _np.array([[4.0, 1.0], [2.0, 6.0]])

    confusion = _confusion_from(_ClsResults(), "classification")

    assert confusion["labels"] == ["clean", "dirty"]
    assert confusion["matrix"] == [[4, 1], [2, 6]]


def test_confusion_is_none_when_the_trainer_supplies_none():
    from app.ultralytics_yolo_adapter import _confusion_from

    class _Bare:
        pass

    assert _confusion_from(_Bare(), "detection") is None


def test_artifacts_collect_known_extensions_and_skip_large_files(tmp_path):
    from app.ultralytics_yolo_adapter import _collect_artifacts

    run = tmp_path / "run"
    (run / "weights").mkdir(parents=True)
    (run / "results.csv").write_text("epoch,loss\n1,0.5\n")
    (run / "args.yaml").write_text("epochs: 1\n")
    (run / "confusion_matrix.png").write_bytes(b"\x89PNG fake")
    (run / "weights" / "best.pt").write_bytes(b"weights are not artifacts")
    (run / "huge.png").write_bytes(b"x" * (11 * 1024 * 1024))

    names = sorted(p.name for p in _collect_artifacts(tmp_path))

    assert names == ["args.yaml", "confusion_matrix.png", "results.csv"]


def test_train_reports_metrics_per_epoch_and_returns_collections(tmp_path):
    points: list[tuple[int, dict | None]] = []
    weights_dir = tmp_path / "out" / "run" / "weights"
    fake_yolo = _make_fake_yolo(
        epochs=2,
        weights_dir=weights_dir,
        log_lines_via_print=[],
        log_lines_via_logger=[],
    )
    (tmp_path / "out").mkdir(exist_ok=True)
    (tmp_path / "out" / "results.csv").write_text("epoch,loss\n1,0.5\n")

    adapter = UltralyticsYoloAdapter()
    request = TrainingRequest(
        dataset_dir=tmp_path / "ds",
        task_type="detection",
        base_model="yolo11n.pt",
        config={"epochs": 2},
        output_dir=tmp_path / "out",
    )

    with mock.patch("app.ultralytics_yolo_adapter.YOLO", fake_yolo):
        result = adapter.train(
            request,
            on_log=lambda line: None,
            on_epoch=lambda e, t, m: points.append((e, m)),
            should_stop=lambda: False,
        )

    # The fake trainer has no .metrics attribute, so the adapter must
    # degrade to None rather than raising.
    assert [e for e, _ in points] == [1, 2]
    assert result.per_class[0]["class"] == "polyp"
    assert result.confusion["labels"][-1] == "background"
    assert [p.name for p in result.artifacts] == ["results.csv"]
