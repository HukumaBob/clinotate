"""add training run name and note

Revision ID: d5e6f7a8b9c0
Revises: c4d5e6f7a8b9
Create Date: 2026-10-08 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d5e6f7a8b9c0"
down_revision: Union[str, Sequence[str], None] = "c4d5e6f7a8b9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("training_runs", sa.Column("name", sa.String(length=200), nullable=True))
    op.add_column("training_runs", sa.Column("note", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("training_runs", "note")
    op.drop_column("training_runs", "name")
