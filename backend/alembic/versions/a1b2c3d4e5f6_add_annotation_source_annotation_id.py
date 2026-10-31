"""add source_annotation_id to annotations

Revision ID: a1b2c3d4e5f6
Revises: f7a8b9c0d1e2
Create Date: 2026-10-31 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = 'f7a8b9c0d1e2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('annotations', sa.Column('source_annotation_id', sa.Integer(), nullable=True))
    op.create_index(op.f('ix_annotations_source_annotation_id'), 'annotations', ['source_annotation_id'], unique=False)
    op.create_foreign_key(
        'fk_annotations_source_annotation_id', 'annotations', 'annotations',
        ['source_annotation_id'], ['id'], ondelete='SET NULL',
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('fk_annotations_source_annotation_id', 'annotations', type_='foreignkey')
    op.drop_index(op.f('ix_annotations_source_annotation_id'), table_name='annotations')
    op.drop_column('annotations', 'source_annotation_id')
