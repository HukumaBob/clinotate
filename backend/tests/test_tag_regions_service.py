import app.main  # noqa: F401
import pytest
from fastapi import HTTPException
from sqlalchemy import delete

import app.annotation.tag_regions as tag_regions_module
from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
from app.annotation.tag_regions import (
    descendant_label_ids,
    eligible_sources,
    list_region_labels,
    remove_copies,
    require_one_sequence,
    tag_regions,
)
from tests.tag_regions_helpers import FakeStorage, add_region, build_world


@pytest.fixture
def world(db_session):
    return build_world(db_session)


@pytest.fixture
def storage():
    return FakeStorage()


def _ids(frames):
    return [frame.id for frame in frames]


def _annotation_count(db_session) -> int:
    return db_session.query(Annotation).count()


def _copies_of(db_session, source_id):
    return (
        db_session.query(Annotation)
        .filter(Annotation.source_annotation_id == source_id)
        .all()
    )


def test_dry_run_counts_match_real_run_and_write_nothing(db_session, world, storage):
    f0, f1, f2, f3 = world.frames_a
    add_region(db_session, storage, f0, world.polyp, world.user)
    add_region(db_session, storage, f1, world.polyp, world.user)
    add_region(db_session, storage, f1, world.polyp_ip, world.user, AnnotationType.BBOX)
    already = add_region(db_session, storage, f2, world.polyp, world.user)
    add_region(db_session, storage, f2, world.adenoma, world.user, source_annotation_id=already.id)
    add_region(db_session, storage, f3, world.polyp, world.user)
    add_region(db_session, storage, f3, world.ssl, world.user)  # manual morphological
    before_rows = _annotation_count(db_session)
    before_objects = dict(storage.objects)

    preview = tag_regions(
        db_session, storage, _ids(world.frames_a), world.polyp.id, world.adenoma.id,
        world.user, dry_run=True,
    )

    assert preview.dry_run is True
    assert _annotation_count(db_session) == before_rows
    assert storage.objects == before_objects
    assert storage.uploads == []

    result = tag_regions(
        db_session, storage, _ids(world.frames_a), world.polyp.id, world.adenoma.id, world.user,
    )

    assert result.dry_run is False
    for field in (
        "regions", "frames", "skipped_already_copied", "already_copied_label_names",
        "frames_with_manual_regions", "skipped_manual_frames",
    ):
        assert getattr(preview, field) == getattr(result, field), field
    assert result.regions == 3
    assert result.frames == 2
    assert result.skipped_already_copied == 1
    assert result.already_copied_label_names == ["adenoma"]
    assert result.frames_with_manual_regions == 1
    assert result.skipped_manual_frames == 1
    assert _annotation_count(db_session) == before_rows + 3


def test_create_copies_geometry_label_and_taxonomy_version(db_session, world, storage):
    world.adenoma.taxonomy_version = 3
    db_session.commit()
    frame = world.frames_a[0]
    source = add_region(
        db_session, storage, frame, world.polyp, world.user, status=AnnotationStatus.REVIEWED,
    )
    source_snapshot = {
        "label_id": source.label_id, "payload": dict(source.payload),
        "status": source.status, "storage_key": source.storage_key,
        "raw": source.raw_mask_storage_key, "taxonomy_version": source.taxonomy_version,
    }
    assert source.taxonomy_version == 1

    result = tag_regions(
        db_session, storage, [frame.id], world.polyp.id, world.adenoma.id, world.user,
    )

    assert result.regions == 1
    [copy] = _copies_of(db_session, source.id)
    assert copy.frame_id == frame.id
    assert copy.annotation_type == AnnotationType.MASK
    assert copy.label_id == world.adenoma.id
    assert copy.taxonomy_version == 3
    assert copy.payload == source.payload
    assert copy.payload is not source.payload
    assert copy.payload["meta"] is not source.payload["meta"]
    assert copy.status == AnnotationStatus.DRAFT
    assert copy.job_id is None
    assert copy.created_by_id == world.user.id
    assert copy.source_annotation_id == source.id

    db_session.refresh(source)
    assert source.label_id == source_snapshot["label_id"]
    assert source.payload == source_snapshot["payload"]
    assert source.status == source_snapshot["status"]
    assert source.storage_key == source_snapshot["storage_key"]
    assert source.raw_mask_storage_key == source_snapshot["raw"]
    assert source.taxonomy_version == source_snapshot["taxonomy_version"]
    assert source.source_annotation_id is None


