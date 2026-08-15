import app.main  # noqa: F401 -- registers every model on Base.metadata for create_all
import sqlalchemy as sa

from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
from app.datasets.models import TaskType
from app.datasets.service import collect_frames, scope_for_task
from app.db import SessionLocal
from app.media.models import Frame, Sequence
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure


def _fixture(session, tag):
    """Build an isolated procedure/category/labels/sequence/frames island."""
    procedure = Procedure(name=f"ds-{tag}-proc")
    session.add(procedure)
    session.flush()
    category = Category(name=f"ds-{tag}-cat", procedure_id=procedure.id)
    session.add(category)
    session.flush()
    region = EvaluationType(name=f"ds-{tag}-region", annotation_scope=AnnotationScope.REGION)
    frame_et = EvaluationType(name=f"ds-{tag}-frame", annotation_scope=AnnotationScope.FRAME)
    session.add_all([region, frame_et])
    session.flush()
    sequence = Sequence(name=f"ds-{tag}-seq", start_time=0, duration=1, procedure_id=procedure.id)
    session.add(sequence)
    session.flush()
    # NB: the column is `frame_index`, not `index`; width/height are required.
    frames = [
        Frame(sequence_id=sequence.id, storage_key=f"k{i}", frame_index=i, width=64, height=64)
        for i in range(4)
    ]
    session.add_all(frames)
    session.flush()
    user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
    return procedure, category, region, frame_et, sequence, frames, user_id


def _label(session, category, evaluation_type, name):
    label = Label(name=name, category_id=category.id, evaluation_type_id=evaluation_type.id)
    session.add(label)
    session.flush()
    return label


def _annotate(session, frame, label, user_id, annotation_type=AnnotationType.MASK):
    annotation = Annotation(
        frame_id=frame.id, label_id=label.id, taxonomy_version=label.taxonomy_version,
        annotation_type=annotation_type, payload={}, status=AnnotationStatus.DRAFT,
        created_by_id=user_id,
    )
    session.add(annotation)
    session.flush()
    return annotation


def test_scope_for_task_maps_each_task_type():
    assert scope_for_task(TaskType.DETECTION) is AnnotationScope.REGION
    assert scope_for_task(TaskType.SEGMENTATION) is AnnotationScope.REGION
    assert scope_for_task(TaskType.CLASSIFICATION) is AnnotationScope.FRAME


def test_annotated_frame_is_included_with_its_annotation_ids():
    session = SessionLocal()
    try:
        _, category, region, _, sequence, frames, user_id = _fixture(session, "inc")
        polyp = _label(session, category, region, "ds-inc-polyp")
        annotation = _annotate(session, frames[0], polyp, user_id)

        result = collect_frames(session, [sequence.id], TaskType.DETECTION, set())

        included = {c.frame_id: c for c in result}
        assert frames[0].id in included
        assert included[frames[0].id].annotation_ids == [annotation.id]
        assert included[frames[0].id].is_negative is False
    finally:
        session.rollback()
        session.close()


def test_unannotated_frame_without_the_flag_is_omitted():
    session = SessionLocal()
    try:
        _, category, region, _, sequence, frames, user_id = _fixture(session, "omit")
        polyp = _label(session, category, region, "ds-omit-polyp")
        _annotate(session, frames[0], polyp, user_id)

        result = collect_frames(session, [sequence.id], TaskType.DETECTION, set())

        assert {c.frame_id for c in result} == {frames[0].id}
    finally:
        session.rollback()
        session.close()


def test_no_findings_reviewed_frame_is_included_as_a_negative():
    session = SessionLocal()
    try:
        _, _, _, _, sequence, frames, _ = _fixture(session, "neg")
        frames[1].no_findings_reviewed = True
        session.flush()

        result = collect_frames(session, [sequence.id], TaskType.DETECTION, set())

        negatives = [c for c in result if c.is_negative]
        assert [c.frame_id for c in negatives] == [frames[1].id]
        assert negatives[0].annotation_ids == []
    finally:
        session.rollback()
        session.close()


def test_task_type_filters_by_annotation_scope():
    session = SessionLocal()
    try:
        _, category, region, frame_et, sequence, frames, user_id = _fixture(session, "scope")
        mask_label = _label(session, category, region, "ds-scope-mask")
        cls_label = _label(session, category, frame_et, "ds-scope-cls")
        _annotate(session, frames[0], mask_label, user_id)
        _annotate(session, frames[1], cls_label, user_id, AnnotationType.CLASSIFICATION)

        detection = collect_frames(session, [sequence.id], TaskType.DETECTION, set())
        classification = collect_frames(session, [sequence.id], TaskType.CLASSIFICATION, set())

        assert {c.frame_id for c in detection} == {frames[0].id}
        assert {c.frame_id for c in classification} == {frames[1].id}
    finally:
        session.rollback()
        session.close()


def test_a_frame_carrying_both_scopes_contributes_only_the_matching_annotations():
    # No frame mixes scopes in the dev data today, but marking an annotated
    # frame low_quality is legitimate, so the filter must work per annotation.
    session = SessionLocal()
    try:
        _, category, region, frame_et, sequence, frames, user_id = _fixture(session, "mixed")
        mask_label = _label(session, category, region, "ds-mixed-mask")
        cls_label = _label(session, category, frame_et, "ds-mixed-cls")
        mask_annotation = _annotate(session, frames[0], mask_label, user_id)
        _annotate(session, frames[0], cls_label, user_id, AnnotationType.CLASSIFICATION)

        detection = collect_frames(session, [sequence.id], TaskType.DETECTION, set())

        assert len(detection) == 1
        assert detection[0].annotation_ids == [mask_annotation.id]
    finally:
        session.rollback()
        session.close()


def test_frame_whose_annotations_are_all_excluded_drops_out_and_is_not_a_negative():
    # "We chose not to train the ileum class" does not mean "this frame is empty".
    # Turning it into a negative would manufacture a false negative.
    session = SessionLocal()
    try:
        _, category, region, _, sequence, frames, user_id = _fixture(session, "excl")
        rare = _label(session, category, region, "ds-excl-rare")
        _annotate(session, frames[0], rare, user_id)

        result = collect_frames(session, [sequence.id], TaskType.DETECTION, {rare.id})

        assert result == []
    finally:
        session.rollback()
        session.close()


def test_an_excluded_frame_that_is_also_flagged_stays_as_a_negative():
    session = SessionLocal()
    try:
        _, category, region, _, sequence, frames, user_id = _fixture(session, "exclneg")
        rare = _label(session, category, region, "ds-exclneg-rare")
        _annotate(session, frames[0], rare, user_id)
        frames[0].no_findings_reviewed = True
        session.flush()

        result = collect_frames(session, [sequence.id], TaskType.DETECTION, {rare.id})

        assert len(result) == 1
        assert result[0].frame_id == frames[0].id
        assert result[0].is_negative is True
        assert result[0].annotation_ids == []
    finally:
        session.rollback()
        session.close()
