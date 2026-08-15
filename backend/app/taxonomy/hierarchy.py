from dataclasses import dataclass, field

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


@dataclass(frozen=True)
class LabelNode:
    id: int
    parent_label_id: int | None
    is_abstract: bool


@dataclass(frozen=True)
class LabelTree:
    nodes: dict[int, LabelNode]

    def has_children(self, label_id: int) -> bool:
        return any(node.parent_label_id == label_id for node in self.nodes.values())


@dataclass(frozen=True)
class GroupingRules:
    """A dataset's deviations from the taxonomy's default grouping.

    Empty rules mean "exactly as the taxonomy says" -- which is what makes the
    knob remember its position instead of starting from zero every time.
    """

    collapse: frozenset[int] = field(default_factory=frozenset)
    expand: frozenset[int] = field(default_factory=frozenset)

    def is_collapsed(self, tree: LabelTree, label_id: int) -> bool:
        if label_id in self.expand:
            return False
        if label_id in self.collapse:
            return True
        return tree.has_children(label_id)


def build_label_tree(session: Session) -> LabelTree:
    """Load every label's hierarchy position in one query.

    ~200 labels today; a recursive CTE would be more machinery than the whole
    tree costs to hold in memory, and it will still be hundreds of kilobytes
    at thousands of labels.
    """
    rows = session.query(Label.id, Label.parent_label_id, Label.is_abstract).all()
    return LabelTree(
        nodes={
            row.id: LabelNode(
                id=row.id, parent_label_id=row.parent_label_id, is_abstract=row.is_abstract
            )
            for row in rows
        }
    )


def resolve_class(label_id: int, tree: LabelTree, rules: GroupingRules) -> int:
    """Return the label_id whose name this annotation's export class takes.

    Walk up the parent chain, remembering the *highest* collapsed ancestor --
    highest rather than first, so that under multi-level trees collapsing
    `polyp` beats collapsing `LST` instead of the answer depending on
    traversal order.

    A concrete parent's own direct annotations need no special case: the
    parent resolves to itself and its children resolve to the parent, so both
    land in the same class.
    """
    node = tree.nodes.get(label_id)
    if node is None:
        return label_id

    resolved = label_id
    seen: set[int] = {label_id}
    current = node
    while current.parent_label_id is not None:
        parent_id = current.parent_label_id
        if parent_id in seen:  # defensive: a loop that validation did not catch
            break
        seen.add(parent_id)
        parent = tree.nodes.get(parent_id)
        if parent is None:
            break
        if rules.is_collapsed(tree, parent_id):
            resolved = parent_id
        current = parent

    return resolved