def test_mask_objects_are_copied_not_shared(db_session, world, storage):
    frame = world.frames_a[0]
    source = add_region(db_session, storage, frame, world.polyp, world.user)

    tag_regions(db_session, storage, [frame.id], world.polyp.id, world.adenoma.id, world.user)

    [copy] = _copies_of(db_session, source.id)
    assert copy.storage_key != source.storage_key
    assert copy.raw_mask_storage_key != source.raw_mask_storage_key
    assert copy.storage_key.startswith(f"masks/{frame.id}/copy-")
    assert copy.storage_key.endswith(".png")
    assert copy.raw_mask_storage_key.startswith(f"masks/{frame.id}/copy-")
    assert copy.raw_mask_storage_key.endswith("-raw.png")
    assert storage.objects[copy.storage_key] == storage.objects[source.storage_key]
    assert storage.objects[copy.raw_mask_storage_key] == storage.objects[source.raw_mask_storage_key]
    assert {content_type for _, content_type in storage.uploads} == {"image/png"}


def test_mask_without_raw_copies_only_storage_key(db_session, world, storage):
    frame = world.frames_a[0]
    source = add_region(db_session, storage, frame, world.polyp, world.user, with_raw=False)

    tag_regions(db_session, storage, [frame.id], world.polyp.id, world.adenoma.id, world.user)

    [copy] = _copies_of(db_session, source.id)
    assert copy.storage_key is not None
    assert copy.raw_mask_storage_key is None
    assert len(storage.uploads) == 1


def test_bbox_copy_has_no_objects(db_session, world, storage):
    frame = world.frames_a[0]
    source = add_region(db_session, storage, frame, world.polyp, world.user, AnnotationType.BBOX)

    result = tag_regions(
        db_session, storage, [frame.id], world.polyp.id, world.adenoma.id, world.user,
    )

    assert result.regions == 1
    [copy] = _copies_of(db_session, source.id)
    assert copy.annotation_type == AnnotationType.BBOX
    assert copy.storage_key is None
    assert copy.raw_mask_storage_key is None
    assert copy.payload == source.payload
    assert storage.uploads == []


def test_second_run_creates_nothing_and_names_existing_label(db_session, world, storage):
    frames = world.frames_a[:2]
    for frame in frames:
        add_region(db_session, storage, frame, world.polyp, world.user)
    tag_regions(db_session, storage, _ids(frames), world.polyp.id, world.adenoma.id, world.user)
    rows = _annotation_count(db_session)

    second = tag_regions(
        db_session, storage, _ids(frames), world.polyp.id, world.adenoma.id, world.user,
    )

    assert second.regions == 0
    assert second.frames == 0
    assert second.skipped_already_copied == 2
    assert second.already_copied_label_names == ["adenoma"]
    assert _annotation_count(db_session) == rows


def test_other_morphological_label_blocks_second_copy(db_session, world, storage):
    frame = world.frames_a[0]
    add_region(db_session, storage, frame, world.polyp, world.user)
    tag_regions(db_session, storage, [frame.id], world.polyp.id, world.adenoma.id, world.user)
    rows = _annotation_count(db_session)

    result = tag_regions(db_session, storage, [frame.id], world.polyp.id, world.ssl.id, world.user)

    assert result.regions == 0
    assert result.skipped_already_copied == 1
    assert result.already_copied_label_names == ["adenoma"]
    assert _annotation_count(db_session) == rows


