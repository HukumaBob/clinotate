"""taxonomy category evaluation type

Revision ID: fa9801ab5dbe
Revises: 839259601819
Create Date: 2026-07-28 14:29:18.522900

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'fa9801ab5dbe'
down_revision: Union[str, Sequence[str], None] = '839259601819'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "evaluation_types",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_table(
        "categories",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("procedure_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["procedure_id"], ["procedures.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name", "procedure_id"),
    )
    # labels/label_relations are wiped before this migration runs (see Task 2's
    # accompanying manual step) -- safe to add NOT NULL FK columns directly,
    # no backfill needed.
    op.execute("TRUNCATE labels, label_relations, annotations CASCADE")
    op.drop_table("label_relations")
    op.drop_column("labels", "procedure_id")
    op.add_column("labels", sa.Column("category_id", sa.Integer(), nullable=False))
    op.add_column("labels", sa.Column("evaluation_type_id", sa.Integer(), nullable=False))
    op.create_foreign_key(None, "labels", "categories", ["category_id"], ["id"])
    op.create_foreign_key(None, "labels", "evaluation_types", ["evaluation_type_id"], ["id"])
    op.drop_column("labels", "label_type")
    op.execute("DROP TYPE labeltype")


def downgrade() -> None:
    op.execute("CREATE TYPE labeltype AS ENUM ('GEOMETRIC', 'MORPHOLOGICAL', 'QUALITY')")
    op.add_column(
        "labels",
        sa.Column(
            "label_type",
            sa.Enum("GEOMETRIC", "MORPHOLOGICAL", "QUALITY", name="labeltype"),
            nullable=True,
        ),
    )
    op.drop_column("labels", "evaluation_type_id")
    op.drop_column("labels", "category_id")
    op.add_column("labels", sa.Column("procedure_id", sa.Integer(), nullable=True))
    op.create_foreign_key(None, "labels", "procedures", ["procedure_id"], ["id"])
    op.create_table(
        "label_relations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("parent_id", sa.Integer(), nullable=False),
        sa.Column("child_id", sa.Integer(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.ForeignKeyConstraint(["child_id"], ["labels.id"]),
        sa.ForeignKeyConstraint(["parent_id"], ["labels.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.drop_table("categories")
    op.drop_table("evaluation_types")
