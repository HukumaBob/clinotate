"""add class limits to datasets

Revision ID: 4720dcd56ff9
Revises: 90d664916285
Create Date: 2026-08-16 19:17:56.476301

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '4720dcd56ff9'
down_revision: Union[str, Sequence[str], None] = '90d664916285'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'datasets',
        sa.Column('class_limits', sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('datasets', 'class_limits')
