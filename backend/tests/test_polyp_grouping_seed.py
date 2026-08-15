"""The polyp grouping is seeded so the balance panel has a default to collapse.

Name-based rather than id-based, so it holds in any environment whose
taxonomy was imported separately.

Procedures are independent (same reasoning that made quality labels
procedure-specific): egds and colono each get their own `polyp` grouping
parent, scoped to their own category, even though some subtype names are
shared across procedures. Assertions below are procedure-scoped for that
reason.
"""

import app.main  # noqa: F401 -- registers every model on Base.metadata for create_all
from app.db import SessionLocal
from app.taxonomy.models import Category, Label, Procedure

# procedure_name -> subtype names that exist under it
SUBTYPES_BY_PROCEDURE = {
    "colono": (
        "pedunculated_polyp_0_Ip",
        "sessile_polyp_0_Is",
        "flat_lesion_0_IIa",
        "lst_g_nodular_mixed",
        "lst_ng_flat_elevated",
    ),
    "egds": (
        "pedunculated_polyp_0_Ip",
        "sessile_polyp_0_Is",
        "flat_lesion_0_IIa",
    ),
}


def _label_in(session, name, procedure_name):
    return (
        session.query(Label)
        .join(Category, Category.id == Label.category_id)
        .join(Procedure, Procedure.id == Category.procedure_id)
        .filter(Label.name == name, Procedure.name == procedure_name)
        .order_by(Label.id)
        .first()
    )


def test_polyp_parent_exists_and_is_abstract_for_each_procedure():
    session = SessionLocal()
    try:
        for procedure_name in SUBTYPES_BY_PROCEDURE:
            polyp = _label_in(session, "polyp", procedure_name)
            assert polyp is not None, f"expected a 'polyp' grouping label for {procedure_name}"
            assert polyp.is_abstract is True, "polyp is a grouping container, not annotatable"
    finally:
        session.close()


def test_all_subtypes_hang_under_their_procedures_polyp():
    session = SessionLocal()
    try:
        for procedure_name, subtypes in SUBTYPES_BY_PROCEDURE.items():
            polyp = _label_in(session, "polyp", procedure_name)
            assert polyp is not None
            for name in subtypes:
                label = _label_in(session, name, procedure_name)
                assert label is not None, f"missing subtype {name} for {procedure_name}"
                assert label.parent_label_id == polyp.id, (
                    f"{name} ({procedure_name}) is not parented to that procedure's polyp"
                )
    finally:
        session.close()


def test_polyp_shares_category_and_scope_with_its_children_per_procedure():
    # The hierarchy invariants require same procedure and same annotation_scope.
    # Sharing the children's category satisfies both at once. Each procedure's
    # polyp must only share category/scope with that procedure's own children,
    # never bleed across procedures.
    session = SessionLocal()
    try:
        for procedure_name, subtypes in SUBTYPES_BY_PROCEDURE.items():
            polyp = _label_in(session, "polyp", procedure_name)
            assert polyp is not None
            for name in subtypes:
                label = _label_in(session, name, procedure_name)
                assert label.category_id == polyp.category_id
                assert label.evaluation_type_id == polyp.evaluation_type_id
    finally:
        session.close()
