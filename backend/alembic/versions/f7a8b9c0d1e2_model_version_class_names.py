"""add class names to model versions

Revision ID: f7a8b9c0d1e2
Revises: e6f7a8b9c0d1
Create Date: 2026-10-28 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "f7a8b9c0d1e2"
down_revision: Union[str, None] = "e6f7a8b9c0d1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "model_versions",
        sa.Column("class_names", sa.JSON(), nullable=False, server_default="[]"),
    )
    # The server default only backfilled existing rows; the application always
    # supplies a value.
    op.alter_column("model_versions", "class_names", server_default=None)


def downgrade() -> None:
    op.drop_column("model_versions", "class_names")
