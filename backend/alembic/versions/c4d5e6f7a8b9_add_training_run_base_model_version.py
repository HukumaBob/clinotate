"""add training run base model version

Revision ID: c4d5e6f7a8b9
Revises: a7b8c9d0e1f2
Create Date: 2026-10-08 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c4d5e6f7a8b9"
down_revision: Union[str, Sequence[str], None] = "a7b8c9d0e1f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "training_runs",
        sa.Column("base_model_version_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_training_runs_base_model_version_id",
        "training_runs",
        "model_versions",
        ["base_model_version_id"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_training_runs_base_model_version_id", "training_runs", type_="foreignkey"
    )
    op.drop_column("training_runs", "base_model_version_id")
