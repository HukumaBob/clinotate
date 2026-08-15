from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.annotation.models import Annotation
from app.auth.dependencies import get_current_user
from app.db import get_session
from app.taxonomy.hierarchy import HierarchyError, validate_parent_assignment
from app.taxonomy.models import Category, EvaluationType, Label, Procedure
from app.taxonomy.schemas import (
    CategoryCreate,
    CategoryRead,
    CategoryUpdate,
    EvaluationTypeCreate,
    EvaluationTypeRead,
    EvaluationTypeUpdate,
    LabelCreate,
    LabelRead,
    LabelUpdate,
    ProcedureCreate,
    ProcedureRead,
    ProcedureUpdate,
    TaxonomyTreeNode,
)
from app.taxonomy.service import get_taxonomy_tree

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


@router.patch("/procedures/{procedure_id}", response_model=ProcedureRead)
def update_procedure(
    procedure_id: int, payload: ProcedureUpdate, session: Session = Depends(get_session)
) -> Procedure:
    procedure = session.get(Procedure, procedure_id)
    if procedure is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Procedure not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(procedure, field, value)
    session.commit()
    session.refresh(procedure)
    return procedure


@router.delete("/procedures/{procedure_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_procedure(procedure_id: int, session: Session = Depends(get_session)) -> None:
    procedure = session.get(Procedure, procedure_id)
    if procedure is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Procedure not found")
    session.delete(procedure)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Procedure still has categories, videos, or sequences referencing it",
        ) from None


@router.post("/categories", response_model=CategoryRead, status_code=status.HTTP_201_CREATED)
def create_category(payload: CategoryCreate, session: Session = Depends(get_session)) -> Category:
    category = Category(**payload.model_dump())
    session.add(category)
    session.commit()
    session.refresh(category)
    return category


@router.get("/categories", response_model=list[CategoryRead])
def list_categories(procedure_id: int | None = None, session: Session = Depends(get_session)) -> list[Category]:
    query = session.query(Category)
    if procedure_id is not None:
        query = query.filter(Category.procedure_id == procedure_id)
    return query.all()


@router.patch("/categories/{category_id}", response_model=CategoryRead)
def update_category(
    category_id: int, payload: CategoryUpdate, session: Session = Depends(get_session)
) -> Category:
    category = session.get(Category, category_id)
    if category is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(category, field, value)
    session.commit()
    session.refresh(category)
    return category


@router.delete("/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_category(category_id: int, session: Session = Depends(get_session)) -> None:
    category = session.get(Category, category_id)
    if category is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    session.delete(category)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Category still has labels referencing it"
        ) from None


@router.post("/evaluation-types", response_model=EvaluationTypeRead, status_code=status.HTTP_201_CREATED)
def create_evaluation_type(
    payload: EvaluationTypeCreate, session: Session = Depends(get_session)
) -> EvaluationType:
    evaluation_type = EvaluationType(**payload.model_dump())
    session.add(evaluation_type)
    session.commit()
    session.refresh(evaluation_type)
    return evaluation_type


@router.get("/evaluation-types", response_model=list[EvaluationTypeRead])
def list_evaluation_types(session: Session = Depends(get_session)) -> list[EvaluationType]:
    return session.query(EvaluationType).all()


@router.patch("/evaluation-types/{evaluation_type_id}", response_model=EvaluationTypeRead)
def update_evaluation_type(
    evaluation_type_id: int, payload: EvaluationTypeUpdate, session: Session = Depends(get_session)
) -> EvaluationType:
    evaluation_type = session.get(EvaluationType, evaluation_type_id)
    if evaluation_type is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evaluation type not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(evaluation_type, field, value)
    session.commit()
    session.refresh(evaluation_type)
    return evaluation_type


@router.delete("/evaluation-types/{evaluation_type_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_evaluation_type(evaluation_type_id: int, session: Session = Depends(get_session)) -> None:
    evaluation_type = session.get(EvaluationType, evaluation_type_id)
    if evaluation_type is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evaluation type not found")
    session.delete(evaluation_type)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Evaluation type still has labels referencing it"
        ) from None


@router.post("/labels", response_model=LabelRead, status_code=status.HTTP_201_CREATED)
def create_label(payload: LabelCreate, session: Session = Depends(get_session)) -> Label:
    label = Label(**payload.model_dump())
    session.add(label)
    session.flush()
    try:
        validate_parent_assignment(session, label, label.parent_label_id)
    except HierarchyError as error:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=error.message
        ) from None
    session.commit()
    session.refresh(label)
    return label


@router.get("/labels", response_model=list[LabelRead])
def list_labels(
    category_id: int | None = None,
    evaluation_type_id: int | None = None,
    session: Session = Depends(get_session),
) -> list[Label]:
    query = session.query(Label)
    if category_id is not None:
        query = query.filter(Label.category_id == category_id)
    if evaluation_type_id is not None:
        query = query.filter(Label.evaluation_type_id == evaluation_type_id)
    return query.all()


@router.patch("/labels/{label_id}", response_model=LabelRead)
def update_label(label_id: int, payload: LabelUpdate, session: Session = Depends(get_session)) -> Label:
    label = session.get(Label, label_id)
    if label is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Label not found")
    fields = payload.model_dump(exclude_unset=True)
    if "parent_label_id" in fields:
        try:
            validate_parent_assignment(session, label, fields["parent_label_id"])
        except HierarchyError as error:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=error.message
            ) from None
    for field, value in fields.items():
        setattr(label, field, value)
    session.commit()
    session.refresh(label)
    return label


@router.delete("/labels/{label_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_label(label_id: int, session: Session = Depends(get_session)) -> None:
    label = session.get(Label, label_id)
    if label is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Label not found")
    session.delete(label)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Label still has annotations referencing it"
        ) from None


@router.get("/labels/mask-counts", response_model=dict[int, int])
def label_mask_counts(session: Session = Depends(get_session)) -> dict[int, int]:
    rows = (
        session.query(Annotation.label_id, func.count(Annotation.id))
        .group_by(Annotation.label_id)
        .all()
    )
    return {label_id: count for label_id, count in rows}


@router.get("/tree", response_model=list[TaxonomyTreeNode])
def taxonomy_tree(procedure_id: int | None = None, session: Session = Depends(get_session)) -> list[dict]:
    return get_taxonomy_tree(session, procedure_id)
