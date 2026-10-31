"""Shared fixtures-as-functions for the tag-regions tests (service, API, remove).

- ``FakeStorage``: dict-backed stand-in for ``StorageService``. ``objects``
  maps key -> bytes, ``uploads`` lists ``(key, content_type)`` in order,
  ``deleted`` lists deleted keys in order. Set ``fail_on_upload = n`` to make
  the n-th ``upload`` call (1-based, counted from construction) raise
  ``RuntimeError`` without storing anything.
- ``build_world(db_session)``: a user, two sequences' frames, region
  evaluation types ``geometric`` / ``morphological`` plus a frame-scoped one,
  and labels ``polyp`` (parent) -> ``polyp_ip`` (child), ``adenoma``, ``ssl``,
  an abstract morphological label and a frame-scoped label. Committed (the
  ``db_session`` fixture turns commits into savepoints, so everything still
  disappears at teardown) so a ``session.rollback()`` under test cannot undo it.
- ``add_region(...)``: one MASK (with objects in the FakeStorage) or BBOX
  annotation on a frame.
"""

import uuid
from types import SimpleNamespace

from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
from app.auth.models import User, UserRole
from app.media.models import Frame, Sequence, Video
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure


class FakeStorage:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.uploads: list[tuple[str, str]] = []
        self.deleted: list[str] = []
        self.fail_on_upload: int | None = None
        self._upload_calls = 0

    def upload(self, key: str, data: bytes, content_type: str) -> None:
        self._upload_calls += 1
        if self.fail_on_upload is not None and self._upload_calls == self.fail_on_upload:
            raise RuntimeError(f"FakeStorage: upload #{self._upload_calls} failed")
        self.objects[key] = data
        self.uploads.append((key, content_type))

    def download(self, key: str) -> bytes:
        return self.objects[key]

    def delete(self, key: str) -> None:
        self.objects.pop(key, None)
        self.deleted.append(key)


def build_world(db_session) -> SimpleNamespace:
    tag = uuid.uuid4().hex[:8]
    user = User(email=f"tag-regions-{tag}@example.com", hashed_password="x", role=UserRole.ADMIN)
    procedure = Procedure(name=f"tr-proc-{tag}")
    db_session.add_all([user, procedure])
    db_session.flush()

    category = Category(name=f"tr-cat-{tag}", procedure_id=procedure.id)
    geometric = EvaluationType(name=f"geometric-{tag}", annotation_scope=AnnotationScope.REGION)
    morphological = EvaluationType(
        name=f"morphological-{tag}", annotation_scope=AnnotationScope.REGION
    )
    frame_scope = EvaluationType(name=f"quality-{tag}", annotation_scope=AnnotationScope.FRAME)
    db_session.add_all([category, geometric, morphological, frame_scope])
    db_session.flush()

    def label(name, evaluation_type, **extra):
        row = Label(
            name=name, category_id=category.id, evaluation_type_id=evaluation_type.id, **extra
        )
        db_session.add(row)
        db_session.flush()
        return row

    polyp = label("polyp", geometric)
    polyp_ip = label("polyp_ip", geometric, parent_label_id=polyp.id)
    adenoma = label("adenoma", morphological)
    ssl = label("ssl", morphological)
    neoplasia = label("neoplasia", morphological, is_abstract=True)
    blurry = label("blurry", frame_scope)

    video = Video(
        title=f"tr-v-{tag}", storage_key=f"tr-{tag}/v.mp4", checksum=f"tr-{tag}",
        fps=25.0, duration_seconds=1.0,
    )
    db_session.add(video)
    db_session.flush()

    def sequence_with_frames(name, count):
        sequence = Sequence(
            name=name, start_time=0, duration=1, procedure_id=procedure.id, video_id=video.id
        )
        db_session.add(sequence)
        db_session.flush()
        frames = [
            Frame(
                sequence_id=sequence.id, storage_key=f"tr-{tag}/{name}/f{i}",
                frame_index=i, width=64, height=64,
            )
            for i in range(count)
        ]
        db_session.add_all(frames)
        db_session.flush()
        return sequence, frames

    sequence_a, frames_a = sequence_with_frames("seq-a", 4)
    sequence_b, frames_b = sequence_with_frames("seq-b", 2)
    db_session.commit()

    return SimpleNamespace(
        user=user, procedure=procedure, category=category,
        geometric=geometric, morphological=morphological, frame_scope=frame_scope,
        polyp=polyp, polyp_ip=polyp_ip, adenoma=adenoma, ssl=ssl,
        abstract=neoplasia, frame_label=blurry,
        sequence_a=sequence_a, frames_a=frames_a,
        sequence_b=sequence_b, frames_b=frames_b,
    )


def add_region(
    db_session,
    storage: FakeStorage,
    frame: Frame,
    label: Label,
    user: User,
    annotation_type: AnnotationType = AnnotationType.MASK,
    with_raw: bool = True,
    with_storage_key: bool = True,
    status: AnnotationStatus = AnnotationStatus.DRAFT,
    source_annotation_id: int | None = None,
    payload: dict | None = None,
) -> Annotation:
    storage_key = None
    raw_key = None
    if annotation_type == AnnotationType.MASK and with_storage_key:
        stem = f"masks/{frame.id}/src-{uuid.uuid4().hex}"
        storage_key = f"{stem}.png"
        storage.objects[storage_key] = b"mask-" + stem.encode()
        if with_raw:
            raw_key = f"{stem}-raw.png"
            storage.objects[raw_key] = b"raw-" + stem.encode()
    if payload is None:
        payload = (
            {"bbox": [1, 2, 10, 20], "meta": {"points": [[1, 2]]}}
            if annotation_type == AnnotationType.BBOX
            else {"mask_postprocess_strength": 0.3, "meta": {"points": [[3, 4]]}}
        )
    annotation = Annotation(
        frame_id=frame.id, label_id=label.id, taxonomy_version=label.taxonomy_version,
        annotation_type=annotation_type, payload=payload, status=status,
        created_by_id=user.id, storage_key=storage_key, raw_mask_storage_key=raw_key,
        source_annotation_id=source_annotation_id,
    )
    db_session.add(annotation)
    db_session.commit()
    return annotation
