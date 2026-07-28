from sqlalchemy.orm import Session

from app.taxonomy.models import Label, LabelRelation, Procedure


def import_taxonomy(session: Session, data: dict) -> None:
    procedure_by_name: dict[str, Procedure] = {}
    for name in data["procedures"]:
        procedure = session.query(Procedure).filter_by(name=name).one_or_none()
        if procedure is None:
            procedure = Procedure(name=name)
            session.add(procedure)
            session.flush()
        procedure_by_name[name] = procedure

    label_by_key: dict[str, Label] = {}
    for entry in data["labels"]:
        procedure = procedure_by_name[entry["procedure"]]
        label = (
            session.query(Label)
            .filter_by(name=entry["name"], procedure_id=procedure.id)
            .one_or_none()
        )
        if label is None:
            label = Label(
                name=entry["name"],
                label_type=entry["label_type"],
                color=entry["color"],
                procedure_id=procedure.id,
            )
            session.add(label)
            session.flush()
        label_by_key[entry["key"]] = label

    for relation in data["relations"]:
        parent = label_by_key[relation["parent_key"]]
        child = label_by_key[relation["child_key"]]
        existing = (
            session.query(LabelRelation)
            .filter_by(parent_id=parent.id, child_id=child.id)
            .one_or_none()
        )
        if existing is None:
            session.add(LabelRelation(parent_id=parent.id, child_id=child.id, confidence=1.0))

    session.commit()