def test_geometric_copy_does_not_block_morphological_copy(db_session, world, storage):
    frame = world.frames_a[0]
    source = add_region(db_session, storage, frame, world.polyp_ip, world.user)
    # A linked copy of the same source carrying a geometric label. tag_regions
    # itself refuses a geometric -> geometric copy, so it is inserted directly.
    add_region(db_session, storage, frame, world.polyp, world.user, source_annotation_id=source.id)

    result = tag_regions(
        db_session, storage, [frame.id], world.polyp_ip.id, world.adenoma.id, world.user,
    )

    assert result.regions == 1
    assert result.skipped_already_copied == 0
    assert result.already_copied_label_names == []
    labels = sorted(copy.label_id for copy in _copies_of(db_session, source.id))
    assert labels == sorted([world.polyp.id, world.adenoma.id])


def test_parent_source_includes_descendants(db_session, world, storage):
    f0, f1 = world.frames_a[:2]
    parent_region = add_region(db_session, storage, f0, world.polyp, world.user)
    child_region = add_region(db_session, storage, f1, world.polyp_ip, world.user)

    assert descendant_label_ids(db_session, world.polyp.id) == {world.polyp.id, world.polyp_ip.id}
    assert descendant_label_ids(db_session, world.polyp_ip.id) == {world.polyp_ip.id}

    result = tag_regions(
        db_session, storage, [f0.id, f1.id], world.polyp.id, world.adenoma.id, world.user,
    )

    assert result.regions == 2
    assert result.frames == 2
    assert len(_copies_of(db_session, parent_region.id)) == 1
    assert len(_copies_of(db_session, child_region.id)) == 1

    only_child = tag_regions(
        db_session, storage, [f0.id, f1.id], world.polyp_ip.id, world.ssl.id, world.user,
        dry_run=True,
    )
    assert only_child.regions == 0  # already tagged adenoma
    assert only_child.skipped_already_copied == 1


def test_descendant_label_ids_is_cycle_safe(db_session, world):
    # A loop that hierarchy validation would reject, forced directly.
    world.polyp.parent_label_id = world.polyp_ip.id
    db_session.flush()

    assert descendant_label_ids(db_session, world.polyp.id) == {world.polyp.id, world.polyp_ip.id}


def test_manual_target_type_frames_skipped_by_flag_and_not_when_off(db_session, world, storage):
    f0, f1, f2 = world.frames_a[:3]
    add_region(db_session, storage, f0, world.polyp, world.user)
    add_region(db_session, storage, f1, world.polyp, world.user)
    add_region(db_session, storage, f1, world.ssl, world.user)  # hand-drawn sub-region
    add_region(db_session, storage, f2, world.ssl, world.user)  # manual, but no source here
    frame_ids = [f0.id, f1.id, f2.id]

    skipped = tag_regions(
        db_session, storage, frame_ids, world.polyp.id, world.adenoma.id, world.user,
        dry_run=True,
    )
    assert skipped.regions == 1
    assert skipped.frames == 1
    assert skipped.frames_with_manual_regions == 2
    assert skipped.skipped_manual_frames == 1

    not_skipped = tag_regions(
        db_session, storage, frame_ids, world.polyp.id, world.adenoma.id, world.user,
        skip_manual_frames=False,
    )
    assert not_skipped.regions == 2
    assert not_skipped.frames == 2
    assert not_skipped.frames_with_manual_regions == 2
    assert not_skipped.skipped_manual_frames == 0


