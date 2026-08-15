from sqlalchemy.orm import Session

from app.taxonomy.models import Category, EvaluationType, Label


class HierarchyError(Exception):
    """A proposed parent assignment violates a taxonomy hierarchy invariant."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def _procedure_id_of(session: Session, label: Label) -> int | None:
    category = session.get(Category, label.category_id)
    return None if category is None else category.procedure_id


def _scope_of(session: Session, label: Label):
    evaluation_type = session.get(EvaluationType, label.evaluation_type_id)
    return None if evaluation_type is None else evaluation_type.annotation_scope


def validate_parent_assignment(
    session: Session, label: Label, parent_label_id: int | None
) -> None:
    """Raise HierarchyError unless ``parent_label_id`` is a legal parent for ``label``.

    Three invariants, all enforced here rather than in the schema:

    1. The parent belongs to the same procedure. Procedure is only reachable
       through Category, so a composite foreign key would cost more than it is
       worth -- and quality labels are deliberately procedure-specific, which
       makes this check load-bearing rather than cosmetic.
    2. No cycles. Without this, class resolution would loop at export time
       instead of failing where the mistake was made.
    3. The parent shares the child's annotation_scope. Otherwise a mask label
       could hang under a whole-frame parent and export would emit a class
       mixing bounding boxes with frame-level marks -- the category error
       AnnotationScope exists to prevent, entered from the other side.
    """
    if parent_label_id is None:
        return

    if parent_label_id == label.id:
        raise HierarchyError("A label cannot be its own parent")

    parent = session.get(Label, parent_label_id)
    if parent is None:
        raise HierarchyError(f"Parent label {parent_label_id} does not exist")

    if _procedure_id_of(session, parent) != _procedure_id_of(session, label):
        raise HierarchyError("Parent label must belong to the same procedure as its child")

    if _scope_of(session, parent) != _scope_of(session, label):
        raise HierarchyError("Parent label must have the same annotation scope as its child")

    # Walk up from the proposed parent; reaching `label` would close a loop.
    seen: set[int] = set()
    current = parent
    while current is not None:
        if current.id == label.id:
            raise HierarchyError("Parent assignment would create a cycle")
        if current.id in seen:
            break  # pre-existing loop elsewhere in the tree; not this assignment's fault
        seen.add(current.id)
        current = (
            None
            if current.parent_label_id is None
            else session.get(Label, current.parent_label_id)
        )
