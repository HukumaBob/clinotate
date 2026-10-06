"""add inference runs

Revision ID: d3e4f5a6b7c8
Revises: f6d4bc4f1b1e
Create Date: 2026-10-06 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'd3e4f5a6b7c8'
down_revision: Union[str, Sequence[str], None] = 'f6d4bc4f1b1e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Postgres enums store the member NAME, so the new jobtype value is upper case.
    op.execute("ALTER TYPE jobtype ADD VALUE IF NOT EXISTS 'INFERENCE_RUN'")
    op.execute("DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inferencerunstatus') THEN CREATE TYPE inferencerunstatus AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'); END IF; END$$")

    op.create_table(
        'inference_runs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('video_id', sa.Integer(), nullable=False),
        sa.Column('model_version_id', sa.Integer(), nullable=True),
        sa.Column('model_name', sa.String(length=200), nullable=False),
        sa.Column('job_id', sa.Integer(), nullable=True),
        sa.Column('frame_stride', sa.Integer(), nullable=False),
        sa.Column('status', postgresql.ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', name='inferencerunstatus', create_type=False), nullable=False),
        sa.Column('frames_total', sa.Integer(), nullable=False),
        sa.Column('frames_processed', sa.Integer(), nullable=False),
        sa.Column('predictions_key', sa.String(length=500), nullable=True),
        sa.Column('error', sa.String(length=2000), nullable=True),
        sa.Column('created_by_id', sa.Integer(), nullable=False),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['video_id'], ['videos.id'], ),
        sa.ForeignKeyConstraint(['model_version_id'], ['model_versions.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], ),
        sa.PrimaryKeyConstraint('id'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('inference_runs')
    sa.Enum(name='inferencerunstatus').drop(op.get_bind(), checkfirst=True)
    # Postgres cannot drop a value from an enum type; leaving INFERENCE_RUN is
    # harmless because no row will reference it after a downgrade.