def test_same_evaluation_type_source_and_target_is_422(db_session, world, storage):
    f0, f1 = world.frames_a[:2]
    add_region(db_session, storage, f0, world.adenoma, world.user)
    add_region(db_session, storage, f1, world.adenoma, world.user)
    before_rows = _annotation_count(db_session)
    before_objects = dict(storage.objects)

    for dry_run in (True, False):
        with pytest.raises(HTTPException) as exc:
            tag_regions(
                db_session, storage, [f0.id, f1.id], world.adenoma.id, world.ssl.id,
                world.user, dry_run=dry_run,
            )
        assert exc.value.status_code == 422
        assert "evaluation type" in exc.value.detail

    assert _annotation_count(db_session) == before_rows
    assert storage.objects == before_objects
    assert storage.uploads == []


def test_mask_without_storage_key_is_ineligible(db_session, world, storage):
    f0, f1 = world.frames_a[:2]
    add_region(db_session, storage, f0, world.polyp, world.user, with_storage_key=False)
    add_region(db_session, storage, f1, world.polyp, world.user)
    add_region(db_session, storage, f1, world.polyp, world.user, AnnotationType.CLASSIFICATION,
               with_storage_key=False)

    assert len(eligible_sources(db_session, [f0.id, f1.id], {world.polyp.id})) == 1

    result = tag_regions(
        db_session, storage, [f0.id, f1.id], world.polyp.id, world.adenoma.id, world.user,
    )
    assert result.regions == 1
    assert result.frames == 1


def test_over_cap_is_422(db_session, world, storage, monkeypatch):
    for frame in world.frames_a[:3]:
        add_region(db_session, storage, frame, world.polyp, world.user, AnnotationType.BBOX)
    monkeypatch.setattr(tag_regions_module, "MAX_SOURCE_REGIONS", 2)

    for dry_run in (True, False):
        with pytest.raises(HTTPException) as exc:
            tag_regions(
                db_session, storage, _ids(world.frames_a[:3]), world.polyp.id,
                world.adenoma.id, world.user, dry_run=dry_run,
            )
        assert exc.value.status_code == 422


def _status_of(call) -> int:
    with pytest.raises(HTTPException) as exc:
        call()
    return exc.value.status_code


def test_validation_errors(db_session, world, storage):
    frame = world.frames_a[0]
    add_region(db_session, storage, frame, world.polyp, world.user)
    ids = [frame.id]

    def run(source_id, target_id, frame_ids=ids):
        return lambda: tag_regions(
            db_session, storage, frame_ids, source_id, target_id, world.user, dry_run=True,
        )

    assert _status_of(run(world.frame_label.id, world.adenoma.id)) == 422
    assert _status_of(run(world.polyp.id, world.frame_label.id)) == 422
    assert _status_of(run(world.polyp.id, world.abstract.id)) == 422
    assert _status_of(run(world.polyp.id, world.polyp.id)) == 422
    assert _status_of(run(999_999_999, world.adenoma.id)) == 404
    assert _status_of(run(world.polyp.id, 999_999_999)) == 404
    assert _status_of(run(world.polyp.id, world.adenoma.id, [])) == 422
    assert _status_of(
        run(world.polyp.id, world.adenoma.id, [frame.id, world.frames_b[0].id])
    ) == 422
    assert _status_of(run(world.polyp.id, world.adenoma.id, [frame.id, 999_999_999])) == 404

    # An abstract SOURCE is fine (it stands for its descendants).
    tag_regions(
        db_session, storage, ids, world.abstract_geometric.id, world.ssl.id, world.user,
        dry_run=True,
    )

    assert require_one_sequence(db_session, [frame.id, frame.id, world.frames_a[1].id]) == [
        frame.id, world.frames_a[1].id,
    ]
    result = tag_regions(
        db_session, storage, [frame.id, frame.id], world.polyp.id, world.adenoma.id, world.user,
    )
    assert result.regions == 1


