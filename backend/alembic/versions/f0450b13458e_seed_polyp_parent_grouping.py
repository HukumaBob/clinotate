"""seed polyp parent grouping

Revision ID: f0450b13458e
Revises: 663b8b5c3cad
Create Date: 2026-08-15 23:41:55.409360

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f0450b13458e'
down_revision: Union[str, Sequence[str], None] = '663b8b5c3cad'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


SUBTYPES = (
    "'pedunculated_polyp_0_Ip'", "'sessile_polyp_0_Is'", "'flat_lesion_0_IIa'",
    "'lst_g_nodular_mixed'", "'lst_ng_flat_elevated'",
)
SUBTYPE_LIST = ", ".join(SUBTYPES)


def upgrade() -> None:
    connection = op.get_bind()

    # Create `polyp` in the same category and evaluation type as its children.
    # Sharing the category satisfies both hierarchy invariants at once: same
    # procedure (a category belongs to exactly one) and same annotation_scope
    # (which follows from the evaluation type).
    connection.execute(sa.text(f"""
        INSERT INTO labels (name, color, category_id, evaluation_type_id, taxonomy_version,
                            is_abstract, created_at)
        SELECT DISTINCT 'polyp', '#F97316', l.category_id, l.evaluation_type_id, 1, true, now()
        FROM labels l
        WHERE l.name IN ({SUBTYPE_LIST})
          AND NOT EXISTS (
              SELECT 1 FROM labels existing
              WHERE existing.name = 'polyp' AND existing.category_id = l.category_id
          )
    """))

    connection.execute(sa.text(f"""
        UPDATE labels child
        SET parent_label_id = (
            SELECT parent.id FROM labels parent
            WHERE parent.name = 'polyp' AND parent.category_id = child.category_id
            LIMIT 1
        )
        WHERE child.name IN ({SUBTYPE_LIST})
    """))


def downgrade() -> None:
    connection = op.get_bind()

    connection.execute(sa.text(f"""
        UPDATE labels SET parent_label_id = NULL WHERE name IN ({SUBTYPE_LIST})
    """))

    # Only delete the grouping row if nobody annotated with it. It is abstract,
    # so nobody should have been able to -- but fail loudly rather than delete
    # annotated data if that assumption ever broke.
    annotated = connection.execute(sa.text("""
        SELECT count(*) FROM annotations a JOIN labels l ON l.id = a.label_id
        WHERE l.name = 'polyp' AND l.is_abstract
    """)).scalar()
    if annotated:
        raise RuntimeError(
            f"Refusing to downgrade: {annotated} annotation(s) reference the 'polyp' "
            "grouping label. Reassign them first."
        )

    connection.execute(sa.text("DELETE FROM labels WHERE name = 'polyp' AND is_abstract"))
