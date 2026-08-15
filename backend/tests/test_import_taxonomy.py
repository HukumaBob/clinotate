import app.main  # noqa: F401 -- registers every model on Base.metadata for test_engine's create_all/drop_all
from app.taxonomy.import_taxonomy import import_taxonomy
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure


def _sample_data() -> dict:
    return {
        "procedures": ["egds"],
        "evaluation_types": [{"name": "geometric", "scope": "region"}],
        "labels": [
            {
                "key": "category::anatomy::egds",
                "name": "Anatomy",
                "procedure": "egds",
                "color": "#FFFFFF",
                "label_type": "geometric",
            },
            {
                "key": "pharynx::egds",
                "name": "pharynx",
                "procedure": "egds",
                "color": "#2E81DA",
                "label_type": "geometric",
            },
        ],
        "relations": [{"parent_key": "category::anatomy::egds", "child_key": "pharynx::egds"}],
    }


def test_sets_annotation_scope_from_evaluation_types_array(db_session):
    import_taxonomy(db_session, _sample_data())

    evaluation_type = db_session.query(EvaluationType).filter_by(name="geometric").one()
    assert evaluation_type.annotation_scope == AnnotationScope.REGION


def test_raises_clear_error_when_label_type_has_no_evaluation_types_entry(db_session):
    data = {
        "procedures": ["egds"],
        "evaluation_types": [],
        "labels": [
            {
                "key": "category::anatomy::egds",
                "name": "Anatomy",
                "procedure": "egds",
                "color": "#FFFFFF",
                "label_type": "geometric",
            },
            {
                "key": "pharynx::egds",
                "name": "pharynx",
                "procedure": "egds",
                "color": "#2E81DA",
                "label_type": "geometric",
            },
        ],
        "relations": [{"parent_key": "category::anatomy::egds", "child_key": "pharynx::egds"}],
    }

    try:
        import_taxonomy(db_session, data)
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "geometric" in str(exc)
        assert "evaluation_types" in str(exc)


def test_creates_procedure_category_evaluation_type_and_label(db_session):
    import_taxonomy(db_session, _sample_data())

    procedure = db_session.query(Procedure).filter_by(name="egds").one()
    category = db_session.query(Category).filter_by(name="Anatomy", procedure_id=procedure.id).one()
    evaluation_type = db_session.query(EvaluationType).filter_by(name="geometric").one()
    label = db_session.query(Label).filter_by(name="pharynx").one()

    assert label.category_id == category.id
    assert label.evaluation_type_id == evaluation_type.id
    assert label.color == "#2E81DA"


def test_does_not_import_synthetic_category_root_entries_as_labels(db_session):
    import_taxonomy(db_session, _sample_data())

    assert db_session.query(Label).filter_by(name="Anatomy").count() == 0


def test_is_idempotent_when_run_twice(db_session):
    data = _sample_data()

    import_taxonomy(db_session, data)
    import_taxonomy(db_session, data)

    assert db_session.query(Procedure).filter_by(name="egds").count() == 1
    assert db_session.query(Category).filter_by(name="Anatomy").count() == 1
    assert db_session.query(EvaluationType).filter_by(name="geometric").count() == 1
    assert db_session.query(Label).filter_by(name="pharynx").count() == 1


def test_reuses_existing_procedure_across_multiple_calls(db_session):
    db_session.add(Procedure(name="egds"))
    db_session.commit()

    import_taxonomy(db_session, _sample_data())

    assert db_session.query(Procedure).filter_by(name="egds").count() == 1


def test_resolves_category_transitively_through_intermediate_tag_parent(db_session):
    # "uvula" is not a direct child of the category root -- it hangs off
    # "pharynx", which is itself the direct child of the category root. The
    # resolver must walk up the chain rather than only checking one hop.
    data = {
        "procedures": ["egds"],
        "evaluation_types": [{"name": "geometric", "scope": "region"}],
        "labels": [
            {
                "key": "category::anatomy::egds",
                "name": "Anatomy",
                "procedure": "egds",
                "color": "#FFFFFF",
                "label_type": "geometric",
            },
            {
                "key": "pharynx::egds",
                "name": "pharynx",
                "procedure": "egds",
                "color": "#2E81DA",
                "label_type": "geometric",
            },
            {
                "key": "uvula::egds",
                "name": "uvula",
                "procedure": "egds",
                "color": "#123456",
                "label_type": "geometric",
            },
        ],
        "relations": [
            {"parent_key": "category::anatomy::egds", "child_key": "pharynx::egds"},
            {"parent_key": "pharynx::egds", "child_key": "uvula::egds"},
        ],
    }

    import_taxonomy(db_session, data)

    category = db_session.query(Category).filter_by(name="Anatomy").one()
    label = db_session.query(Label).filter_by(name="uvula").one()
    assert label.category_id == category.id


def test_resolves_multi_parent_tag_to_first_path_in_relations_order(db_session):
    # "gastroesophageal_junction" has two parents; per the agreed tiebreak
    # rule, the category reached via the FIRST relation in list order wins.
    data = {
        "procedures": ["egds"],
        "evaluation_types": [{"name": "geometric", "scope": "region"}],
        "labels": [
            {
                "key": "category::anatomy::egds",
                "name": "Anatomy",
                "procedure": "egds",
                "color": "#FFFFFF",
                "label_type": "geometric",
            },
            {
                "key": "category::findings::egds",
                "name": "Findings",
                "procedure": "egds",
                "color": "#FFFFFF",
                "label_type": "geometric",
            },
            {
                "key": "gej::egds",
                "name": "gastroesophageal_junction",
                "procedure": "egds",
                "color": "#654321",
                "label_type": "geometric",
            },
        ],
        "relations": [
            {"parent_key": "category::anatomy::egds", "child_key": "gej::egds"},
            {"parent_key": "category::findings::egds", "child_key": "gej::egds"},
        ],
    }

    import_taxonomy(db_session, data)

    anatomy = db_session.query(Category).filter_by(name="Anatomy").one()
    label = db_session.query(Label).filter_by(name="gastroesophageal_junction").one()
    assert label.category_id == anatomy.id


def test_skips_tag_with_self_loop_relation_and_no_other_parent(db_session):
    # Mirrors the real "close_focus::colono" data-entry error: a tag whose
    # only relation is a self-loop has no resolvable category and must be
    # skipped, not crash or infinite-loop.
    data = {
        "procedures": ["colono"],
        "evaluation_types": [{"name": "geometric", "scope": "region"}],
        "labels": [
            {
                "key": "category::quality::colono",
                "name": "Quality",
                "procedure": "colono",
                "color": "#FFFFFF",
                "label_type": "geometric",
            },
            {
                "key": "close_focus::colono",
                "name": "close_focus",
                "procedure": "colono",
                "color": "#ABCDEF",
                "label_type": "geometric",
            },
        ],
        "relations": [{"parent_key": "close_focus::colono", "child_key": "close_focus::colono"}],
    }

    import_taxonomy(db_session, data)

    assert db_session.query(Label).filter_by(name="close_focus").count() == 0
