import app.main  # noqa: F401 -- registers every model on Base.metadata

from app.datasets.models import SplitName
from app.datasets.split_report import (
    SHARE_TOLERANCE_PCT,
    THIN_CELL_FRAMES,
    FrameRow,
    build_split_report,
)

TRAIN, VAL, TEST = SplitName.TRAIN, SplitName.VAL, SplitName.TEST
CONFIG = {"train": 70, "val": 20}
NAMES = {1: "caecum", 2: "colon_left", 3: "alpha"}


def _rows(unit, split, classes, frames):
    return [FrameRow(("video", unit), split, frozenset(classes)) for _ in range(frames)]


def _kinds(report, kind):
    return [w for w in report.warnings if w.kind == kind]


def _three_unit_class(test_frames=10):
    # class 1 in three units, one per part.
    return (
        _rows(1, TRAIN, {1}, 10) + _rows(2, VAL, {1}, 10) + _rows(3, TEST, {1}, test_frames)
    )


def test_constants_match_the_spec():
    assert THIN_CELL_FRAMES == 5
    assert SHARE_TOLERANCE_PCT == 15


def test_missing_in_split_for_a_part_the_class_should_reach():
    # Three units but test got none of them: a real failure.
    rows = _rows(1, TRAIN, {1}, 10) + _rows(2, VAL, {1}, 10) + _rows(3, TRAIN, {1}, 10)

    report = build_split_report(rows, NAMES, CONFIG)

    missing = _kinds(report, "missing_in_split")
    assert [(w.label_id, w.split) for w in missing] == [(1, TEST)]
    assert "caecum" in missing[0].message and "test" in missing[0].message


def test_no_missing_warning_when_every_part_has_the_class():
    report = build_split_report(_three_unit_class(), NAMES, CONFIG)

    assert _kinds(report, "missing_in_split") == []
    assert _kinds(report, "few_units") == []


def test_few_units_names_the_count_and_the_parts_left_out():
    rows = _rows(1, TRAIN, {2}, 10) + _rows(2, VAL, {2}, 10)

    report = build_split_report(rows, NAMES, CONFIG)

    few = _kinds(report, "few_units")
    assert [w.label_id for w in few] == [2]
    assert "2" in few[0].message and "test" in few[0].message
    assert "colon_left" in few[0].message


def test_expected_gap_of_a_few_units_class_is_explained_by_few_units_only():
    rows = _rows(1, TRAIN, {2}, 10) + _rows(2, VAL, {2}, 10)

    report = build_split_report(rows, NAMES, CONFIG)

    assert _kinds(report, "missing_in_split") == []


def test_one_unit_class_is_missing_val_and_test_but_only_few_units_is_reported():
    report = build_split_report(_rows(1, TRAIN, {2}, 10), NAMES, CONFIG)

    assert len(_kinds(report, "few_units")) == 1
    assert _kinds(report, "missing_in_split") == []


def test_thin_cell_under_the_limit_in_val_or_test():
    report = build_split_report(_three_unit_class(test_frames=3), NAMES, CONFIG)

    thin = _kinds(report, "thin_cell")
    assert [(w.label_id, w.split) for w in thin] == [(1, TEST)]
    assert "3" in thin[0].message


def test_cell_at_the_limit_is_not_thin():
    report = build_split_report(_three_unit_class(test_frames=5), NAMES, CONFIG)

    assert _kinds(report, "thin_cell") == []


def test_a_small_train_cell_is_not_thin():
    rows = _rows(1, TRAIN, {1}, 2) + _rows(2, VAL, {1}, 10) + _rows(3, TEST, {1}, 10)

    assert _kinds(build_split_report(rows, NAMES, CONFIG), "thin_cell") == []


def test_missing_cell_is_not_also_thin():
    rows = _rows(1, TRAIN, {1}, 10) + _rows(2, VAL, {1}, 10) + _rows(3, TRAIN, {1}, 10)

    report = build_split_report(rows, NAMES, CONFIG)

    assert _kinds(report, "thin_cell") == []
    assert len(_kinds(report, "missing_in_split")) == 1


