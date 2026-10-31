"""Tag regions: copy region annotations (MASK/BBOX) to another label in bulk.

See docs/superpowers/specs/2026-10-31-tag-regions-design.md. An annotation
carries exactly one label, so a region that is both "polyp" and "adenoma" is
two annotations with the same geometry; this module makes the second one from
the first instead of the user drawing it again. Preview and Create share one
code path (``dry_run``), so the preview numbers cannot drift from the result.
"""

import copy
import uuid
from dataclasses import dataclass, field

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
from app.auth.models import User
from app.media.models import Frame
from app.storage import StorageService
from app.taxonomy.models import AnnotationScope, EvaluationType, Label

# Every copy is a download and an upload, done synchronously in the request.
MAX_SOURCE_REGIONS = 1000

REGION_ANNOTATION_TYPES = (AnnotationType.MASK, AnnotationType.BBOX)


@dataclass
class TagRegionsResult:
    dry_run: bool
    # Would create (dry run) / created.
    regions: int = 0
    # Frames receiving at least one new region.
    frames: int = 0
    skipped_already_copied: int = 0
    already_copied_label_names: list[str] = field(default_factory=list)
    # Frames carrying hand-drawn regions of the target's evaluation type,
    # reported whether or not they are skipped.
    frames_with_manual_regions: int = 0
    # Frames (not regions) left out because of skip_manual_frames.
    skipped_manual_frames: int = 0


def descendant_label_ids(session: Session, label_id: int) -> set[int]:
    """``label_id`` plus every label below it through ``parent_label_id``.

    Cycle-safe: a label already seen is never expanded again, so a loop that
    hierarchy validation failed to stop cannot make this run forever.
    """
    found: set[int] = {label_id}
    frontier: set[int] = {label_id}
    while frontier:
        children = {
            row.id
            for row in session.query(Label.id).filter(Label.parent_label_id.in_(frontier)).all()
        }
        frontier = children - found
        found |= frontier
    return found


def require_one_sequence(session: Session, frame_ids: list[int]) -> list[int]:
    """Dedupe ``frame_ids`` (keeping order) and check they exist and share one
    sequence. 422 if empty or spanning sequences, 404 if any frame is missing.
    """
    deduped = list(dict.fromkeys(frame_ids))
    if not deduped:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="No frames given"
        )
    rows = session.query(Frame.id, Frame.sequence_id).filter(Frame.id.in_(deduped)).all()
    missing = set(deduped) - {row.id for row in rows}
    if missing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"Frames not found: {sorted(missing)}"
        )
    if len({row.sequence_id for row in rows}) > 1:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Frames must all belong to one sequence",
        )
    return deduped


def eligible_sources(
    session: Session, frame_ids: list[int], label_ids: set[int]
) -> list[Annotation]:
    """Region annotations on ``frame_ids`` that can be copied: type MASK or
    BBOX (never CLASSIFICATION), label in ``label_ids``, and for MASK a
    non-NULL ``storage_key`` (a mask without its object has no geometry to
    copy). Ordered by id.
    """
    if not frame_ids or not label_ids:
        return []
    candidates = (
        session.query(Annotation)
        .filter(
            Annotation.frame_id.in_(frame_ids),
            Annotation.label_id.in_(label_ids),
            Annotation.annotation_type.in_(REGION_ANNOTATION_TYPES),
        )
        .order_by(Annotation.id)
        .all()
    )
    return [
        a
        for a in candidates
        if a.annotation_type != AnnotationType.MASK or a.storage_key is not None
    ]


def _get_label(session: Session, label_id: int, role: str) -> Label:
    label = session.get(Label, label_id)
    if label is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"{role} label not found"
        )
    return label


def _require_region_scoped(session: Session, label: Label, role: str) -> None:
    evaluation_type = session.get(EvaluationType, label.evaluation_type_id)
    if evaluation_type is None or evaluation_type.annotation_scope != AnnotationScope.REGION:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{role} label must be region-scoped",
        )


def _copy_object(storage: StorageService, key: str, new_key: str, uploaded: list[str]) -> None:
    data = storage.download(key)
    storage.upload(new_key, data, content_type="image/png")
    uploaded.append(new_key)


