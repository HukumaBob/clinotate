import app.main  # noqa: F401
import sqlalchemy as sa

from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
from app.datasets.models import TaskType
from app.datasets.service import collect_frames
from app.db import SessionLocal
from app.media.models import Frame, Sequence, Video
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure


def _island(session, tag, sequences_per_video=2, frames_per_sequence=6):
    """Two videos' worth of sequences, so limits have units to spread across."""
    procedure = Procedure(name=f"cl-{tag}-proc")
    session.add(procedure)
    session.flush()
    category = Category(name=f"cl-{tag}-cat", procedure_id=procedure.id)
    session.add(category)
    session.flush()
    region = EvaluationType(name=f"cl-{tag}-region", annotation_scope=AnnotationScope.REGION)
    session.add(region)
    session.flush()

    sequences = []
    for v in range(2):
        video = Video(title=f"cl-{tag}-v{v}", storage_key=f"cl/{tag}/{v}.mp4",
                      checksum=f"cl-{tag}-{v}", fps=25.0, duration_seconds=1.0)
        session.add(video)
        session.flush()
        for q in range(sequences_per_video):
            sequence = Sequence(
                name=f"cl-{tag}-v{v}s{q}", start_time=0, duration=1,
                procedure_id=procedure.id, video_id=video.id,
            )
            session.add(sequence)
            session.flush()
            frames = [
                Frame(sequence_id=sequence.id, storage_key=f"cl/{tag}/{v}{q}{i}",
                      frame_index=i, width=64, height=64)
                for i in range(frames_per_sequence)
            ]
            session.add_all(frames)
            session.flush()
            sequences.append((video.id, sequence, frames))

    user_id = session.execute(sa.text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()
    return category, region, sequences, user_id


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


def _instances(composition):
    return sum(len(c.annotation_ids) for c in composition)


def test_a_limit_caps_the_number_of_instances():
    session = SessionLocal()
    try:
        category, region, sequences, user_id = _island(session, "cap")
        common = _label(session, category, region, "cl-cap-common")
        for _, _, frames in sequences:
            for frame in frames:
                _annotate(session, frame, common, user_id)
        sequence_ids = [seq.id for _, seq, _ in sequences]

        uncapped = collect_frames(session, sequence_ids, TaskType.DETECTION, set())
        capped = collect_frames(
            session, sequence_ids, TaskType.DETECTION, set(), class_limits={common.id: 8}
        )

        assert _instances(uncapped) == 24
        assert _instances(capped) == 8
    finally:
        session.rollback()
        session.close()


def test_a_limit_spreads_across_grouping_units():
    session = SessionLocal()
    try:
        category, region, sequences, user_id = _island(session, "spread")
        common = _label(session, category, region, "cl-spread-common")
        for _, _, frames in sequences:
            for frame in frames:
                _annotate(session, frame, common, user_id)
        sequence_ids = [seq.id for _, seq, _ in sequences]
        video_by_sequence = {seq.id: video_id for video_id, seq, _ in sequences}

        capped = collect_frames(
            session, sequence_ids, TaskType.DETECTION, set(), class_limits={common.id: 8}
        )

        frame_to_sequence = {}
        for _, seq, frames in sequences:
            for frame in frames:
                frame_to_sequence[frame.id] = seq.id
        per_video: dict[int, int] = {}
        for item in capped:
            video_id = video_by_sequence[frame_to_sequence[item.frame_id]]
            per_video[video_id] = per_video.get(video_id, 0) + len(item.annotation_ids)

        # Two videos, 12 annotations each, cap 8 -> 4 from each video.
        assert len(per_video) == 2
        assert set(per_video.values()) == {4}
    finally:
        session.rollback()
        session.close()


def test_capping_is_reproducible():
    session = SessionLocal()
    try:
        category, region, sequences, user_id = _island(session, "repro")
        common = _label(session, category, region, "cl-repro-common")
        for _, _, frames in sequences:
            for frame in frames:
                _annotate(session, frame, common, user_id)
        sequence_ids = [seq.id for _, seq, _ in sequences]

        first = collect_frames(
            session, sequence_ids, TaskType.DETECTION, set(), class_limits={common.id: 7}
        )
        second = collect_frames(
            session, sequence_ids, TaskType.DETECTION, set(), class_limits={common.id: 7}
        )

        assert [(c.frame_id, c.annotation_ids) for c in first] == [
            (c.frame_id, c.annotation_ids) for c in second
        ]
    finally:
        session.rollback()
        session.close()


def test_a_limit_at_or_above_the_total_is_a_no_op():
    session = SessionLocal()
    try:
        category, region, sequences, user_id = _island(session, "noop")
        common = _label(session, category, region, "cl-noop-common")
        for _, _, frames in sequences:
            for frame in frames:
                _annotate(session, frame, common, user_id)
        sequence_ids = [seq.id for _, seq, _ in sequences]

        uncapped = collect_frames(session, sequence_ids, TaskType.DETECTION, set())
        capped = collect_frames(
            session, sequence_ids, TaskType.DETECTION, set(), class_limits={common.id: 999}
        )

        assert _instances(capped) == _instances(uncapped)
    finally:
        session.rollback()
        session.close()


def test_a_frame_whose_annotations_are_all_capped_away_drops_out_and_is_not_a_negative():
    # Capping is a bookkeeping decision, not a claim the frame is empty --
    # the same rule exclusions already follow.
    session = SessionLocal()
    try:
        category, region, sequences, user_id = _island(session, "drop")
        common = _label(session, category, region, "cl-drop-common")
        for _, _, frames in sequences:
            for frame in frames:
                _annotate(session, frame, common, user_id)
        sequence_ids = [seq.id for _, seq, _ in sequences]

        capped = collect_frames(
            session, sequence_ids, TaskType.DETECTION, set(), class_limits={common.id: 4}
        )

        assert all(not c.is_negative for c in capped)
        assert len(capped) == 4
    finally:
        session.rollback()
        session.close()


def test_capping_a_collapsed_parent_caps_its_children():
    # Limits key on RESOLVED class ids, like exclusions do.
    session = SessionLocal()
    try:
        category, region, sequences, user_id = _island(session, "parent")
        polyp = _label(session, category, region, "cl-parent-polyp", is_abstract=True)
        ip = _label(session, category, region, "cl-parent-ip", parent_id=polyp.id)
        is_ = _label(session, category, region, "cl-parent-is", parent_id=polyp.id)
        for index, (_, _, frames) in enumerate(sequences):
            for frame in frames:
                _annotate(session, frame, ip if index % 2 == 0 else is_, user_id)
        sequence_ids = [seq.id for _, seq, _ in sequences]

        from app.taxonomy.hierarchy import GroupingRules, build_label_tree

        tree = build_label_tree(session)
        capped = collect_frames(
            session, sequence_ids, TaskType.DETECTION, set(),
            tree=tree, rules=GroupingRules(), class_limits={polyp.id: 6},
        )

        assert _instances(capped) == 6
    finally:
        session.rollback()
        session.close()
