import app.main  # noqa: F401 -- registers every model on Base.metadata
import collections
import random
import time

from app.datasets.models import SplitName
from app.datasets.service import assign_splits, required_parts

TRAIN, VAL, TEST = SplitName.TRAIN, SplitName.VAL, SplitName.TEST
CONFIG = {"train": 70, "val": 20}

# Class ids for the anatomy-001-shaped fixture.
ANUS, CAECUM, COLON_LEFT, COLON_RIGHT, ILEUM, OUTSIDE, RECTUM, RETRO = range(1, 9)

# Five videos; units per class: anus 4, caecum 4, colon_left 2, colon_right 3,
# ileum 3, outside 4, rectum 4, retro 4 -- the real dataset's shape.
ANATOMY_UNITS = {
    1: {ANUS, CAECUM, COLON_LEFT, COLON_RIGHT, OUTSIDE, RECTUM, RETRO},
    2: {ANUS, CAECUM, COLON_LEFT, COLON_RIGHT, ILEUM, OUTSIDE, RECTUM, RETRO},
    3: {ANUS, CAECUM, COLON_RIGHT, ILEUM, OUTSIDE, RECTUM, RETRO},
    4: {ANUS, CAECUM, ILEUM, RECTUM, RETRO},
    5: {OUTSIDE},
}


def _case(unit_classes, frames=10):
    """One sequence per unit; sequence id == unit id; every class-unit cell has
    `frames` frames. Returns (sequence_ids, keys, counts, class_frames)."""
    keys = {unit: ("video", unit) for unit in unit_classes}
    class_frames = {unit: {c: frames for c in classes} for unit, classes in unit_classes.items()}
    counts = {unit: frames * len(classes) for unit, classes in unit_classes.items()}
    return list(unit_classes), keys, counts, class_frames


def _reached(assignment, class_frames):
    reached = collections.defaultdict(set)
    for sequence_id, split in assignment.items():
        for class_id in class_frames.get(sequence_id, {}):
            reached[class_id].add(split)
    return reached


def _units_per_class(keys, class_frames):
    units = collections.defaultdict(set)
    for sequence_id, classes in class_frames.items():
        for class_id in classes:
            units[class_id].add(keys[sequence_id])
    return {class_id: len(found) for class_id, found in units.items()}


def test_required_parts_by_unit_count():
    assert required_parts(0) == ()
    assert required_parts(1) == (TRAIN,)
    assert required_parts(2) == (TRAIN, VAL)
    assert required_parts(3) == (TRAIN, VAL, TEST)
    assert required_parts(9) == (TRAIN, VAL, TEST)


def test_every_required_pair_is_covered_when_feasible():
    ids, keys, counts, class_frames = _case(ANATOMY_UNITS)

    assignment = assign_splits(ids, CONFIG, counts, keys, class_frames)

    reached = _reached(assignment, class_frames)
    units = _units_per_class(keys, class_frames)
    for class_id, unit_count in units.items():
        assert set(required_parts(unit_count)) <= reached[class_id], class_id
    assert reached[COLON_RIGHT] == {TRAIN, VAL, TEST}
    assert reached[ILEUM] == {TRAIN, VAL, TEST}
    assert reached[COLON_LEFT] == {TRAIN, VAL}


def test_a_unit_is_never_split():
    keys = {1: ("video", 10), 2: ("video", 10), 3: ("video", 11), 4: ("video", 11),
            5: ("video", 12), 6: ("video", 12)}
    class_frames = {1: {1: 5}, 2: {2: 5}, 3: {1: 5}, 4: {2: 5}, 5: {1: 5, 2: 5}, 6: {1: 5}}
    counts = {sid: 10 for sid in keys}

    assignment = assign_splits(list(keys), CONFIG, counts, keys, class_frames)

    splits_per_unit = collections.defaultdict(set)
    for sequence_id, split in assignment.items():
        splits_per_unit[keys[sequence_id]].add(split)
    assert all(len(splits) == 1 for splits in splits_per_unit.values())


def test_two_unit_class_gets_train_and_val_not_test():
    ids, keys, counts, class_frames = _case(
        {1: {1, 2}, 2: {1, 2}, 3: {2}, 4: {2}}
    )

    assignment = assign_splits(ids, CONFIG, counts, keys, class_frames)

    reached = _reached(assignment, class_frames)
    assert reached[1] == {TRAIN, VAL}
    assert reached[2] == {TRAIN, VAL, TEST}


