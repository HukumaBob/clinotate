"""Frames where two runs disagree on which classes are present."""


def _names(doc: dict, detections: list[dict], threshold: float) -> set[str]:
    classes = doc["classes"]
    return {
        str(classes[d["class_id"]])
        for d in detections
        if d["confidence"] >= threshold and 0 <= d["class_id"] < len(classes)
    }


def disagreements(doc_a: dict, doc_b: dict, conf_a: float, conf_b: float) -> list[dict]:
    """Classes are compared by name: two models can number them differently.
    A frame only one document processed is skipped."""
    result = []
    for key, frame_a in doc_a["frames"].items():
        frame_b = doc_b["frames"].get(key)
        if frame_b is None:
            continue
        names_a = _names(doc_a, frame_a["detections"], conf_a)
        names_b = _names(doc_b, frame_b["detections"], conf_b)
        if names_a != names_b:
            result.append(
                {
                    "frame": int(key),
                    "timestamp_ms": int(frame_a["timestamp_ms"]),
                    "only_a": sorted(names_a - names_b),
                    "only_b": sorted(names_b - names_a),
                }
            )
    return sorted(result, key=lambda item: item["frame"])
