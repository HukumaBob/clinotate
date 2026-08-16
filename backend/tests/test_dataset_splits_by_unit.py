import app.main  # noqa: F401
import collections

from app.datasets.service import assign_splits


def test_sequences_of_one_video_never_separate():
    # The real defect: video 2113 owns 2074 and 2075.
    keys = {
        2074: ("video", 2113),
        2075: ("video", 2113),
        2094: ("sequence", 2094),
        2322: ("video", 2178),
        2323: ("video", 2178),
    }
    counts = {2323: 87, 2094: 32, 2074: 29, 2322: 9, 2075: 3}

    assignment = assign_splits(list(keys), {"train": 70, "val": 20}, counts, keys)

    splits_per_unit = collections.defaultdict(set)
    for sequence_id, split in assignment.items():
        splits_per_unit[keys[sequence_id]].add(split.value)
    for unit, splits in splits_per_unit.items():
        assert len(splits) == 1, f"unit {unit} was split across {splits}"


def test_every_sequence_still_receives_a_split():
    keys = {1: ("video", 10), 2: ("video", 10), 3: ("sequence", 3)}
    assignment = assign_splits(list(keys), {"train": 70, "val": 20}, {1: 5, 2: 5, 3: 5}, keys)
    assert set(assignment) == {1, 2, 3}


def test_three_units_fill_all_three_splits():
    keys = {1: ("video", 10), 2: ("video", 10), 3: ("sequence", 3), 4: ("sequence", 4)}
    counts = {1: 50, 2: 50, 3: 30, 4: 20}
    assignment = assign_splits(list(keys), {"train": 70, "val": 20}, counts, keys)
    assert {s.value for s in assignment.values()} == {"train", "val", "test"}


def test_two_units_still_guarantee_train_and_val():
    keys = {1: ("video", 10), 2: ("sequence", 2)}
    assignment = assign_splits(list(keys), {"train": 70, "val": 20}, {1: 9, 2: 1}, keys)
    assert {s.value for s in assignment.values()} == {"train", "val"}


def test_assignment_is_deterministic_regardless_of_input_order():
    keys = {1: ("video", 10), 2: ("video", 10), 3: ("sequence", 3), 4: ("sequence", 4)}
    counts = {1: 50, 2: 50, 3: 30, 4: 20}
    forward = assign_splits([1, 2, 3, 4], {"train": 70, "val": 20}, counts, keys)
    backward = assign_splits([4, 3, 2, 1], {"train": 70, "val": 20}, counts, keys)
    assert {k: v.value for k, v in forward.items()} == {k: v.value for k, v in backward.items()}


def test_omitting_grouping_keys_treats_each_sequence_as_its_own_unit():
    # Backward compatibility for callers that have no keys handy.
    assignment = assign_splits([1, 2, 3], {"train": 70, "val": 20}, {1: 3, 2: 2, 3: 1})
    assert set(assignment) == {1, 2, 3}
    assert {s.value for s in assignment.values()} == {"train", "val", "test"}


def test_a_unit_is_ordered_by_its_total_contributed_frames():
    # The big video must reach train even though each of its sequences is
    # individually smaller than the standalone one.
    keys = {1: ("video", 10), 2: ("video", 10), 3: ("sequence", 3)}
    counts = {1: 30, 2: 30, 3: 50}  # video 10 totals 60 > 50
    assignment = assign_splits(list(keys), {"train": 70, "val": 20}, counts, keys)
    assert assignment[1].value == "train"
    assert assignment[2].value == "train"