def test_one_unit_class_gets_train_only():
    ids, keys, counts, class_frames = _case({1: {1, 2}, 2: {2}, 3: {2}, 4: {2}})

    assignment = assign_splits(ids, CONFIG, counts, keys, class_frames)

    reached = _reached(assignment, class_frames)
    assert reached[1] == {TRAIN}
    assert reached[2] == {TRAIN, VAL, TEST}


def test_coverage_beats_proportions():
    # Class 2 sits in the two smallest units. Dealing by frame count alone puts
    # one in test and one in train, leaving class 2 without validation.
    keys = {1: ("video", 1), 2: ("video", 2), 3: ("video", 3), 4: ("video", 4)}
    class_frames = {1: {10: 100}, 2: {10: 50}, 3: {10: 15, 20: 15}, 4: {10: 10, 20: 10}}
    counts = {1: 100, 2: 50, 3: 30, 4: 20}
    ids = list(keys)

    old = assign_splits(ids, CONFIG, counts, keys)
    new = assign_splits(ids, CONFIG, counts, keys, class_frames)

    assert VAL not in _reached(old, class_frames)[20]
    assert {TRAIN, VAL} <= _reached(new, class_frames)[20]
    assert _reached(new, class_frames)[10] == {TRAIN, VAL, TEST}


def test_deterministic_under_input_order():
    ids, keys, counts, class_frames = _case(ANATOMY_UNITS)
    shuffled = list(ids)
    random.Random(7).shuffle(shuffled)

    first = assign_splits(ids, CONFIG, counts, keys, class_frames)
    second = assign_splits(shuffled, CONFIG, counts, keys, class_frames)

    assert first == second


def test_no_class_data_matches_the_old_dealing():
    keys = {1: ("video", 10), 2: ("video", 10), 3: ("sequence", 3), 4: ("video", 12)}
    counts = {1: 9, 2: 4, 3: 7, 4: 2}
    ids = list(keys)

    old = assign_splits(ids, CONFIG, counts, keys)

    assert assign_splits(ids, CONFIG, counts, keys, None) == old
    assert assign_splits(ids, CONFIG, counts, keys, {}) == old
    assert assign_splits(ids, CONFIG, counts, keys, {sid: {} for sid in ids}) == old


def test_photo_set_sequences_are_their_own_units():
    keys = {n: ("sequence", n) for n in range(1, 5)}
    class_frames = {1: {7: 5}, 2: {7: 5}, 3: {7: 5}, 4: {8: 5}}
    counts = {n: 5 for n in keys}

    assignment = assign_splits(list(keys), CONFIG, counts, keys, class_frames)

    assert set(assignment) == {1, 2, 3, 4}
    assert _reached(assignment, class_frames)[7] == {TRAIN, VAL, TEST}


def test_minimum_unit_guarantees_hold():
    rng = random.Random(3)
    for unit_count in range(1, 7):
        unit_classes = {n: {rng.randint(1, 3) for _ in range(2)} for n in range(1, unit_count + 1)}
        ids, keys, counts, class_frames = _case(unit_classes)

        assignment = assign_splits(ids, CONFIG, counts, keys, class_frames)

        used = set(assignment.values())
        assert TRAIN in used
        if unit_count >= 2:
            assert VAL in used
        if unit_count >= 3:
            assert TEST in used


def test_runs_fast_for_200_units():
    rng = random.Random(11)
    unit_classes = {n: set(rng.sample(range(1, 9), 3)) for n in range(1, 201)}
    ids, keys, counts, class_frames = _case(unit_classes)

    started = time.perf_counter()
    assignment = assign_splits(ids, CONFIG, counts, keys, class_frames)
    elapsed = time.perf_counter() - started

    assert elapsed < 1.0
    assert set(assignment) == set(ids)
    reached = _reached(assignment, class_frames)
    assert all(reached[class_id] == {TRAIN, VAL, TEST} for class_id in range(1, 9))


def test_large_selection_uses_local_search_to_reach_missing_part():
    # Ten units (beyond the exhaustive limit). Class 9 sits in the three smallest;
    # dealing by frame count alone leaves it without test.
    keys = {n: ("video", n) for n in range(1, 11)}
    counts = {n: 200 - 10 * n for n in keys}
    class_frames = {n: {1: counts[n]} for n in keys}
    for n in (8, 9, 10):
        class_frames[n] = {1: counts[n], 9: counts[n]}
    ids = list(keys)

    old = assign_splits(ids, CONFIG, counts, keys)
    new = assign_splits(ids, CONFIG, counts, keys, class_frames)

    assert TEST not in _reached(old, class_frames)[9]
    assert _reached(new, class_frames)[9] == {TRAIN, VAL, TEST}
    assert len(set(new.values())) == 3
