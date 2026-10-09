"""add training run per-class metrics and confusion matrix

Revision ID: e6f7a8b9c0d1
Revises: d5e6f7a8b9c0
Create Date: 2026-10-09 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e6f7a8b9c0d1"
down_revision: Union[str, Sequence[str], None] = "d5e6f7a8b9c0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "training_runs",
        sa.Column("per_class_metrics", sa.JSON(), nullable=False, server_default="[]"),
    )
    op.add_column("training_runs", sa.Column("confusion_matrix", sa.JSON(), nullable=True))
    # The server default only backfilled existing rows; the application always
    # supplies a value.
    op.alter_column("training_runs", "per_class_metrics", server_default=None)
    # Runs that already produced a model: copy its per-class numbers and matrix.
    op.execute(
        """
        UPDATE training_runs
        SET per_class_metrics = v.per_class_metrics,
            confusion_matrix = v.confusion_matrix
        FROM model_versions v
        WHERE v.training_run_id = training_runs.id
        """
    )


def downgrade() -> None:
    op.drop_column("training_runs", "confusion_matrix")
    op.drop_column("training_runs", "per_class_metrics")
