"""add video_transcode job type

Revision ID: 8a348a934eb0
Revises: 854bf69618a4
Create Date: 2026-07-30 15:52:07.715516

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8a348a934eb0'
down_revision: Union[str, Sequence[str], None] = '854bf69618a4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Postgres enums require new values to be added explicitly; existing
    # rows and other jobtype values are untouched.
    op.execute("ALTER TYPE jobtype ADD VALUE IF NOT EXISTS 'VIDEO_TRANSCODE'")


def downgrade() -> None:
    """Downgrade schema."""
    # Postgres does not support removing enum values directly. Downgrading
    # would require recreating the type and the jobs table's column, which
    # is out of scope here since no rows are expected to use this value
    # at downgrade time in practice.
    raise NotImplementedError("Cannot remove enum values from jobtype in Postgres")
