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


class _FakeResults:
    results_dict = {"metrics/mAP50-95(B)": 0.42, "fitness": 0.5}


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
        adapter.train(request, on_log=lines.append, on_epoch=lambda e, t: None, should_stop=lambda: False)

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

    adapter.train(request, on_log=lines.append, on_epoch=lambda e, t: None, should_stop=lambda: False)

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
    adapter.train(request, on_log=lines.append, on_epoch=lambda e, t: None, should_stop=lambda: False)

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

    result = adapter.train(request, on_log=lines.append, on_epoch=lambda e, t: None, should_stop=lambda: False)

    # The adapter must report the path Ultralytics itself used (best.pt,
    # written by the fake train()), not a guess reconstructed from
    # output_dir -- the fake's save dir bears no relation to output_dir at
    # all, mirroring what get_save_dir() does to a relative project path.
    assert result.weights_path == weights_dir / "best.pt"
    assert result.weights_path.exists()
