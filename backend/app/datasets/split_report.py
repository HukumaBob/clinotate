"""Class-by-part view of a dataset split, with plain-language warnings.

Pure: no database access. Callers describe the split as one `FrameRow` per
frame (its grouping unit, the part it landed in and the classes it carries)
and get back per-class cells, per-part totals and the warnings. The same
function serves the live preview in the create form, a freshly created dataset
and a stored one, so the three can never disagree.
"""

from dataclasses import dataclass, field

from app.datasets.models import SplitName

GroupingUnit = tuple[str, int]

PARTS = (SplitName.TRAIN, SplitName.VAL, SplitName.TEST)
# A val/test cell with fewer frames than this says little about the class.
THIN_CELL_FRAMES = 5
# A part whose real share of the frames is further than this (percentage
# points) from its target is reported.
SHARE_TOLERANCE_PCT = 15


def required_parts(unit_count: int) -> tuple[SplitName, ...]:
    """The parts a class present in `unit_count` units can reach: units are
    indivisible, so 1 unit reaches train, 2 reach train and val (test is the
    part given up, because val drives model selection), 3 or more reach all."""
    return PARTS[: max(0, min(unit_count, len(PARTS)))]


@dataclass(frozen=True)
class FrameRow:
    unit: GroupingUnit
    split: SplitName
    class_ids: frozenset[int]


@dataclass
class SplitCell:
    frames: int = 0
    units: int = 0


@dataclass
class ClassSplit:
    label_id: int
    name: str
    units: int
    cells: dict[SplitName, SplitCell]


@dataclass
class SplitTotal:
    frames: int
    units: int
    share: float
    target: float


@dataclass
class SplitWarning:
    kind: str
    message: str
    label_id: int | None = None
    split: SplitName | None = None


@dataclass
class SplitReport:
    classes: list[ClassSplit] = field(default_factory=list)
    totals: dict[SplitName, SplitTotal] = field(default_factory=dict)
    warnings: list[SplitWarning] = field(default_factory=list)


def _targets(split_config: dict) -> dict[SplitName, float]:
    train = split_config.get("train", 70) / 100
    val = split_config.get("val", 20) / 100
    return {
        SplitName.TRAIN: train,
        SplitName.VAL: val,
        SplitName.TEST: max(1 - train - val, 0.0),
    }


def _plural(count: int, word: str) -> str:
    return f"{count} {word}" if count == 1 else f"{count} {word}s"


def build_split_report(
    rows: list[FrameRow], class_names: dict[int, str], split_config: dict
) -> SplitReport:
    targets = _targets(split_config)

    frames_by_part = {part: 0 for part in PARTS}
    units_by_part: dict[SplitName, set] = {part: set() for part in PARTS}
    class_frames: dict[int, dict[SplitName, int]] = {}
    class_units: dict[int, dict[SplitName, set]] = {}
    for row in rows:
        frames_by_part[row.split] += 1
        units_by_part[row.split].add(row.unit)
        for class_id in row.class_ids:
            class_frames.setdefault(class_id, {part: 0 for part in PARTS})[row.split] += 1
            class_units.setdefault(class_id, {part: set() for part in PARTS})[row.split].add(row.unit)

    total_frames = len(rows)
    totals = {
        part: SplitTotal(
            frames=frames_by_part[part],
            units=len(units_by_part[part]),
            share=frames_by_part[part] / total_frames if total_frames else 0.0,
            target=targets[part],
        )
        for part in PARTS
    }

    def name_of(class_id: int) -> str:
        return class_names.get(class_id) or f"label-{class_id}"

    classes = []
    for class_id in sorted(class_frames, key=lambda c: (name_of(c), c)):
        cells = {
            part: SplitCell(
                frames=class_frames[class_id][part], units=len(class_units[class_id][part])
            )
            for part in PARTS
        }
        all_units = set().union(*class_units[class_id].values())
        classes.append(
            ClassSplit(label_id=class_id, name=name_of(class_id), units=len(all_units), cells=cells)
        )

    warnings: list[SplitWarning] = []
    for entry in classes:
        reachable = required_parts(entry.units)
        for part in PARTS:
            cell = entry.cells[part]
            if cell.frames == 0:
                # A part the class cannot reach with this few units is explained
                # by the few_units warning below; only a part it SHOULD reach
                # is a failure of the split.
                if part in reachable:
                    warnings.append(SplitWarning(
                        "missing_in_split",
                        f"{entry.name} has no frames in {part.value}.",
                        entry.label_id, part,
                    ))
            elif part != SplitName.TRAIN and cell.frames < THIN_CELL_FRAMES:
                warnings.append(SplitWarning(
                    "thin_cell",
                    f"{entry.name} has only {_plural(cell.frames, 'frame')} in {part.value}.",
                    entry.label_id, part,
                ))
        if entry.units < len(PARTS):
            left_out = [part.value for part in PARTS if part not in reachable]
            warnings.append(SplitWarning(
                "few_units",
                f"{entry.name} comes from only {_plural(entry.units, 'source')} "
                f"(videos or photo sets), so it cannot be in {' or '.join(left_out)}.",
                entry.label_id,
            ))

    if total_frames:
        for part in PARTS:
            gap = round(abs(totals[part].share - targets[part]) * 100, 6)
            if gap > SHARE_TOLERANCE_PCT:
                warnings.append(SplitWarning(
                    "split_share",
                    f"{part.value} holds {totals[part].share * 100:.0f}% of the frames; "
                    f"the target is {targets[part] * 100:.0f}%.",
                    None, part,
                ))

    return SplitReport(classes=classes, totals=totals, warnings=warnings)
