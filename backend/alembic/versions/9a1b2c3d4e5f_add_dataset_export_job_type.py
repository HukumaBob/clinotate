"""add dataset_export job type

Revision ID: 9a1b2c3d4e5f
Revises: 46bf01aef90f
Create Date: 2026-08-18 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '9a1b2c3d4e5f'
down_revision: Union[str, Sequence[str], None] = '46bf01aef90f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Postgres enums store the member NAME, not its Python value -- the
    # jobtype column already contains uppercase names like SAM3_PREDICT,
    # VIDEO_TRANSCODE, RANK_QUALITY, so the new value must match that case.
    op.execute("ALTER TYPE jobtype ADD VALUE IF NOT EXISTS 'DATASET_EXPORT'")


def downgrade() -> None:
    """Downgrade schema."""
    # Postgres cannot drop a value from an enum type; leaving it is harmless
    # because no row will reference it after a downgrade.
    pass
