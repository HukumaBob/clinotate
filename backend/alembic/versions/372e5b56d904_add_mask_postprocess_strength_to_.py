"""add mask_postprocess_strength to platform_settings

Revision ID: 372e5b56d904
Revises: d579d22f6d08
Create Date: 2026-08-11 20:37:15.152257

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '372e5b56d904'
down_revision: Union[str, Sequence[str], None] = 'd579d22f6d08'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "platform_settings",
        sa.Column("mask_postprocess_strength", sa.Float(), nullable=False, server_default="0.3"),
    )
    op.alter_column("platform_settings", "mask_postprocess_strength", server_default=None)


def downgrade() -> None:
    op.drop_column("platform_settings", "mask_postprocess_strength")