def test_failure_midway_rolls_back_and_deletes_uploaded_objects(db_session, world, storage):
    f0, f1 = world.frames_a[:2]
    add_region(db_session, storage, f0, world.polyp, world.user, with_raw=False)
    add_region(db_session, storage, f1, world.polyp, world.user, with_raw=False)
    rows = _annotation_count(db_session)
    objects_before = dict(storage.objects)
    storage.fail_on_upload = 2

    with pytest.raises(RuntimeError):
        tag_regions(
            db_session, storage, [f0.id, f1.id], world.polyp.id, world.adenoma.id, world.user,
        )

    assert _annotation_count(db_session) == rows
    assert storage.objects == objects_before
    assert len(storage.uploads) == 1
    assert storage.deleted == [storage.uploads[0][0]]


def test_copy_survives_source_deletion(db_session, world, storage):
    frame = world.frames_a[0]
    source = add_region(db_session, storage, frame, world.polyp, world.user)
    tag_regions(db_session, storage, [frame.id], world.polyp.id, world.adenoma.id, world.user)
    [copy] = _copies_of(db_session, source.id)
    copy_id, copy_key = copy.id, copy.storage_key

    db_session.execute(delete(Annotation).where(Annotation.id == source.id))
    db_session.commit()
    db_session.expire_all()

    survivor = db_session.get(Annotation, copy_id)
    assert survivor is not None
    assert survivor.source_annotation_id is None
    assert survivor.storage_key == copy_key
    assert copy_key in storage.objects


# --- list_region_labels / remove_copies ---


def test_list_region_labels_counts_and_excludes_abstract_and_classification(
    db_session, world, storage
):
    f0, f1, *_ = world.frames_a
    add_region(db_session, storage, f0, world.adenoma, world.user)
    add_region(db_session, storage, f1, world.adenoma, world.user, AnnotationType.BBOX)
    add_region(db_session, storage, f0, world.ssl, world.user)
    add_region(db_session, storage, f0, world.abstract, world.user)
    add_region(db_session, storage, f0, world.frame_label, world.user, AnnotationType.CLASSIFICATION)
    add_region(db_session, storage, f1, world.ssl, world.user, with_storage_key=False)  # no geometry

    result = list_region_labels(db_session, _ids(world.frames_a))

    assert [(r.name, r.count) for r in result] == [("adenoma", 2), ("ssl", 1)]
    assert result[0].label_id == world.adenoma.id
    assert result[0].category_name == world.category.name


def test_list_includes_nonabstract_parent_with_descendant_counts(db_session, world, storage):
    f0, f1, *_ = world.frames_a
    add_region(db_session, storage, f0, world.polyp_ip, world.user)
    add_region(db_session, storage, f1, world.polyp_ip, world.user, AnnotationType.BBOX)
    add_region(db_session, storage, f1, world.polyp, world.user)

    by_name = {r.name: r.count for r in list_region_labels(db_session, _ids(world.frames_a))}

    assert by_name == {"polyp": 3, "polyp_ip": 2}


def _copy_setup(db_session, world, storage):
    f0, f1, *_ = world.frames_a
    src0 = add_region(db_session, storage, f0, world.polyp, world.user)
    src1 = add_region(db_session, storage, f1, world.polyp, world.user)
    return f0, f1, src0, src1


def test_remove_deletes_only_linked_copies_with_target_label(db_session, world, storage):
    f0, f1, src0, src1 = _copy_setup(db_session, world, storage)
    copy0 = add_region(db_session, storage, f0, world.adenoma, world.user, source_annotation_id=src0.id)
    other_label = add_region(db_session, storage, f0, world.ssl, world.user, source_annotation_id=src0.id)
    manual = add_region(db_session, storage, f1, world.adenoma, world.user)  # hand-drawn
    other_frame = add_region(db_session, storage, world.frames_a[2], world.adenoma, world.user,
                             source_annotation_id=src1.id)

    result = remove_copies(db_session, storage, [f0.id, f1.id], world.adenoma.id)

    assert (result.dry_run, result.removed, result.kept_reviewed) == (False, 1, 0)
    remaining = {a.id for a in db_session.query(Annotation).all()}
    assert copy0.id not in remaining
    assert {src0.id, src1.id, other_label.id, manual.id, other_frame.id} <= remaining


