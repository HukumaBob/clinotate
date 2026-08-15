"""add dataset tables

Revision ID: 90d664916285
Revises: f0450b13458e
Create Date: 2026-08-15 23:48:54.619883

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '90d664916285'
down_revision: Union[str, Sequence[str], None] = 'f0450b13458e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Don't call .create() explicitly here: create_table() below fires
    # PostgreSQL ENUM._on_table_create for each Enum column regardless of
    # create_type, so an explicit create() first causes a DuplicateObject
    # error on the second (implicit) creation attempt.
    task_type = sa.Enum('DETECTION', 'SEGMENTATION', 'CLASSIFICATION', name='tasktype')
    split_name = sa.Enum('TRAIN', 'VAL', 'TEST', name='splitname')

    op.create_table(
        'datasets',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('task_type', task_type, nullable=False),
        sa.Column('taxonomy_version', sa.Integer(), nullable=False),
        sa.Column('split_config', sa.JSON(), nullable=False),
        sa.Column('grouping_overrides', sa.JSON(), nullable=False),
        sa.Column('excluded_label_ids', sa.JSON(), nullable=False),
        sa.Column('balance_metrics', sa.JSON(), nullable=False),
        sa.Column('created_by_id', sa.Integer(), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        'dataset_items',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('dataset_id', sa.Integer(),
                  sa.ForeignKey('datasets.id', ondelete='CASCADE'), nullable=False),
        sa.Column('frame_id', sa.Integer(), sa.ForeignKey('frames.id'), nullable=False),
        sa.Column('annotation_ids', sa.JSON(), nullable=False),
        sa.Column('split', split_name, nullable=False),
    )
    op.create_index('ix_dataset_items_dataset_id', 'dataset_items', ['dataset_id'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_dataset_items_dataset_id', table_name='dataset_items')
    op.drop_table('dataset_items')
    op.drop_table('datasets')
    sa.Enum(name='splitname').drop(op.get_bind())
    sa.Enum(name='tasktype').drop(op.get_bind())
