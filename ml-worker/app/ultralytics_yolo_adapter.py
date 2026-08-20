"""The one working trainer: Ultralytics YOLO behind TrainingAdapter.

Ultralytics owns its own loop, so the three callbacks are wired through
its callback registry, a stdout/stderr capture, and a temporary logging
handler rather than being called directly the way a hand-written loop
would.
"""

import contextlib
import io
import logging
import threading
from pathlib import Path

from ultralytics import YOLO
from ultralytics.utils import LOGGER as ULTRALYTICS_LOGGER

from app.training_adapter import TrainingRequest, TrainingResult


class _LineForwardingStream(io.TextIOBase):
    """Collects written text and forwards complete lines to on_log.

    Ultralytics prints its progress table to stdout; the log is kept raw
    (a deliberate decision -- four different trainers, no common format to
    parse), so whole lines are forwarded verbatim.
    """

    def __init__(self, on_log):
        self._on_log = on_log
        self._buffer = ""
        self._lock = threading.Lock()

    def write(self, text: str) -> int:
        with self._lock:
            self._buffer += text
            while "\n" in self._buffer:
                line, self._buffer = self._buffer.split("\n", 1)
                if line.strip():
                    self._on_log(line)
        return len(text)

    def flush(self) -> None:
        with self._lock:
            if self._buffer.strip():
                self._on_log(self._buffer)
            self._buffer = ""


class _ForwardingLogHandler(logging.Handler):
    """Forwards ultralytics.utils.LOGGER records to on_log.

    Ultralytics' LOGGER is a plain stdlib logging.Logger whose
    StreamHandler is bound directly to a stream *object* at import time
    (confirmed against the installed 8.4.123 source), not looked up via
    sys.stdout each write -- so contextlib.redirect_stdout, which only
    rebinds the name `sys.stdout`, never reaches it. Epoch summaries,
    warnings, and the final metrics block all go through LOGGER.info(...),
    not print(), so without this handler they never reach on_log at all.
    Attached and removed for the duration of one train() call so a second
    run does not double-log.
    """

    def __init__(self, on_log):
        super().__init__()
        self._on_log = on_log

    def emit(self, record: logging.LogRecord) -> None:
        self._on_log(self.format(record))


# Ultralytics ships a separate pretrained checkpoint per task, and the
# suffix is part of the filename: yolo11n.pt detects, yolo11n-seg.pt
# segments, yolo11n-cls.pt classifies. Handing detection weights to a
# classification run does not fail cleanly -- it trains the wrong head.
_TASK_SUFFIX = {"segmentation": "-seg", "classification": "-cls"}


def weights_for_task(base_model: str, task_type: str) -> str:
    """Return `base_model` carrying the suffix its task requires.

    A caller that already named a task-specific checkpoint keeps it, so an
    explicit yolo11m-seg.pt is never rewritten.
    """
    suffix = _TASK_SUFFIX.get(task_type, "")
    if not suffix:
        return base_model
    stem, dot, extension = base_model.rpartition(".")
    if not dot:
        return f"{base_model}{suffix}"
    if stem.endswith(suffix):
        return base_model
    return f"{stem}{suffix}.{extension}"


class UltralyticsYoloAdapter:
    name = "ultralytics_yolo"

    def train(self, request: TrainingRequest, on_log, on_epoch, should_stop) -> TrainingResult:
        total_epochs = int(request.config.get("epochs", 1))
        model = YOLO(weights_for_task(request.base_model, request.task_type))

        # Classification reads a directory whose subfolders name the classes;
        # detection and segmentation read a data.yaml describing images/ and
        # labels/. Passing a data.yaml path for a classification run is what
        # produced the "images not found, missing path .../images/val" error.
        data_argument = (
            str(request.dataset_dir)
            if request.task_type == "classification"
            else str(request.dataset_dir / "data.yaml")
        )

        def _on_epoch_end(trainer):
            epoch = int(getattr(trainer, "epoch", 0)) + 1
            on_epoch(epoch, total_epochs)
            if should_stop():
                on_log(f"Stop requested; ending after epoch {epoch}.")
                # Ultralytics checks this flag at the top of its next
                # iteration, before that iteration's save_model() call --
                # so the epoch just completed here has already had its
                # weights written by the save_model() that preceded this
                # on_train_epoch_end callback, not by anything that runs
                # after we set the flag.
                trainer.stop = True

        model.add_callback("on_train_epoch_end", _on_epoch_end)

        stream = _LineForwardingStream(on_log)
        log_handler = _ForwardingLogHandler(on_log)
        log_handler.setFormatter(logging.Formatter("%(message)s"))
        ULTRALYTICS_LOGGER.addHandler(log_handler)
        try:
            with contextlib.redirect_stdout(stream), contextlib.redirect_stderr(stream):
                results = model.train(
                    # The dataset export archive (backend/app/worker/export_task.py's
                    # dataset_export task) writes data.yaml at the archive root,
                    # not nested under a subdirectory -- confirmed by reading that
                    # task's zipfile.writestr("data.yaml", ...) call and
                    # backend/app/datasets/export.py's images/<split>/ and
                    # labels/<split>/ layout, which data.yaml's own
                    # train/val/test entries (images/train etc.) assume sit
                    # alongside it.
                    data=data_argument,
                    epochs=total_epochs,
                    batch=int(request.config.get("batch", 8)),
                    imgsz=int(request.config.get("imgsz", 640)),
                    project=str(request.output_dir),
                    name="run",
                    exist_ok=True,
                )
        finally:
            # Exception-safe: a buffered partial final line (e.g. a CUDA
            # OOM message with no trailing newline) is often the most
            # diagnostic one in a crash, so it must reach on_log whether
            # train() succeeds or raises.
            stream.flush()
            ULTRALYTICS_LOGGER.removeHandler(log_handler)

        # Ultralytics' get_save_dir() reroutes a relative `project` through
        # SETTINGS['runs_dir'] + task + project + name rather than using it
        # as a literal base (confirmed against the installed source) -- so
        # reconstructing output_dir / "run" / "weights" / "best.pt" by hand
        # is wrong whenever output_dir isn't absolute. model.trainer.best
        # and .last are the exact Path objects Ultralytics itself resolved
        # and used to pick the checkpoint after training (see
        # engine.model.Model.train's own `ckpt = self.trainer.best if
        # self.trainer.best.exists() else self.trainer.last` selection),
        # so deriving from there is correct regardless of what path shape
        # output_dir has.
        weights_path = model.trainer.best
        if not weights_path.exists():
            weights_path = model.trainer.last

        metrics = {}
        results_dict = getattr(results, "results_dict", None)
        if isinstance(results_dict, dict):
            metrics = {str(k): v for k, v in results_dict.items() if isinstance(v, (int, float))}

        return TrainingResult(weights_path=weights_path, metrics=metrics)
