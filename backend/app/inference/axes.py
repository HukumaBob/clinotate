from sqlalchemy import distinct, func, select
from sqlalchemy.orm import Session

from app.taxonomy.models import Category, Label


def infer_axis(session: Session, class_names: list[str]) -> tuple[str, int | None] | None:
    """Guess which taxonomy category a classifier's classes belong to.

    Returns `(category name, category_id)` for the category owning the most
    distinct label names among `class_names` (ties go to the lower category
    id). `category_id` is only returned when that category owns every class;
    a model that mixes categories gets `None` for it. Duplicate label rows
    with the same name (different taxonomy versions) count once. Returns
    `None` when no class name matches a label.
    """
    wanted = set(class_names)
    if not wanted:
        return None
    count = func.count(distinct(Label.name))
    row = session.execute(
        select(Category.id, Category.name, count)
        .join(Label, Label.category_id == Category.id)
        .where(Label.name.in_(wanted))
        .group_by(Category.id, Category.name)
        .order_by(count.desc(), Category.id)
        .limit(1)
    ).first()
    if row is None:
        return None
    category_id, name, owned = row
    return name, (category_id if owned == len(wanted) else None)
