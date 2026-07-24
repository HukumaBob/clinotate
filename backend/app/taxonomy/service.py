from sqlalchemy import text
from sqlalchemy.orm import Session

from app.taxonomy.models import Label


def get_label_descendants(session: Session, label_id: int) -> list[Label]:
    query = text(
        """
        WITH RECURSIVE descendants AS (
            SELECT child_id AS label_id FROM label_relations WHERE parent_id = :label_id
            UNION
            SELECT lr.child_id FROM label_relations lr
            INNER JOIN descendants d ON lr.parent_id = d.label_id
        )
        SELECT label_id FROM descendants
        """
    )
    rows = session.execute(query, {"label_id": label_id}).fetchall()
    ids = [row.label_id for row in rows]
    if not ids:
        return []
    return session.query(Label).filter(Label.id.in_(ids)).all()


def get_label_tree(session: Session) -> list[dict]:
    child_ids_query = text("SELECT DISTINCT child_id FROM label_relations")
    child_ids = {row.child_id for row in session.execute(child_ids_query).fetchall()}

    all_labels = session.query(Label).all()
    roots = [label for label in all_labels if label.id not in child_ids]

    relations_query = text("SELECT parent_id, child_id FROM label_relations")
    relations = session.execute(relations_query).fetchall()
    children_by_parent: dict[int, list[int]] = {}
    for row in relations:
        children_by_parent.setdefault(row.parent_id, []).append(row.child_id)

    labels_by_id = {label.id: label for label in all_labels}

    tree = []
    for root in roots:
        child_labels = [
            labels_by_id[child_id]
            for child_id in children_by_parent.get(root.id, [])
            if child_id in labels_by_id
        ]
        tree.append({"category": root, "children": child_labels})
    return tree
