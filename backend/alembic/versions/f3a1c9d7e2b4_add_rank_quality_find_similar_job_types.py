"""add rank_quality and find_similar job types

Revision ID: f3a1c9d7e2b4
Revises: 372e5b56d904
Create Date: 2026-08-12 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'f3a1c9d7e2b4'
down_revision: Union[str, Sequence[str], None] = '372e5b56d904'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Postgres enums require new values to be added explicitly; existing
    # rows and values are untouched. JobType.RANK_QUALITY/FIND_SIMILAR were
    # added to the Python enum in commit 6553baa without a migration --
    # this backfills the Postgres side of that gap.
    op.execute("ALTER TYPE jobtype ADD VALUE IF NOT EXISTS 'RANK_QUALITY'")
    op.execute("ALTER TYPE jobtype ADD VALUE IF NOT EXISTS 'FIND_SIMILAR'")


def downgrade() -> None:
    """Downgrade schema."""
    # Postgres does not support removing enum values directly. Downgrading
    # would require recreating the type and the jobs table's column, which
    # is out of scope here since no rows are expected to use these values
    # at downgrade time in practice.
    raise NotImplementedError("Cannot remove enum values from jobtype in Postgres")
