"""add training tables

Revision ID: b1c2d3e4f5a6
Revises: 9a1b2c3d4e5f
Create Date: 2026-08-19 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'b1c2d3e4f5a6'
down_revision: Union[str, Sequence[str], None] = '9a1b2c3d4e5f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Postgres enums store the member NAME, not its Python value -- the
    # jobtype column already contains uppercase names like DATASET_EXPORT,
    # so the new value must match that case.
    op.execute("ALTER TYPE jobtype ADD VALUE IF NOT EXISTS 'MODEL_TRAIN'")

    # Create the trainingrunstatus enum type if it doesn't exist
    op.execute("DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'trainingrunstatus') THEN CREATE TYPE trainingrunstatus AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'STOPPED'); END IF; END$$")

    op.create_table(
        'training_runs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('dataset_id', sa.Integer(), nullable=False),
        sa.Column('job_id', sa.Integer(), nullable=True),
        sa.Column('adapter', sa.String(length=100), nullable=False),
        sa.Column('base_model', sa.String(length=200), nullable=False),
        sa.Column('task_type', postgresql.ENUM('DETECTION', 'SEGMENTATION', 'CLASSIFICATION', name='tasktype', create_type=False), nullable=False),
        sa.Column('config', sa.JSON(), nullable=False),
        sa.Column('status', postgresql.ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'STOPPED', name='trainingrunstatus', create_type=False), nullable=False),
        sa.Column('stop_requested', sa.Boolean(), nullable=False),
        sa.Column('log_text', sa.Text(), nullable=False),
        sa.Column('metrics', sa.JSON(), nullable=False),
        sa.Column('current_epoch', sa.Integer(), nullable=False),
        sa.Column('total_epochs', sa.Integer(), nullable=False),
        sa.Column('error', sa.String(length=2000), nullable=True),
        sa.Column('created_by_id', sa.Integer(), nullable=False),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['dataset_id'], ['datasets.id'], ),
        sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], ),
        sa.PrimaryKeyConstraint('id'),
    )

    op.create_table(
        'model_versions',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('training_run_id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('task_type', postgresql.ENUM('DETECTION', 'SEGMENTATION', 'CLASSIFICATION', name='tasktype', create_type=False), nullable=False),
        sa.Column('storage_key', sa.String(length=500), nullable=False),
        sa.Column('metrics', sa.JSON(), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['training_run_id'], ['training_runs.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('model_versions')
    op.drop_table('training_runs')
    sa.Enum(name='trainingrunstatus').drop(op.get_bind(), checkfirst=True)
    # Postgres cannot drop a value from an enum type; leaving MODEL_TRAIN is
    # harmless because no row will reference it after a downgrade.