def test_remove_deletes_both_objects(db_session, world, storage):
    f0, _, src0, _ = _copy_setup(db_session, world, storage)
    copy0 = add_region(db_session, storage, f0, world.adenoma, world.user, source_annotation_id=src0.id)
    keys = {copy0.storage_key, copy0.raw_mask_storage_key}
    assert None not in keys

    remove_copies(db_session, storage, [f0.id], world.adenoma.id)

    assert set(storage.deleted) == keys
    assert not keys & set(storage.objects)
    assert src0.storage_key in storage.objects


def test_remove_keeps_reviewed_and_counts_them(db_session, world, storage):
    f0, f1, src0, src1 = _copy_setup(db_session, world, storage)
    draft = add_region(db_session, storage, f0, world.adenoma, world.user, source_annotation_id=src0.id)
    reviewed = add_region(db_session, storage, f1, world.adenoma, world.user,
                          source_annotation_id=src1.id, status=AnnotationStatus.REVIEWED)

    result = remove_copies(db_session, storage, [f0.id, f1.id], world.adenoma.id)

    assert (result.removed, result.kept_reviewed) == (1, 1)
    ids = {a.id for a in db_session.query(Annotation).all()}
    assert draft.id not in ids and reviewed.id in ids
    assert reviewed.storage_key in storage.objects


def test_remove_deletes_rejected_copies(db_session, world, storage):
    f0, _, src0, _ = _copy_setup(db_session, world, storage)
    rejected = add_region(db_session, storage, f0, world.adenoma, world.user,
                          source_annotation_id=src0.id, status=AnnotationStatus.REJECTED)
    rid = rejected.id

    result = remove_copies(db_session, storage, [f0.id], world.adenoma.id)

    assert (result.removed, result.kept_reviewed) == (1, 0)
    assert db_session.query(Annotation).filter(Annotation.id == rid).count() == 0


def test_remove_dry_run_changes_nothing(db_session, world, storage):
    f0, f1, src0, src1 = _copy_setup(db_session, world, storage)
    add_region(db_session, storage, f0, world.adenoma, world.user, source_annotation_id=src0.id)
    add_region(db_session, storage, f1, world.adenoma, world.user,
               source_annotation_id=src1.id, status=AnnotationStatus.REVIEWED)
    before_rows = _annotation_count(db_session)
    before_objects = dict(storage.objects)

    result = remove_copies(db_session, storage, [f0.id, f1.id], world.adenoma.id, dry_run=True)

    assert (result.dry_run, result.removed, result.kept_reviewed) == (True, 1, 1)
    assert _annotation_count(db_session) == before_rows
    assert storage.objects == before_objects and storage.deleted == []


def test_remove_then_create_again_works(db_session, world, storage):
    f0, *_ = world.frames_a
    add_region(db_session, storage, f0, world.polyp, world.user)
    first = tag_regions(db_session, storage, [f0.id], world.polyp.id, world.adenoma.id, world.user)
    assert first.regions == 1
    removed = remove_copies(db_session, storage, [f0.id], world.adenoma.id)
    assert removed.removed == 1

    again = tag_regions(db_session, storage, [f0.id], world.polyp.id, world.adenoma.id, world.user)

    assert again.regions == 1 and again.skipped_already_copied == 0


def test_remove_validation_errors(db_session, world, storage):
    with pytest.raises(HTTPException) as unknown:
        remove_copies(db_session, storage, [world.frames_a[0].id], 999_999_999)
    assert unknown.value.status_code == 404
    with pytest.raises(HTTPException) as cross:
        remove_copies(
            db_session, storage, [world.frames_a[0].id, world.frames_b[0].id], world.adenoma.id
        )
    assert cross.value.status_code == 422
