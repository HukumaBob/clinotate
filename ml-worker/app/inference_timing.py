"""Aggregates of per-frame model timings, stored in the predictions document.

Only aggregates are kept: per-frame timings would grow the document by about
a third for little use beyond the summary. The numbers are model time
(preprocess, inference, postprocess including NMS); video decoding is not in
them.
"""

import math

_STAGES = ("preprocess", "inference", "postprocess")


def _stats(values: list[float]) -> dict:
    ordered = sorted(values)
    count = len(ordered)

    def percentile(p: int) -> float:
        # Nearest-rank method.
        return ordered[max(math.ceil(p / 100 * count), 1) - 1]

    return {
        "mean": round(sum(ordered) / count, 2),
        "p50": round(percentile(50), 2),
        "p95": round(percentile(95), 2),
        "max": round(ordered[-1], 2),
    }


def summarize_timing(samples: list[dict]) -> dict | None:
    """One sample per measured frame: {"preprocess", "inference", "postprocess"} in ms.

    Samples missing a stage (or carrying a non-number) are ignored. The first
    usable frame is discarded as GPU warm-up unless it is the only one.
    Returns None when nothing usable was measured.
    """
    usable = [
        sample
        for sample in samples
        if all(isinstance(sample.get(stage), (int, float)) for stage in _STAGES)
    ]
    if not usable:
        return None
    if len(usable) > 1:
        usable = usable[1:]

    totals = [sum(sample[stage] for stage in _STAGES) for sample in usable]
    mean_total = sum(totals) / len(totals)

    timing: dict = {"frames_measured": len(usable)}
    for stage in _STAGES:
        timing[f"{stage}_ms"] = _stats([sample[stage] for sample in usable])
    timing["total_ms"] = _stats(totals)
    timing["model_fps"] = round(1000 / mean_total, 1) if mean_total > 0 else 0.0
    return timing
