"""Verifies the whole-frame quality labels landed in frame_classification.

These assertions run against whatever database the suite is pointed at, and
they are name-based rather than id-based so they hold in both the dev and the
test database.
"""

from app.db import SessionLocal
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label

WHOLE_FRAME_QUALITY_NAMES = ("bad_picture", "close_focus", "dirty_optic")


def _labels_named(session, name):
    return session.query(Label).filter(Label.name == name).all()


def test_whole_frame_quality_labels_are_frame_scoped():
    session = SessionLocal()
    try:
        for name in WHOLE_FRAME_QUALITY_NAMES:
            labels = _labels_named(session, name)
            assert labels, f"expected at least one {name} label"
            for label in labels:
                evaluation_type = session.get(EvaluationType, label.evaluation_type_id)
                assert evaluation_type.name == "frame_classification", (
                    f"{name} (id {label.id}) is still {evaluation_type.name}"
                )
                assert evaluation_type.annotation_scope == AnnotationScope.FRAME
    finally:
        session.close()


def test_whole_frame_quality_labels_hang_under_low_quality_of_their_procedure():
    session = SessionLocal()
    try:
        for name in WHOLE_FRAME_QUALITY_NAMES:
            for label in _labels_named(session, name):
                assert label.parent_label_id is not None, f"{name} has no parent"
                parent = session.get(Label, label.parent_label_id)
                assert parent.name == "low_quality"
                child_category = session.get(Category, label.category_id)
                parent_category = session.get(Category, parent.category_id)
                assert child_category.procedure_id == parent_category.procedure_id
    finally:
        session.close()


def test_every_procedure_with_moved_labels_has_its_own_low_quality():
    session = SessionLocal()
    try:
        low_quality_procedures = set()
        for label in _labels_named(session, "low_quality"):
            category = session.get(Category, label.category_id)
            low_quality_procedures.add(category.procedure_id)

        for name in WHOLE_FRAME_QUALITY_NAMES:
            for label in _labels_named(session, name):
                category = session.get(Category, label.category_id)
                assert category.procedure_id in low_quality_procedures
    finally:
        session.close()


def test_low_quality_is_concrete_not_abstract():
    # "The frame is bad, the reason does not matter" is a legitimate call;
    # forcing annotators to always name a cause would slow annotation down for
    # data nobody needs.
    session = SessionLocal()
    try:
        for label in _labels_named(session, "low_quality"):
            assert label.is_abstract is False
    finally:
        session.close()


def test_region_scoped_quality_labels_were_not_moved():
    # Foam and feces occupy a specific part of the frame and must stay
    # outlineable; only labels describing the whole frame moved.
    session = SessionLocal()
    try:
        for name in ("foam", "feces", "mucus", "bilis", "liquor", "bad_preparation"):
            for label in _labels_named(session, name):
                evaluation_type = session.get(EvaluationType, label.evaluation_type_id)
                assert evaluation_type.annotation_scope == AnnotationScope.REGION, (
                    f"{name} (id {label.id}) should have stayed region-scoped"
                )
    finally:
        session.close()
