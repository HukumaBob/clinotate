import app.main  # noqa: F401 -- ensures all models are registered on Base.metadata

from app.datasets.models import SplitName
from app.datasets.service import assign_splits


def test_three_or_more_sequences_gives_every_split_at_least_one():
    frame_counts = {1: 10, 2: 9, 3: 8, 4: 7, 5: 6, 6: 5}
    assignment = assign_splits(list(frame_counts.keys()), {"train": 80, "val": 15}, frame_counts)
    values = set(assignment.values())
    assert values == {SplitName.TRAIN, SplitName.VAL, SplitName.TEST}


def test_orders_by_descending_contributed_frame_count_not_sequence_id():
    # Sequence 99 has the fewest raw id but contributes the most frames --
    # frame-count order must win, not id order.
    frame_counts = {99: 1, 2: 2, 3: 32}
    assignment = assign_splits([99, 2, 3], {"train": 34, "val": 33}, frame_counts)
    assert assignment[3] == SplitName.TRAIN


def test_single_sequence_goes_to_train_without_crashing():
    assignment = assign_splits([5], {"train": 70, "val": 20}, {5: 10})
    assert assignment == {5: SplitName.TRAIN}


def test_two_sequences_split_between_train_and_val():
    frame_counts = {1: 10, 2: 8}
    assignment = assign_splits([1, 2], {"train": 70, "val": 20}, frame_counts)
    values = list(assignment.values())
    assert SplitName.TRAIN in values
    assert SplitName.VAL in values


def test_val_rounding_to_zero_still_gets_at_least_one_sequence():
    # 6 sequences at 80/15 -> int(6*0.15) == 0 without the guard.
    frame_counts = {i: 10 - i for i in range(6)}
    assignment = assign_splits(list(frame_counts.keys()), {"train": 80, "val": 15}, frame_counts)
    assert SplitName.VAL in assignment.values()


def test_realistic_eighteen_sequence_dataset_gets_a_nonempty_val_split():
    # Mirrors the reviewer's live repro exactly: 18 sequences, only 7 of
    # them contribute any frames at all (the rest are 0 -- unannotated for
    # this task type), and content is concentrated in the highest-id
    # sequences. Both the empty val bug (content-order fix) and the
    # rounding-to-zero bug (min-guarantee fix) must be defeated together
    # here: block-filling train with the 7 content sequences (since
    # train's quota of 12 comfortably swallows all 7) would still leave
    # val and test with zero actual frames even though they "have" a
    # sequence each -- the guarantee must bind actual content, not empty
    # sequences.
    frame_counts = {
        1975: 6, 1988: 1, 2075: 3, 2017: 1, 2185: 20, 2074: 3, 2094: 32,
        1976: 0, 1987: 0, 1989: 0, 1990: 0, 1991: 0,
        2073: 0, 2076: 0, 2077: 0, 2078: 0, 2092: 0, 2093: 0,
    }
    assignment = assign_splits(list(frame_counts.keys()), {"train": 70, "val": 20}, frame_counts)

    frames_by_split = {"train": 0, "val": 0, "test": 0}
    for sequence_id, split in assignment.items():
        frames_by_split[split.value] += frame_counts[sequence_id]

    assert frames_by_split["val"] > 0, "val split has zero actual frames"
    assert frames_by_split["test"] > 0, "test split has zero actual frames"
