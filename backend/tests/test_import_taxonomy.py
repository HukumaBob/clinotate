import app.main  # noqa: F401 -- registers every model on Base.metadata for test_engine's create_all/drop_all
from app.taxonomy.import_taxonomy import import_taxonomy
from app.taxonomy.models import Label, LabelRelation, Procedure


def test_creates_procedures_labels_and_relations(db_session):
    data = {
        "procedures": ["egds"],
        "labels": [
            {"key": "root", "name": "Anatomy", "procedure": "egds", "color": "#FFFFFF", "label_type": "geometric"},
            {"key": "child", "name": "Stomach", "procedure": "egds", "color": "#ABCDEF", "label_type": "geometric"},
        ],
        "relations": [{"parent_key": "root", "child_key": "child"}],
    }

    import_taxonomy(db_session, data)

    procedure = db_session.query(Procedure).filter_by(name="egds").one()
    root = db_session.query(Label).filter_by(name="Anatomy", procedure_id=procedure.id).one()
    child = db_session.query(Label).filter_by(name="Stomach", procedure_id=procedure.id).one()
    assert child.color == "#ABCDEF"
    assert child.label_type.value == "geometric"

    relation = db_session.query(LabelRelation).filter_by(parent_id=root.id, child_id=child.id).one()
    assert relation.confidence == 1.0


def test_is_idempotent_when_run_twice(db_session):
    data = {
        "procedures": ["egds"],
        "labels": [
            {"key": "root", "name": "Anatomy", "procedure": "egds", "color": "#FFFFFF", "label_type": "geometric"},
            {"key": "child", "name": "Stomach", "procedure": "egds", "color": "#ABCDEF", "label_type": "geometric"},
        ],
        "relations": [{"parent_key": "root", "child_key": "child"}],
    }

    import_taxonomy(db_session, data)
    import_taxonomy(db_session, data)

    assert db_session.query(Procedure).filter_by(name="egds").count() == 1
    assert db_session.query(Label).filter_by(name="Anatomy").count() == 1
    assert db_session.query(Label).filter_by(name="Stomach").count() == 1
    assert db_session.query(LabelRelation).count() == 1


def test_reuses_existing_procedure_across_multiple_calls(db_session):
    db_session.add(Procedure(name="egds"))
    db_session.commit()

    data = {
        "procedures": ["egds"],
        "labels": [
            {"key": "root", "name": "Anatomy", "procedure": "egds", "color": "#FFFFFF", "label_type": "geometric"},
        ],
        "relations": [],
    }

    import_taxonomy(db_session, data)

    assert db_session.query(Procedure).filter_by(name="egds").count() == 1


def test_does_not_touch_existing_unrelated_labels(db_session):
    existing = Label(name="lesion", label_type="morphological", color="#22d3ee", taxonomy_version=1)
    db_session.add(existing)
    db_session.commit()
    existing_id = existing.id

    data = {
        "procedures": ["egds"],
        "labels": [
            {"key": "root", "name": "Anatomy", "procedure": "egds", "color": "#FFFFFF", "label_type": "geometric"},
        ],
        "relations": [],
    }

    import_taxonomy(db_session, data)

    untouched = db_session.get(Label, existing_id)
    assert untouched.name == "lesion"
    assert untouched.color == "#22d3ee"
