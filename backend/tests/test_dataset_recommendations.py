import app.main  # noqa: F401

from app.datasets.service import BalanceReport, ClassCount, build_recommendations


def _report(classes, below, metrics, threshold=10, negatives=0):
    return BalanceReport(
        classes=classes, total_frames=sum(c.frames for c in classes),
        negative_frames=negatives, below_threshold=below,
        threshold=threshold, metrics=metrics, recommendations=[],
    )


def test_under_threshold_classes_are_named():
    report = _report(
        [ClassCount(1, "polyp", 35, 33), ClassCount(2, "ileum", 1, 1)],
        ["ileum"], {"severity": "severe_imbalance", "imbalance_ratio": 35.0},
    )
    messages = " ".join(r.message for r in build_recommendations(report, {}))
    assert "ileum" in messages


def test_severe_imbalance_suggests_focal_loss_or_weighted_sampling():
    report = _report(
        [ClassCount(1, "polyp", 35, 33), ClassCount(2, "ileum", 1, 1)],
        ["ileum"], {"severity": "severe_imbalance", "imbalance_ratio": 35.0},
    )
    kinds = {r.kind for r in build_recommendations(report, {})}
    assert "loss_weighting" in kinds


def test_a_high_ratio_suggests_capping_the_largest_class_by_name():
    report = _report(
        [ClassCount(1, "polyp", 35, 33), ClassCount(2, "ileum", 1, 1)],
        ["ileum"], {"severity": "severe_imbalance", "imbalance_ratio": 35.0},
    )
    capping = [r for r in build_recommendations(report, {}) if r.kind == "cap_largest"]
    assert capping and "polyp" in capping[0].message


def test_a_class_concentrated_in_one_unit_is_flagged():
    report = _report(
        [ClassCount(1, "polyp", 35, 33)], [], {"severity": "moderate_imbalance", "imbalance_ratio": 2.0},
    )
    recs = build_recommendations(report, {1: 1.0})
    assert any(r.kind == "single_unit_concentration" and "polyp" in r.message for r in recs)


def test_a_balanced_report_produces_no_alarming_recommendations():
    report = _report(
        [ClassCount(1, "a", 20, 20), ClassCount(2, "b", 19, 19)],
        [], {"severity": "balanced", "imbalance_ratio": 1.05},
    )
    kinds = {r.kind for r in build_recommendations(report, {1: 0.4, 2: 0.4})}
    assert "loss_weighting" not in kinds
    assert "cap_largest" not in kinds


def test_an_empty_report_produces_no_recommendations():
    report = _report([], [], {"severity": "no_data"})
    assert build_recommendations(report, {}) == []
