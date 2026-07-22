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
