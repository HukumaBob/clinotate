import math

import app.main  # noqa: F401 -- registers every model on Base.metadata for create_all
from app.datasets.service import compute_imbalance_metrics


def test_perfectly_balanced_classes_report_ratio_one_and_zero_gini():
    metrics = compute_imbalance_metrics({"a": 10, "b": 10, "c": 10})
    assert metrics["imbalance_ratio"] == 1.0
    assert metrics["gini_index"] < 1e-9
    assert metrics["severity"] == "balanced"


def test_severity_thresholds_match_the_reference_scale():
    assert compute_imbalance_metrics({"a": 10, "b": 10})["severity"] == "balanced"
    assert compute_imbalance_metrics({"a": 30, "b": 12})["severity"] == "mild_imbalance"
    assert compute_imbalance_metrics({"a": 100, "b": 15})["severity"] == "moderate_imbalance"
    # min_count < 10 forces at least severe, even when the ratio looks tame.
    assert compute_imbalance_metrics({"a": 20, "b": 9})["severity"] == "severe_imbalance"


def test_real_polyp_distribution_is_severe_both_grouped_and_ungrouped():
    # The measured fact behind the spec's decision to lead with an absolute
    # threshold: collapsing polyps makes the RATIO worse, not better, because
    # imbalance is measured against the smallest class.
    leaves = {
        "0-Ip": 16, "0-Is": 14, "flat_IIa": 3, "lst_g": 1, "lst_ng": 1,
        "colon_adenoma": 8, "colono_ssl": 1, "foam": 2, "sheath": 1,
        "cap": 1, "valvula": 1, "ileum": 1,
    }
    grouped = {
        "polyp": 35, "colon_adenoma": 8, "colono_ssl": 1, "foam": 2,
        "sheath": 1, "cap": 1, "valvula": 1, "ileum": 1,
    }
    leaves_metrics = compute_imbalance_metrics(leaves)
    grouped_metrics = compute_imbalance_metrics(grouped)

    assert leaves_metrics["severity"] == "severe_imbalance"
    assert grouped_metrics["severity"] == "severe_imbalance"
    assert grouped_metrics["imbalance_ratio"] > leaves_metrics["imbalance_ratio"]


def test_single_class_is_degenerate_but_does_not_crash():
    metrics = compute_imbalance_metrics({"only": 7})
    assert metrics["imbalance_ratio"] == 1.0
    assert metrics["normalized_entropy"] == 0.0
    assert not math.isnan(metrics["gini_index"])


def test_empty_input_returns_no_data():
    metrics = compute_imbalance_metrics({})
    assert metrics["severity"] == "no_data"


import sqlalchemy as sa

from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
from app.datasets.models import TaskType
from app.datasets.service import compute_balance
from app.db import SessionLocal
from app.media.models import Frame, Sequence
from app.taxonomy.hierarchy import GroupingRules
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure


def _fixture(session, tag):
    procedure = Procedure(name=f"bal-{tag}-proc")
    session.add(procedure)
    session.flush()
    category = Category(name=f"bal-{tag}-cat", procedure_id=procedure.id)
    session.add(category)
    session.flush()
    region = EvaluationType(name=f"bal-{tag}-region", annotation_scope=AnnotationScope.REGION)
    session.add(region)
    session.flush()
    sequence = Sequence(name=f"bal-{tag}-seq", start_time=0, duration=1, procedure_id=procedure.id)
    session.add(sequence)
    session.flush()
    # NB: the column is `frame_index`, not `index`; width/height are required.
    frames = [
        Frame(sequence_id=sequence.id, storage_key=f"b{i}", frame_index=i, width=64, height=64)
        for i in range(4)
    ]
    session.add_all(frames)
    session.flush()
    user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
    return category, region, sequence, frames, user_id


def _label(session, category, evaluation_type, name, parent_id=None, is_abstract=False):
    label = Label(
        name=name, category_id=category.id, evaluation_type_id=evaluation_type.id,
        parent_label_id=parent_id, is_abstract=is_abstract,
    )
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


def test_two_annotations_of_one_class_on_one_frame_count_as_two_instances_one_frame():
    session = SessionLocal()
    try:
        category, region, sequence, frames, user_id = _fixture(session, "dup")
        adenoma = _label(session, category, region, "bal-dup-adenoma")
        _annotate(session, frames[0], adenoma, user_id)
        _annotate(session, frames[0], adenoma, user_id)

        report = compute_balance(session, [sequence.id], TaskType.DETECTION, GroupingRules(), set())

        counts = {c.name: c for c in report.classes}
        assert counts["bal-dup-adenoma"].instances == 2
        assert counts["bal-dup-adenoma"].frames == 1
    finally:
        session.rollback()
        session.close()


def test_collapsing_a_parent_merges_its_children_into_one_class():
    session = SessionLocal()
    try:
        category, region, sequence, frames, user_id = _fixture(session, "grp")
        polyp = _label(session, category, region, "bal-grp-polyp", is_abstract=True)
        ip = _label(session, category, region, "bal-grp-ip", parent_id=polyp.id)
        is_ = _label(session, category, region, "bal-grp-is", parent_id=polyp.id)
        _annotate(session, frames[0], ip, user_id)
        _annotate(session, frames[1], is_, user_id)

        collapsed = compute_balance(
            session, [sequence.id], TaskType.DETECTION, GroupingRules(), set()
        )
        expanded = compute_balance(
            session, [sequence.id], TaskType.DETECTION,
            GroupingRules(expand=frozenset({polyp.id})), set(),
        )

        assert {c.name for c in collapsed.classes} == {"bal-grp-polyp"}
        assert collapsed.classes[0].instances == 2
        assert {c.name for c in expanded.classes} == {"bal-grp-ip", "bal-grp-is"}
    finally:
        session.rollback()
        session.close()


def test_below_threshold_lists_classes_under_the_limit():
    session = SessionLocal()
    try:
        category, region, sequence, frames, user_id = _fixture(session, "thr")
        common = _label(session, category, region, "bal-thr-common")
        rare = _label(session, category, region, "bal-thr-rare")
        for frame in frames:
            _annotate(session, frame, common, user_id)
        _annotate(session, frames[0], rare, user_id)

        report = compute_balance(
            session, [sequence.id], TaskType.DETECTION, GroupingRules(), set(), threshold=3
        )

        assert "bal-thr-rare" in report.below_threshold
        assert "bal-thr-common" not in report.below_threshold
        assert report.threshold == 3
    finally:
        session.rollback()
        session.close()


def test_negatives_are_counted_separately_and_form_no_class():
    session = SessionLocal()
    try:
        category, region, sequence, frames, user_id = _fixture(session, "negcount")
        polyp = _label(session, category, region, "bal-negcount-polyp")
        _annotate(session, frames[0], polyp, user_id)
        frames[1].no_findings_reviewed = True
        session.flush()

        report = compute_balance(session, [sequence.id], TaskType.DETECTION, GroupingRules(), set())

        assert report.negative_frames == 1
        assert report.total_frames == 2
        assert {c.name for c in report.classes} == {"bal-negcount-polyp"}
    finally:
        session.rollback()
        session.close()
