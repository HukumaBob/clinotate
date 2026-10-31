import app.main  # noqa: F401
from sqlalchemy import delete

from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
from app.auth.models import User, UserRole
from app.media.models import Frame, Sequence, Video
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure


def test_deleting_source_nulls_copy_link(db_session):
    user = User(email="src-link@example.com", hashed_password="x", role=UserRole.ADMIN)
    procedure = Procedure(name="src-link-proc")
    db_session.add_all([user, procedure])
    db_session.flush()
    category = Category(name="src-link-cat", procedure_id=procedure.id)
    region = EvaluationType(name="src-link-region", annotation_scope=AnnotationScope.REGION)
    db_session.add_all([category, region])
    db_session.flush()
    label = Label(name="src-link-label", category_id=category.id, evaluation_type_id=region.id)
    video = Video(title="src-link-v", storage_key="src-link/v.mp4", checksum="src-link",
                  fps=25.0, duration_seconds=1.0)
    db_session.add_all([label, video])
    db_session.flush()
    sequence = Sequence(name="src-link-seq", start_time=0, duration=1,
                        procedure_id=procedure.id, video_id=video.id)
    db_session.add(sequence)
    db_session.flush()
    frame = Frame(sequence_id=sequence.id, storage_key="src-link/f0", frame_index=0,
                  width=64, height=64)
    db_session.add(frame)
    db_session.flush()

    def make(**extra):
        a = Annotation(
            frame_id=frame.id, label_id=label.id, taxonomy_version=label.taxonomy_version,
            annotation_type=AnnotationType.MASK, payload={},
            status=AnnotationStatus.DRAFT, created_by_id=user.id, **extra,
        )
        db_session.add(a)
        db_session.flush()
        return a

    first = make()
    second = make(source_annotation_id=first.id)
    assert second.source_annotation_id == first.id

    db_session.execute(delete(Annotation).where(Annotation.id == first.id))
    db_session.refresh(second)
    assert second.source_annotation_id is None
