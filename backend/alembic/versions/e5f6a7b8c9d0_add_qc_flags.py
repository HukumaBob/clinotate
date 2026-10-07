"""add qc flags

Revision ID: e5f6a7b8c9d0
Revises: d3e4f5a6b7c8
Create Date: 2026-10-07 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'e5f6a7b8c9d0'
down_revision: Union[str, Sequence[str], None] = 'd3e4f5a6b7c8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Postgres enums store the member NAME, so the values are upper case.
    op.execute("DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'qcflagkind') THEN CREATE TYPE qcflagkind AS ENUM ('FP', 'FN'); END IF; END$$")

    op.create_table(
        'qc_flags',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('run_id', sa.Integer(), nullable=False),
        sa.Column('kind', postgresql.ENUM('FP', 'FN', name='qcflagkind', create_type=False), nullable=False),
        sa.Column('frame_index', sa.Integer(), nullable=False),
        sa.Column('timestamp_ms', sa.Integer(), nullable=False),
        sa.Column('note', sa.String(length=500), nullable=True),
        sa.Column('created_by_id', sa.Integer(), nullable=False),
        sa.Column('committed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('frame_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['run_id'], ['inference_runs.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], ),
        sa.ForeignKeyConstraint(['frame_id'], ['frames.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('run_id', 'frame_index', name='uq_qc_flags_run_frame'),
    )

    op.add_column('sequences', sa.Column('origin_qc_run_id', sa.Integer(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('sequences', 'origin_qc_run_id')
    op.drop_table('qc_flags')
    sa.Enum(name='qcflagkind').drop(op.get_bind(), checkfirst=True)
