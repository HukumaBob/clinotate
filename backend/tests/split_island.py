"""Builds an isolated island of videos, sequences, frames and classification
annotations for the dataset-split tests."""
import app.main  # noqa: F401 -- registers every model on Base.metadata

from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
from app.auth.models import User
from app.media.models import Frame, Sequence, Video
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure


def build_island(session, tag, videos, negatives=0):
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
