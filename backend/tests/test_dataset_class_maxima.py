import app.main  # noqa: F401 -- registers every model on Base.metadata for create_all
import math

import sqlalchemy as sa

from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
from app.datasets.models import TaskType
from app.datasets.service import compute_balance
from app.db import SessionLocal
from app.media.models import Frame, Sequence
from app.taxonomy.hierarchy import GroupingRules
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure


def _island(session, tag, frames_per_sequence=6):
    procedure = Procedure(name=f"mx-{tag}-proc")
    session.add(procedure)
    session.flush()
    category = Category(name=f"mx-{tag}-cat", procedure_id=procedure.id)
    session.add(category)
    session.flush()
    region = EvaluationType(name=f"mx-{tag}-region", annotation_scope=AnnotationScope.REGION)
    session.add(region)
    session.flush()
    sequence = Sequence(name=f"mx-{tag}-seq", start_time=0, duration=1, procedure_id=procedure.id)
    session.add(sequence)
    session.flush()
    frames = [
        Frame(sequence_id=sequence.id, storage_key=f"mx/{tag}/{i}", frame_index=i,
              width=64, height=64)
        for i in range(frames_per_sequence)
    ]
    session.add_all(frames)
    session.flush()
    user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
    return category, region, sequence, frames, user_id


def _label(session, category, evaluation_type, name):
    label = Label(name=name, category_id=category.id, evaluation_type_id=evaluation_type.id)
    session.add(label)
    session.flush()
    return label


def _annotate(session, frame, label, user_id):
    annotation = Annotation(
        frame_id=frame.id, label_id=label.id, taxonomy_version=label.taxonomy_version,
        annotation_type=AnnotationType.MASK, payload={},
        status=AnnotationStatus.DRAFT, created_by_id=user_id,
    )
    session.add(annotation)
    session.flush()
    return annotation


def test_an_unrestricted_class_reports_max_equal_to_its_actual_counts():
    session = SessionLocal()
    try:
        category, region, sequence, frames, user_id = _island(session, "plain")
        polyp = _label(session, category, region, "mx-plain-polyp")
        for frame in frames[:4]:
            _annotate(session, frame, polyp, user_id)

        report = compute_balance(session, [sequence.id], TaskType.DETECTION, GroupingRules(), set())

        entry = next(c for c in report.classes if c.name == "mx-plain-polyp")
        assert entry.instances == 4
        assert entry.max_instances == 4
        assert entry.frames == 4
        assert entry.max_frames == 4
    finally:
        session.rollback()
        session.close()


def test_an_excluded_class_still_appears_with_zero_instances_and_its_real_max():
    session = SessionLocal()
    try:
        category, region, sequence, frames, user_id = _island(session, "excl")
        polyp = _label(session, category, region, "mx-excl-polyp")
        rare = _label(session, category, region, "mx-excl-rare")
        for frame in frames[:4]:
            _annotate(session, frame, polyp, user_id)
        _annotate(session, frames[4], rare, user_id)
        _annotate(session, frames[5], rare, user_id)

        report = compute_balance(
            session, [sequence.id], TaskType.DETECTION, GroupingRules(), {rare.id}
        )

        entry = next(c for c in report.classes if c.name == "mx-excl-rare")
        assert entry.instances == 0
        assert entry.frames == 0
        assert entry.max_instances == 2
        assert entry.max_frames == 2
    finally:
        session.rollback()
        session.close()


def test_a_capped_class_reports_the_cap_and_its_uncapped_max():
    session = SessionLocal()
    try:
        category, region, sequence, frames, user_id = _island(session, "cap")
        polyp = _label(session, category, region, "mx-cap-polyp")
        for frame in frames:
            _annotate(session, frame, polyp, user_id)

        report = compute_balance(
            session, [sequence.id], TaskType.DETECTION, GroupingRules(), set(),
            class_limits={polyp.id: 2},
        )

        entry = next(c for c in report.classes if c.name == "mx-cap-polyp")
        assert entry.instances == 2
        assert entry.max_instances == 6
    finally:
        session.rollback()
        session.close()


def test_excluding_a_class_does_not_make_imbalance_ratio_infinite():
    # The specific regression zero-instance rows invite: compute_imbalance_metrics
    # divides by the smallest class, so a 0 would make min_count 0 and the ratio inf.
    session = SessionLocal()
    try:
        category, region, sequence, frames, user_id = _island(session, "inf")
        polyp = _label(session, category, region, "mx-inf-polyp")
        rare = _label(session, category, region, "mx-inf-rare")
        for frame in frames[:5]:
            _annotate(session, frame, polyp, user_id)
        _annotate(session, frames[5], rare, user_id)

        report = compute_balance(
            session, [sequence.id], TaskType.DETECTION, GroupingRules(), {rare.id}
        )

        assert math.isfinite(report.metrics["imbalance_ratio"])
        assert report.metrics["min_count"] > 0
    finally:
        session.rollback()
        session.close()


def test_an_excluded_class_is_absent_from_below_threshold():
    session = SessionLocal()
    try:
        category, region, sequence, frames, user_id = _island(session, "belowthr")
        polyp = _label(session, category, region, "mx-belowthr-polyp")
        rare = _label(session, category, region, "mx-belowthr-rare")
        for frame in frames[:5]:
            _annotate(session, frame, polyp, user_id)
        _annotate(session, frames[5], rare, user_id)

        report = compute_balance(
            session, [sequence.id], TaskType.DETECTION, GroupingRules(), {rare.id}, threshold=10
        )

        assert "mx-belowthr-rare" not in report.below_threshold
        assert "mx-belowthr-polyp" in report.below_threshold
    finally:
        session.rollback()
        session.close()


def test_total_frames_reflects_the_effective_composition_not_the_uncapped_one():
    session = SessionLocal()
    try:
        category, region, sequence, frames, user_id = _island(session, "totals")
        polyp = _label(session, category, region, "mx-totals-polyp")
        rare = _label(session, category, region, "mx-totals-rare")
        for frame in frames[:4]:
            _annotate(session, frame, polyp, user_id)
        _annotate(session, frames[4], rare, user_id)

        full = compute_balance(session, [sequence.id], TaskType.DETECTION, GroupingRules(), set())
        excluded = compute_balance(
            session, [sequence.id], TaskType.DETECTION, GroupingRules(), {rare.id}
        )

        assert full.total_frames == 5
        assert excluded.total_frames == 4
    finally:
        session.rollback()
        session.close()
