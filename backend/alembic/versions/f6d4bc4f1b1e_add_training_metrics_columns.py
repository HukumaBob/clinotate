"""add training metrics columns

Revision ID: f6d4bc4f1b1e
Revises: b1c2d3e4f5a6
Create Date: 2026-08-21 09:42:11.804171

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f6d4bc4f1b1e'
down_revision: Union[str, Sequence[str], None] = 'b1c2d3e4f5a6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "training_runs",
        sa.Column("metrics_history", sa.JSON(), nullable=False, server_default="[]"),
    )
    op.add_column(
        "model_versions",
        sa.Column("per_class_metrics", sa.JSON(), nullable=False, server_default="[]"),
    )
    op.add_column("model_versions", sa.Column("confusion_matrix", sa.JSON(), nullable=True))
    op.add_column(
        "model_versions",
        sa.Column("artifact_keys", sa.JSON(), nullable=False, server_default="[]"),
    )
    # The server default existed only to backfill existing rows; the
    # application always supplies a value.
    op.alter_column("training_runs", "metrics_history", server_default=None)
    op.alter_column("model_versions", "per_class_metrics", server_default=None)
    op.alter_column("model_versions", "artifact_keys", server_default=None)


def downgrade() -> None:
    op.drop_column("model_versions", "artifact_keys")
    op.drop_column("model_versions", "confusion_matrix")
    op.drop_column("model_versions", "per_class_metrics")
    op.drop_column("training_runs", "metrics_history")
