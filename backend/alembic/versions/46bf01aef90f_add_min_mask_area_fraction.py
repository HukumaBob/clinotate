"""add min mask area fraction

Revision ID: 46bf01aef90f
Revises: 4720dcd56ff9
Create Date: 2026-08-18 20:17:01.522271

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '46bf01aef90f'
down_revision: Union[str, Sequence[str], None] = '4720dcd56ff9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'platform_settings',
        sa.Column('min_mask_area_fraction', sa.Float(), nullable=False,
                  server_default=sa.text('0.0005')),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('platform_settings', 'min_mask_area_fraction')
