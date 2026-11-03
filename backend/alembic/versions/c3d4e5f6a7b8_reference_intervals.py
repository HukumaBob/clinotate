"""add reference_intervals and video_references

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-11-03 13:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c3d4e5f6a7b8'
down_revision: Union[str, Sequence[str], None] = 'b2c3d4e5f6a7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'reference_intervals',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('video_id', sa.Integer(), nullable=False),
        sa.Column('category_id', sa.Integer(), nullable=False),
        sa.Column('label_id', sa.Integer(), nullable=False),
        sa.Column('taxonomy_version', sa.Integer(), nullable=False),
        sa.Column('start_ms', sa.Integer(), nullable=False),
        sa.Column('end_ms', sa.Integer(), nullable=False),
        sa.Column('created_by_id', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['video_id'], ['videos.id'], ondelete='RESTRICT'),
        sa.ForeignKeyConstraint(['category_id'], ['categories.id']),
        sa.ForeignKeyConstraint(['label_id'], ['labels.id']),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'ix_reference_intervals_video_category_start',
        'reference_intervals',
        ['video_id', 'category_id', 'start_ms'],
    )
    op.create_table(
        'video_references',
        sa.Column('video_id', sa.Integer(), nullable=False),
        sa.Column('compromised_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('compromised_by_training_run_id', sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(['video_id'], ['videos.id'], ondelete='RESTRICT'),
        sa.PrimaryKeyConstraint('video_id'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('video_references')
    op.drop_index('ix_reference_intervals_video_category_start', table_name='reference_intervals')
    op.drop_table('reference_intervals')
