from pydantic import BaseModel, ConfigDict


class ProcedureCreate(BaseModel):
    name: str


class ProcedureUpdate(BaseModel):
    name: str | None = None


class ProcedureRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str


class CategoryCreate(BaseModel):
    name: str
    procedure_id: int


class CategoryUpdate(BaseModel):
    name: str | None = None


class CategoryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    procedure_id: int


class EvaluationTypeCreate(BaseModel):
    name: str


class EvaluationTypeUpdate(BaseModel):
    name: str | None = None


class EvaluationTypeRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str


class LabelCreate(BaseModel):
    name: str
    color: str = "#FFFFFF"
    category_id: int
    evaluation_type_id: int


class LabelUpdate(BaseModel):
    name: str | None = None
    color: str | None = None
    category_id: int | None = None
    evaluation_type_id: int | None = None


class LabelRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    color: str
    category_id: int
    evaluation_type_id: int
    taxonomy_version: int


class TaxonomyTreeEvaluationTypeNode(BaseModel):
    evaluation_type: EvaluationTypeRead
    labels: list[LabelRead]


class TaxonomyTreeNode(BaseModel):
    category: CategoryRead
    evaluation_types: list[TaxonomyTreeEvaluationTypeNode]