def test_split_share_warns_beyond_the_tolerance_only():
    # 10 / 10 / 10 frames: every part is 33 %; targets 70 / 20 / 10, so train is
    # 37 points off and test 23, while val (13) is within the tolerance.
    far = build_split_report(_three_unit_class(), NAMES, CONFIG)
    assert {w.split for w in _kinds(far, "split_share")} == {TRAIN, TEST}

    # 70 / 20 / 10 frames: exactly on target.
    rows = _rows(1, TRAIN, {1}, 70) + _rows(2, VAL, {1}, 20) + _rows(3, TEST, {1}, 10)
    assert _kinds(build_split_report(rows, NAMES, CONFIG), "split_share") == []


def test_share_at_exactly_the_tolerance_does_not_warn():
    # target train 70 %, realised 55 % -> exactly 15 points off (a float-noise trap:
    # 0.7 - 0.55 is 0.15000000000000002).
    rows = _rows(1, TRAIN, {1}, 55) + _rows(2, VAL, {1}, 25) + _rows(3, TEST, {1}, 20)

    report = build_split_report(rows, NAMES, {"train": 70, "val": 20})

    assert _kinds(report, "split_share") == []


def test_share_target_uses_split_config_with_test_as_remainder():
    report = build_split_report(_three_unit_class(), NAMES, {"train": 50, "val": 30})

    assert report.totals[TRAIN].target == 0.5
    assert report.totals[VAL].target == 0.3
    assert round(report.totals[TEST].target, 6) == 0.2


def test_multi_class_frame_counts_once_per_class_and_once_in_totals():
    rows = _rows(1, TRAIN, {1, 3}, 4)

    report = build_split_report(rows, NAMES, CONFIG)

    by_id = {c.label_id: c for c in report.classes}
    assert by_id[1].cells[TRAIN].frames == 4
    assert by_id[3].cells[TRAIN].frames == 4
    assert report.totals[TRAIN].frames == 4


def test_negative_frames_count_only_in_totals():
    rows = _rows(1, TRAIN, {1}, 3) + _rows(2, TRAIN, set(), 7)

    report = build_split_report(rows, NAMES, CONFIG)

    assert report.totals[TRAIN].frames == 10
    assert report.totals[TRAIN].units == 2
    assert [c.label_id for c in report.classes] == [1]
    assert report.classes[0].cells[TRAIN] .frames == 3


def test_units_are_counted_per_cell_and_per_class():
    rows = (
        _rows(1, TRAIN, {1}, 2) + _rows(2, TRAIN, {1}, 2) + _rows(3, VAL, {1}, 2)
    )

    report = build_split_report(rows, NAMES, CONFIG)

    only = report.classes[0]
    assert only.units == 3
    assert only.cells[TRAIN].units == 2
    assert only.cells[VAL].units == 1
    assert only.cells[TEST].units == 0 and only.cells[TEST].frames == 0


def test_empty_rows_give_an_empty_report():
    report = build_split_report([], NAMES, CONFIG)

    assert report.classes == []
    assert report.warnings == []
    assert all(report.totals[p].frames == 0 and report.totals[p].share == 0 for p in (TRAIN, VAL, TEST))


def test_only_negative_frames_have_no_classes_and_no_crash():
    report = build_split_report(_rows(1, TRAIN, set(), 5), NAMES, CONFIG)

    assert report.classes == []
    assert report.totals[TRAIN].frames == 5


def test_classes_are_sorted_by_name_and_unknown_ids_get_a_fallback_name():
    rows = _rows(1, TRAIN, {1, 3, 99}, 1)

    report = build_split_report(rows, NAMES, CONFIG)

    assert [c.name for c in report.classes] == ["alpha", "caecum", "label-99"]
