"""annotation job id

Revision ID: 839259601819
Revises: 19afde090364
Create Date: 2026-07-24 16:14:07.263171

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '839259601819'
down_revision: Union[str, Sequence[str], None] = '19afde090364'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("annotations", sa.Column("job_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_annotations_job_id_jobs",
        "annotations",
        "jobs",
        ["job_id"],
        ["id"],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint("fk_annotations_job_id_jobs", "annotations", type_="foreignkey")
    op.drop_column("annotations", "job_id")
