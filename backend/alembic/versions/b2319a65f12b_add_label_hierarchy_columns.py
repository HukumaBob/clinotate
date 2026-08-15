"""add label hierarchy columns

Revision ID: b2319a65f12b
Revises: 2e14d4d8fc1d
Create Date: 2026-08-15 20:00:18.655111

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b2319a65f12b'
down_revision: Union[str, Sequence[str], None] = '2e14d4d8fc1d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('labels', sa.Column('parent_label_id', sa.Integer(), nullable=True))
    op.create_foreign_key(
        'fk_labels_parent_label_id', 'labels', 'labels', ['parent_label_id'], ['id']
    )
    op.add_column(
        'labels',
        sa.Column('is_abstract', sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column('labels', 'is_abstract')
    op.drop_constraint('fk_labels_parent_label_id', 'labels', type_='foreignkey')
    op.drop_column('labels', 'parent_label_id')
