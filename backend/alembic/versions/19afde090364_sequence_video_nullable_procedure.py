"""sequence video nullable procedure

Revision ID: 19afde090364
Revises: a9ad82e131f0
Create Date: 2026-07-24 10:26:58.117572

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '19afde090364'
down_revision: Union[str, Sequence[str], None] = 'a9ad82e131f0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("sequences", "video_id", existing_type=sa.Integer(), nullable=True)
    op.add_column("sequences", sa.Column("procedure_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_sequences_procedure_id_procedures",
        "sequences",
        "procedures",
        ["procedure_id"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint("fk_sequences_procedure_id_procedures", "sequences", type_="foreignkey")
    op.drop_column("sequences", "procedure_id")
    op.alter_column("sequences", "video_id", existing_type=sa.Integer(), nullable=False)
