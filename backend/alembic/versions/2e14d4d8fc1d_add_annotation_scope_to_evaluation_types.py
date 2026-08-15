"""add annotation_scope to evaluation_types

Revision ID: 2e14d4d8fc1d
Revises: 9c4fcdd732fc
Create Date: 2026-08-15 15:31:49.361748

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '2e14d4d8fc1d'
down_revision: Union[str, Sequence[str], None] = '9c4fcdd732fc'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    annotation_scope_enum = sa.Enum('FRAME', 'REGION', name='annotationscope')
    annotation_scope_enum.create(op.get_bind())
    op.add_column(
        'evaluation_types',
        sa.Column('annotation_scope', annotation_scope_enum, nullable=True),
    )
    op.execute(
        "UPDATE evaluation_types SET annotation_scope = 'REGION' "
        "WHERE name IN ('geometric', 'morphological')"
    )
    op.execute(
        "UPDATE evaluation_types SET annotation_scope = 'FRAME' "
        "WHERE name = 'frame_classification'"
    )
    op.alter_column('evaluation_types', 'annotation_scope', nullable=False)


def downgrade() -> None:
    op.drop_column('evaluation_types', 'annotation_scope')
    sa.Enum(name='annotationscope').drop(op.get_bind())
