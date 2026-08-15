from app.db import SessionLocal
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
    session = SessionLocal()
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
    session = SessionLocal()
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
