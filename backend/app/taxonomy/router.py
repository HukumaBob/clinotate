from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.db import get_session
from app.taxonomy.models import Label, LabelRelation, Procedure
from app.taxonomy.schemas import (
    LabelCreate,
    LabelRead,
    LabelRelationCreate,
    ProcedureCreate,
    ProcedureRead,
)
from app.taxonomy.service import get_label_descendants

router = APIRouter(prefix="/taxonomy", tags=["taxonomy"], dependencies=[Depends(get_current_user)])


@router.post("/procedures", response_model=ProcedureRead, status_code=status.HTTP_201_CREATED)
def create_procedure(payload: ProcedureCreate, session: Session = Depends(get_session)) -> Procedure:
    procedure = Procedure(name=payload.name)
    session.add(procedure)
    session.commit()
    session.refresh(procedure)
    return procedure


@router.get("/procedures", response_model=list[ProcedureRead])
def list_procedures(session: Session = Depends(get_session)) -> list[Procedure]:
    return session.query(Procedure).all()


@router.post("/labels", response_model=LabelRead, status_code=status.HTTP_201_CREATED)
def create_label(payload: LabelCreate, session: Session = Depends(get_session)) -> Label:
    label = Label(**payload.model_dump())
    session.add(label)
    session.commit()
    session.refresh(label)
    return label


@router.get("/labels", response_model=list[LabelRead])
def list_labels(procedure_id: int | None = None, session: Session = Depends(get_session)) -> list[Label]:
    query = session.query(Label)
    if procedure_id is not None:
        query = query.filter(Label.procedure_id == procedure_id)
    return query.all()


@router.post("/labels/relations", status_code=status.HTTP_201_CREATED)
def create_label_relation(payload: LabelRelationCreate, session: Session = Depends(get_session)) -> dict[str, int]:
    relation = LabelRelation(**payload.model_dump())
    session.add(relation)
    session.commit()
    return {"id": relation.id}


@router.get("/labels/{label_id}/descendants", response_model=list[LabelRead])
def label_descendants(label_id: int, session: Session = Depends(get_session)) -> list[Label]:
    return get_label_descendants(session, label_id)
