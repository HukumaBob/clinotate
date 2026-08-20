import app.db as db_module
from app.taxonomy.models import Category, EvaluationType, Label, Procedure
from app.taxonomy.models import AnnotationScope
import app.main  # noqa: F401 -- registers every model on Base.metadata for test_engine's create_all/drop_all


def _make_label(session, name, procedure_name="hier-proc", scope=AnnotationScope.REGION):
    """Create a Label (plus its Procedure/Category/EvaluationType) for tests."""
    procedure = session.query(Procedure).filter_by(name=procedure_name).one_or_none()
    if procedure is None:
        procedure = Procedure(name=procedure_name)
        session.add(procedure)
        session.flush()
    category = (
        session.query(Category).filter_by(name="hier-cat", procedure_id=procedure.id).one_or_none()
    )
    if category is None:
        category = Category(name="hier-cat", procedure_id=procedure.id)
        session.add(category)
        session.flush()
    et_name = f"hier-et-{scope.value}"
    evaluation_type = session.query(EvaluationType).filter_by(name=et_name).one_or_none()
    if evaluation_type is None:
        evaluation_type = EvaluationType(name=et_name, annotation_scope=scope)
        session.add(evaluation_type)
        session.flush()
    label = Label(
        name=name,
        category_id=category.id,
        evaluation_type_id=evaluation_type.id,
    )
    session.add(label)
    session.flush()
    return label


def test_label_defaults_to_no_parent_and_not_abstract():
    session = db_module.SessionLocal()
    try:
        label = _make_label(session, "hier-plain")
        session.commit()
        session.refresh(label)
        assert label.parent_label_id is None
        assert label.is_abstract is False
    finally:
        session.rollback()
        session.close()


def test_label_can_reference_a_parent_label():
    session = db_module.SessionLocal()
    try:
        parent = _make_label(session, "hier-parent")
        child = _make_label(session, "hier-child")
        child.parent_label_id = parent.id
        parent.is_abstract = True
        session.commit()
        session.refresh(child)
        session.refresh(parent)
        assert child.parent_label_id == parent.id
        assert parent.is_abstract is True
    finally:
        session.rollback()
        session.close()


import pytest

from app.taxonomy.hierarchy import HierarchyError, validate_parent_assignment


def test_parent_from_a_different_procedure_is_rejected():
    session = db_module.SessionLocal()
    try:
        child = _make_label(session, "hier-child-proc-a", procedure_name="hier-proc-a")
        parent = _make_label(session, "hier-parent-proc-b", procedure_name="hier-proc-b")
        with pytest.raises(HierarchyError):
            validate_parent_assignment(session, child, parent.id)
    finally:
        session.rollback()
        session.close()


def test_parent_with_a_different_annotation_scope_is_rejected():
    session = db_module.SessionLocal()
    try:
        child = _make_label(session, "hier-region-child", scope=AnnotationScope.REGION)
        parent = _make_label(session, "hier-frame-parent", scope=AnnotationScope.FRAME)
        with pytest.raises(HierarchyError):
            validate_parent_assignment(session, child, parent.id)
    finally:
        session.rollback()
        session.close()


def test_direct_self_parent_is_rejected():
    session = db_module.SessionLocal()
    try:
        label = _make_label(session, "hier-self")
        with pytest.raises(HierarchyError):
            validate_parent_assignment(session, label, label.id)
    finally:
        session.rollback()
        session.close()


def test_indirect_cycle_is_rejected():
    session = db_module.SessionLocal()
    try:
        grandparent = _make_label(session, "hier-gp")
        parent = _make_label(session, "hier-p")
        child = _make_label(session, "hier-c")
        parent.parent_label_id = grandparent.id
        child.parent_label_id = parent.id
        session.flush()
        # Making the grandparent a child of its own descendant closes a loop.
        with pytest.raises(HierarchyError):
            validate_parent_assignment(session, grandparent, child.id)
    finally:
        session.rollback()
        session.close()


def test_unknown_parent_is_rejected():
    session = db_module.SessionLocal()
    try:
        label = _make_label(session, "hier-orphan")
        with pytest.raises(HierarchyError):
            validate_parent_assignment(session, label, 99999999)
    finally:
        session.rollback()
        session.close()


def test_valid_parent_assignment_passes():
    session = db_module.SessionLocal()
    try:
        parent = _make_label(session, "hier-ok-parent")
        child = _make_label(session, "hier-ok-child")
        assert validate_parent_assignment(session, child, parent.id) is None
    finally:
        session.rollback()
        session.close()


def test_clearing_the_parent_is_always_allowed():
    session = db_module.SessionLocal()
    try:
        label = _make_label(session, "hier-clear")
        assert validate_parent_assignment(session, label, None) is None
    finally:
        session.rollback()
        session.close()
