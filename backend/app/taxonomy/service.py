from sqlalchemy.orm import Session

from app.taxonomy.models import Category, EvaluationType, Label


def get_taxonomy_tree(session: Session, procedure_id: int) -> list[dict]:
    categories = (
        session.query(Category)
        .filter(Category.procedure_id == procedure_id)
        .order_by(Category.name)
        .all()
    )
    all_evaluation_types = session.query(EvaluationType).order_by(EvaluationType.name).all()
    category_ids = [c.id for c in categories]
    labels = (
        session.query(Label).filter(Label.category_id.in_(category_ids)).all()
        if category_ids
        else []
    )
    labels_by_category_and_type: dict[tuple[int, int], list[Label]] = {}
    for label in labels:
        key = (label.category_id, label.evaluation_type_id)
        labels_by_category_and_type.setdefault(key, []).append(label)

    tree = []
    for category in categories:
        evaluation_type_nodes = []
        for evaluation_type in all_evaluation_types:
            matching = labels_by_category_and_type.get((category.id, evaluation_type.id), [])
            if not matching:
                continue
            evaluation_type_nodes.append(
                {"evaluation_type": evaluation_type, "labels": matching}
            )
        tree.append({"category": category, "evaluation_types": evaluation_type_nodes})
    return tree
