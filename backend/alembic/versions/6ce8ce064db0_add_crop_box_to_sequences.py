"""add crop box to sequences

Revision ID: 6ce8ce064db0
Revises: 8a348a934eb0
Create Date: 2026-07-30 18:06:05.513668

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '6ce8ce064db0'
down_revision: Union[str, Sequence[str], None] = '8a348a934eb0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('sequences', sa.Column('crop_box', sa.JSON(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('sequences', 'crop_box')
