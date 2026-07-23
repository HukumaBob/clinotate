"""add sam2 job types

Revision ID: a9ad82e131f0
Revises: 8fbd481f1620
Create Date: 2026-07-23 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'a9ad82e131f0'
down_revision: Union[str, Sequence[str], None] = '8fbd481f1620'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Postgres enums require new values to be added explicitly; existing
    # rows and the SAM3_PREDICT/SAM3_TRACK values are untouched.
    op.execute("ALTER TYPE jobtype ADD VALUE IF NOT EXISTS 'SAM2_PREDICT'")
    op.execute("ALTER TYPE jobtype ADD VALUE IF NOT EXISTS 'SAM2_TRACK'")


def downgrade() -> None:
    """Downgrade schema."""
    # Postgres does not support removing enum values directly. Downgrading
    # would require recreating the type and the jobs table's column, which
    # is out of scope here since no rows are expected to use these values
    # at downgrade time in practice.
    raise NotImplementedError("Cannot remove enum values from jobtype in Postgres")
