"""Imbalance-aware metrics for crop classifiers (pure numpy, no torch/DB).

Outputs are plain Python ints/floats/lists so they can be JSON-serialised
into ``TrainingResult.per_class`` / ``.confusion``.
"""

from dataclasses import dataclass
from typing import Sequence

import numpy as np


@dataclass
class Summary:
    per_class: list[dict]
    macro_f1: float
    balanced_accuracy: float
    accuracy: float
    absent: list[str]


def class_weights(counts: Sequence[int], cap: float = 10.0) -> np.ndarray:
    """Inverse-frequency weights (balanced set -> 1.0), clipped to ``cap``.

    Classes with zero count get weight 0.
    """
    c = np.asarray(counts, dtype=np.float64)
    w = np.zeros_like(c)
    present = c > 0
    if present.any():
        w[present] = np.minimum(c.sum() / (present.sum() * c[present]), cap)
    return w


def confusion_matrix(y_true, y_pred, n_classes: int) -> np.ndarray:
    """Rows = true class, columns = predicted class."""
    t = np.asarray(y_true, dtype=np.int64)
    p = np.asarray(y_pred, dtype=np.int64)
    if t.shape != p.shape:
        raise ValueError("y_true and y_pred must have the same shape")
    for a in (t, p):
        if a.size and (a.min() < 0 or a.max() >= n_classes):
            raise ValueError(f"label out of range for n_classes={n_classes}")
    cm = np.zeros((n_classes, n_classes), dtype=np.int64)
    np.add.at(cm, (t, p), 1)
    return cm


def _div(num: float, den: float) -> float:
    return float(num / den) if den > 0 else 0.0


def summarize(cm: np.ndarray, class_names: list[str]) -> Summary:
    cm = np.asarray(cm)
    tp = np.diag(cm).astype(np.float64)
    support = cm.sum(axis=1)
    predicted = cm.sum(axis=0)
    rows = []
    for i, name in enumerate(class_names):
        precision = _div(tp[i], predicted[i])
        recall = _div(tp[i], support[i])
        f1 = _div(2 * precision * recall, precision + recall)
        rows.append(
            {
                "class": name,
                "precision": precision,
                "recall": recall,
                "f1": f1,
                "support": int(support[i]),
            }
        )
    present = [r for r in rows if r["support"] > 0]
    return Summary(
        per_class=rows,
        macro_f1=_div(sum(r["f1"] for r in present), len(present)),
        balanced_accuracy=_div(sum(r["recall"] for r in present), len(present)),
        accuracy=_div(tp.sum(), cm.sum()),
        absent=[r["class"] for r in rows if r["support"] == 0],
    )


def to_result_confusion(cm: np.ndarray, class_names: list[str]) -> dict:
    return {
        "labels": list(class_names),
        "matrix": [[int(v) for v in row] for row in np.asarray(cm)],
    }
