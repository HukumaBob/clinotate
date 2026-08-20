"""The one working trainer: Ultralytics YOLO behind TrainingAdapter.

Ultralytics owns its own loop, so the three callbacks are wired through
its callback registry and a stdout capture rather than being called
directly the way a hand-written loop would.
"""

import contextlib
import io
import threading
from pathlib import Path

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


class UltralyticsYoloAdapter:
    name = "ultralytics_yolo"

    def train(self, request: TrainingRequest, on_log, on_epoch, should_stop) -> TrainingResult:
        from ultralytics import YOLO

        total_epochs = int(request.config.get("epochs", 1))
        model = YOLO(request.base_model)

        def _on_epoch_end(trainer):
            epoch = int(getattr(trainer, "epoch", 0)) + 1
            on_epoch(epoch, total_epochs)
            if should_stop():
                on_log(f"Stop requested; ending after epoch {epoch}.")
                # Ultralytics checks this flag at the top of its next
                # iteration -- weights for this epoch are already written.
                trainer.stop = True

        model.add_callback("on_train_epoch_end", _on_epoch_end)

        stream = _LineForwardingStream(on_log)
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
                data=str(request.dataset_dir / "data.yaml"),
                epochs=total_epochs,
                batch=int(request.config.get("batch", 8)),
                imgsz=int(request.config.get("imgsz", 640)),
                project=str(request.output_dir),
                name="run",
                exist_ok=True,
            )
        stream.flush()

        weights_path = Path(request.output_dir) / "run" / "weights" / "best.pt"
        if not weights_path.exists():
            # A stopped run has last.pt but may not have best.pt.
            weights_path = Path(request.output_dir) / "run" / "weights" / "last.pt"

        metrics = {}
        results_dict = getattr(results, "results_dict", None)
        if isinstance(results_dict, dict):
            metrics = {str(k): v for k, v in results_dict.items() if isinstance(v, (int, float))}

        return TrainingResult(weights_path=weights_path, metrics=metrics)
