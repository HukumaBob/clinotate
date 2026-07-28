from collections import deque

from sqlalchemy.orm import Session

from app.taxonomy.models import Category, EvaluationType, Label, Procedure


def _resolve_category_key(tag_key: str, parent_keys_by_child_key: dict[str, list[str]]) -> str | None:
    """Walk up the parent chain from ``tag_key`` to find its owning category.

    Yesterday's export encodes "tag belongs to category" as a chain of
    LabelRelation-style edges, not a single hop: a tag's immediate parent may
    itself be an ordinary tag (not a category root), and a tag may have more
    than one parent. Resolve this with a deterministic BFS over the reverse
    adjacency (child -> parents), always exploring parents in the order they
    appear in the source ``relations`` list, and returning the first key
    encountered that starts with ``"category::"``.

    A cycle (a key revisited on the current traversal) means no category is
    resolvable for this tag; return ``None`` in that case rather than
    looping forever.
    """
    queue: deque[str] = deque([tag_key])
    seen: set[str] = {tag_key}

    while queue:
        current = queue.popleft()
        for parent_key in parent_keys_by_child_key.get(current, []):
            if parent_key.startswith("category::"):
                return parent_key
            if parent_key in seen:
                continue  # cycle detected on this path; don't loop forever
            seen.add(parent_key)
            queue.append(parent_key)

    return None


def import_taxonomy(session: Session, data: dict) -> None:
    procedure_by_name: dict[str, Procedure] = {}
    for name in data["procedures"]:
        procedure = session.query(Procedure).filter_by(name=name).one_or_none()
        if procedure is None:
            procedure = Procedure(name=name)
            session.add(procedure)
            session.flush()
        procedure_by_name[name] = procedure

    label_entries_by_key = {entry["key"]: entry for entry in data["labels"]}

    # Reverse adjacency (child key -> list of parent keys, in relations-list
    # order) recovered from the old LabelRelation-style edges. A tag's
    # category is found by walking up this chain until a "category::" key is
    # reached -- see _resolve_category_key.
    parent_keys_by_child_key: dict[str, list[str]] = {}
    for relation in data["relations"]:
        parent_keys_by_child_key.setdefault(relation["child_key"], []).append(relation["parent_key"])

    category_by_key: dict[str, Category] = {}
    evaluation_type_by_name: dict[str, EvaluationType] = {}
    label_by_key: dict[str, Label] = {}

    for key, entry in label_entries_by_key.items():
        if key.startswith("category::"):
            continue  # synthetic category-root entries are not imported as Label rows anymore

        category_key = _resolve_category_key(key, parent_keys_by_child_key)
        if category_key is None:
            continue  # unresolvable (e.g. a self-loop / cycle in the source data) -- skip defensively rather than crash
        category_entry = label_entries_by_key[category_key]
        procedure = procedure_by_name[entry["procedure"]]

        if category_key not in category_by_key:
            category = (
                session.query(Category)
                .filter_by(name=category_entry["name"], procedure_id=procedure.id)
                .one_or_none()
            )
            if category is None:
                category = Category(name=category_entry["name"], procedure_id=procedure.id)
                session.add(category)
                session.flush()
            category_by_key[category_key] = category
        category = category_by_key[category_key]

        evaluation_type_name = entry["label_type"]
        if evaluation_type_name not in evaluation_type_by_name:
            evaluation_type = (
                session.query(EvaluationType).filter_by(name=evaluation_type_name).one_or_none()
            )
            if evaluation_type is None:
                evaluation_type = EvaluationType(name=evaluation_type_name)
                session.add(evaluation_type)
                session.flush()
            evaluation_type_by_name[evaluation_type_name] = evaluation_type
        evaluation_type = evaluation_type_by_name[evaluation_type_name]

        label = (
            session.query(Label)
            .filter_by(name=entry["name"], category_id=category.id, evaluation_type_id=evaluation_type.id)
            .one_or_none()
        )
        if label is None:
            label = Label(
                name=entry["name"],
                color=entry["color"],
                category_id=category.id,
                evaluation_type_id=evaluation_type.id,
            )
            session.add(label)
            session.flush()
        label_by_key[key] = label

    session.commit()
