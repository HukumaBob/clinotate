import app.main  # noqa: F401 -- registers every model on Base.metadata

from app.inference.axes import infer_axis
from app.taxonomy.models import AnnotationScope, Category, EvaluationType, Label, Procedure


def _seed(session, categories: dict[str, list[str]]) -> dict[str, int]:
    """Creates categories (in dict order) with the given label names; returns name -> id."""
    procedure = Procedure(name="axes-infer-proc")
    evaluation_type = EvaluationType(name="axes-infer-eval", annotation_scope=AnnotationScope.FRAME)
    session.add_all([procedure, evaluation_type])
    session.flush()
    ids: dict[str, int] = {}
    for name, labels in categories.items():
        category = Category(name=name, procedure_id=procedure.id)
        session.add(category)
        session.flush()
        ids[name] = category.id
        for label_name in labels:
            session.add(
                Label(
                    name=label_name,
                    category_id=category.id,
                    evaluation_type_id=evaluation_type.id,
                )
            )
    session.flush()
    return ids


def test_all_classes_in_one_category_returns_name_and_id(db_session):
    ids = _seed(db_session, {"Quality": ["good_quality", "low_quality"], "Other": ["x"]})
    assert infer_axis(db_session, ["good_quality", "low_quality"]) == ("Quality", ids["Quality"])


def test_mixed_categories_return_the_majority_without_an_id(db_session):
    anatomy = [f"organ_{i}" for i in range(6)]
    _seed(db_session, {"Anatomy": anatomy, "Artifacts": ["outside_the_body"]})
    assert infer_axis(db_session, [*anatomy, "outside_the_body"]) == ("Anatomy", None)


def test_duplicate_label_names_count_once(db_session):
    # Artifacts holds one name twice (two taxonomy versions); Anatomy holds two distinct names.
    ids = _seed(
        db_session,
        {"Artifacts": ["dup", "dup", "dup"], "Anatomy": ["a", "b"]},
    )
    assert infer_axis(db_session, ["dup", "a", "b"]) == ("Anatomy", None)
    assert infer_axis(db_session, ["dup"]) == ("Artifacts", ids["Artifacts"])


def test_no_matching_label_returns_none(db_session):
    _seed(db_session, {"Anatomy": ["a"]})
    assert infer_axis(db_session, ["nothing", "nope"]) is None
    assert infer_axis(db_session, []) is None


def test_tie_picks_the_lower_category_id(db_session):
    ids = _seed(db_session, {"First": ["p"], "Second": ["q"]})
    assert ids["First"] < ids["Second"]
    assert infer_axis(db_session, ["q", "p"]) == ("First", None)
