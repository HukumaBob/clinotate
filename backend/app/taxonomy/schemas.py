from pydantic import BaseModel, ConfigDict

from app.taxonomy.models import LabelType


class ProcedureCreate(BaseModel):
    name: str


class ProcedureRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str


class LabelCreate(BaseModel):
    name: str
    label_type: LabelType
    color: str = "#FFFFFF"
    procedure_id: int | None = None


class LabelRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    label_type: LabelType
    color: str
    procedure_id: int | None
    taxonomy_version: int


class LabelRelationCreate(BaseModel):
    parent_id: int
    child_id: int
    confidence: float = 1.0


class LabelTreeNode(BaseModel):
    category: LabelRead
    children: list[LabelRead]
