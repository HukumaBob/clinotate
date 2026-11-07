import app.main  # noqa: F401 -- registers every model on Base.metadata
import collections

import app.db as db_module
from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
from app.auth.models import User
from app.datasets.models import DatasetItem, SplitName, TaskType
from app.datasets.schemas import DatasetCreate
from app.datasets.service import (
    build_label_tree,
    create_dataset,
    grouping_keys_for_sequences,
    plan_splits,
)
from app.media.models import Frame, Sequence, Video
from app.taxonomy.hierarchy import GroupingRules
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure

TRAIN, VAL, TEST = SplitName.TRAIN, SplitName.VAL, SplitName.TEST
CONFIG = {"train": 70, "val": 20}
NO_RULES = GroupingRules(collapse=frozenset(), expand=frozenset())


def _island(session, tag, videos, negatives=0):
    """One video + one sequence per entry of `videos`; an entry maps class name
    -> number of frames carrying it (one classification annotation per frame).
    `negatives` extra frames per video carry no annotation but are flagged
    reviewed-empty. Returns (sequence_ids, label_id_by_name, user)."""
    user = User(email=f"{tag}-user@example.com", hashed_password="x")
    procedure = Procedure(name=f"{tag}-proc")
    session.add_all([user, procedure])
    session.flush()
    category = Category(name=f"{tag}-cat", procedure_id=procedure.id)
    frame_scope = EvaluationType(name=f"{tag}-frame", annotation_scope=AnnotationScope.FRAME)
    session.add_all([category, frame_scope])
    session.flush()
    labels = {}
    for entry in videos:
        for name in entry:
            if name not in labels:
                label = Label(name=f"{tag}-{name}", category_id=category.id,
                              evaluation_type_id=frame_scope.id)
                session.add(label)
                session.flush()
                labels[name] = label
    sequence_ids = []
    for number, entry in enumerate(videos):
        video = Video(storage_key=f"{tag}-v{number}", title=f"{tag}-v{number}", checksum="x",
                      procedure_id=procedure.id)
        session.add(video)
        session.flush()
        sequence = Sequence(video_id=video.id, procedure_id=procedure.id,
                            name=f"{tag}-s{number}", start_time=0, duration=1)
        session.add(sequence)
        session.flush()
        sequence_ids.append(sequence.id)
        index = 0
        for name, count in entry.items():
            for _ in range(count):
                frame = Frame(sequence_id=sequence.id, storage_key=f"{tag}-{number}-{index}",
                              frame_index=index, width=8, height=8)
                session.add(frame)
                session.flush()
                session.add(Annotation(
                    frame_id=frame.id, label_id=labels[name].id,
                    taxonomy_version=labels[name].taxonomy_version,
                    annotation_type=AnnotationType.CLASSIFICATION, payload={},
                    status=AnnotationStatus.DRAFT, created_by_id=user.id,
                ))
                index += 1
        for _ in range(negatives):
            session.add(Frame(sequence_id=sequence.id, storage_key=f"{tag}-{number}-n{index}",
                              frame_index=index, width=8, height=8, no_findings_reviewed=True))
            index += 1
    session.flush()
    return sequence_ids, {name: label.id for name, label in labels.items()}, user


# X is in all four videos, Y only in the second-smallest two. Dealing by frame
# count alone gives Y no validation frames; class-aware assignment must.
VIDEOS = [{"X": 10}, {"X": 3, "Y": 2}, {"X": 6}, {"X": 2, "Y": 2}]


def _plan(session, sequence_ids, **extra):
    tree = build_label_tree(session)
    return plan_splits(
        session, sequence_ids, TaskType.CLASSIFICATION, NO_RULES, set(),
        extra.get("class_limits", {}), CONFIG, tree=tree,
    )


def _payload(sequence_ids, **extra):
    return DatasetCreate(name=extra.pop("name", "x"), task_type=TaskType.CLASSIFICATION,
                         sequence_ids=sequence_ids, split_config=CONFIG, **extra)


def test_create_dataset_uses_the_class_aware_assignment():
    session = db_module.SessionLocal()
    try:
        sequence_ids, label_ids, user = _island(session, "splan1", VIDEOS)

        dataset = create_dataset(session, _payload(sequence_ids, name="splan1-ds"), user)

        items = session.query(DatasetItem).filter(DatasetItem.dataset_id == dataset.id).all()
        annotations = {a.id: a for a in session.query(Annotation).filter(
            Annotation.id.in_([i.annotation_ids[0] for i in items])).all()}
        splits = collections.defaultdict(set)
        names = {lid: name for name, lid in label_ids.items()}
        for item in items:
            splits[names[annotations[item.annotation_ids[0]].label_id]].add(item.split)
        assert {TRAIN, VAL} <= splits["Y"]
        assert splits["X"] == {TRAIN, VAL, TEST}
    finally:
        session.rollback()
        session.close()


def test_preview_plan_equals_stored_split():
    session = db_module.SessionLocal()
    try:
        sequence_ids, _, user = _island(session, "splan2", VIDEOS)
        plan = _plan(session, sequence_ids)

        dataset = create_dataset(session, _payload(sequence_ids, name="splan2-ds"), user)

        stored = {}
        for item in session.query(DatasetItem).filter(DatasetItem.dataset_id == dataset.id):
            sequence_id = session.get(Frame, item.frame_id).sequence_id
            stored[sequence_id] = item.split
        assert stored == plan.assignment
        assert len(plan.rows) == sum(sum(v.values()) for v in VIDEOS)
    finally:
        session.rollback()
        session.close()


def test_class_limits_are_reflected_in_the_rows():
    session = db_module.SessionLocal()
    try:
        sequence_ids, label_ids, _ = _island(session, "splan3", VIDEOS)

        plan = _plan(session, sequence_ids, class_limits={label_ids["X"]: 4})

        with_x = [row for row in plan.rows if label_ids["X"] in row.class_ids]
        assert len(with_x) == 4
    finally:
        session.rollback()
        session.close()


def test_excluded_class_is_absent():
    session = db_module.SessionLocal()
    try:
        sequence_ids, label_ids, _ = _island(session, "splan4", VIDEOS)
        tree = build_label_tree(session)

        plan = plan_splits(
            session, sequence_ids, TaskType.CLASSIFICATION, NO_RULES, {label_ids["Y"]},
            {}, CONFIG, tree=tree,
        )

        assert all(label_ids["Y"] not in row.class_ids for row in plan.rows)
        assert label_ids["Y"] not in plan.class_names
        assert label_ids["X"] in plan.class_names
    finally:
        session.rollback()
        session.close()


def test_only_negative_frames_still_assigns():
    session = db_module.SessionLocal()
    try:
        sequence_ids, _, _ = _island(session, "splan5", [{}, {}, {}], negatives=2)

        plan = _plan(session, sequence_ids)

        assert set(plan.assignment) == set(sequence_ids)
        assert len(plan.rows) == 6
        assert all(row.class_ids == frozenset() for row in plan.rows)
        assert plan.class_names == {}
    finally:
        session.rollback()
        session.close()


def test_rows_carry_the_unit_the_assignment_used():
    session = db_module.SessionLocal()
    try:
        sequence_ids, _, _ = _island(session, "splan6", VIDEOS)
        keys = grouping_keys_for_sequences(session, sequence_ids)

        plan = _plan(session, sequence_ids)

        assert {row.unit for row in plan.rows} == set(keys.values())
    finally:
        session.rollback()
        session.close()