def tag_regions(
    session: Session,
    storage: StorageService,
    frame_ids: list[int],
    source_label_id: int,
    target_label_id: int,
    created_by: User,
    skip_manual_frames: bool = True,
    dry_run: bool = False,
) -> TagRegionsResult:
    frame_ids = require_one_sequence(session, frame_ids)
    source = _get_label(session, source_label_id, "Source")
    target = _get_label(session, target_label_id, "Target")
    _require_region_scoped(session, source, "Source")
    _require_region_scoped(session, target, "Target")
    if target.is_abstract:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Cannot annotate with an abstract (grouping-only) label",
        )
    if source.id == target.id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Source and target labels must differ",
        )

    sources = eligible_sources(session, frame_ids, descendant_label_ids(session, source.id))
    if len(sources) > MAX_SOURCE_REGIONS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"{len(sources)} source regions exceed the limit of {MAX_SOURCE_REGIONS} "
                "per request; tick fewer frames"
            ),
        )
    source_ids = [a.id for a in sources]

    # A source already copied into any label of the target's evaluation type
    # is skipped: no duplicates, and no second conflicting tag on one shape.
    already_copied: dict[int, set[str]] = {}
    if source_ids:
        rows = (
            session.query(Annotation.source_annotation_id, Label.name)
            .join(Label, Label.id == Annotation.label_id)
            .filter(
                Annotation.source_annotation_id.in_(source_ids),
                Label.evaluation_type_id == target.evaluation_type_id,
            )
            .all()
        )
        for row in rows:
            already_copied.setdefault(row.source_annotation_id, set()).add(row.name)

    # Hand-drawn regions of the target's evaluation type: no source link, and
    # not themselves one of the regions being copied (an adenoma -> ssl
    # relabel must not see its own sources as manual work).
    manual_query = (
        session.query(Annotation.frame_id)
        .join(Label, Label.id == Annotation.label_id)
        .filter(
            Annotation.frame_id.in_(frame_ids),
            Annotation.source_annotation_id.is_(None),
            Label.evaluation_type_id == target.evaluation_type_id,
        )
    )
    if source_ids:
        manual_query = manual_query.filter(Annotation.id.notin_(source_ids))
    manual_frame_ids = {row.frame_id for row in manual_query.distinct().all()}

    result = TagRegionsResult(dry_run=dry_run, frames_with_manual_regions=len(manual_frame_ids))
    to_copy: list[Annotation] = []
    skipped_manual: set[int] = set()
    existing_names: set[str] = set()
    for annotation in sources:
        if annotation.id in already_copied:
            result.skipped_already_copied += 1
            existing_names |= already_copied[annotation.id]
            continue
        if skip_manual_frames and annotation.frame_id in manual_frame_ids:
            skipped_manual.add(annotation.frame_id)
            continue
        to_copy.append(annotation)

    result.already_copied_label_names = sorted(existing_names)
    result.skipped_manual_frames = len(skipped_manual)
    result.regions = len(to_copy)
    result.frames = len({a.frame_id for a in to_copy})

    if dry_run or not to_copy:
        return result

    uploaded: list[str] = []
    try:
        for annotation in to_copy:
            storage_key = None
            raw_key = None
            is_mask = annotation.annotation_type == AnnotationType.MASK
            if is_mask:  # eligible_sources guarantees a storage_key here
                storage_key = f"masks/{annotation.frame_id}/copy-{uuid.uuid4().hex}.png"
                _copy_object(storage, annotation.storage_key, storage_key, uploaded)
            if is_mask and annotation.raw_mask_storage_key is not None:
                raw_key = f"masks/{annotation.frame_id}/copy-{uuid.uuid4().hex}-raw.png"
                _copy_object(storage, annotation.raw_mask_storage_key, raw_key, uploaded)
            session.add(
                Annotation(
                    frame_id=annotation.frame_id,
                    label_id=target.id,
                    # Copied from the target label now (CLAUDE.md taxonomy_version rule).
                    taxonomy_version=target.taxonomy_version,
                    annotation_type=annotation.annotation_type,
                    payload=copy.deepcopy(annotation.payload),
                    status=AnnotationStatus.DRAFT,
                    created_by_id=created_by.id,
                    storage_key=storage_key,
                    raw_mask_storage_key=raw_key,
                    job_id=None,
                    source_annotation_id=annotation.id,
                )
            )
        session.flush()
        session.commit()
    except Exception:
        for key in uploaded:
            try:
                storage.delete(key)
            except Exception:
                pass  # best effort: the original error is the one to report
        session.rollback()
        raise

    return result
