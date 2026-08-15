"""move whole frame quality labels to frame classification

Revision ID: 663b8b5c3cad
Revises: b2319a65f12b
Create Date: 2026-08-15 21:20:53.561205

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '663b8b5c3cad'
down_revision: Union[str, Sequence[str], None] = 'b2319a65f12b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


WHOLE_FRAME_QUALITY = "('bad_picture', 'close_focus', 'dirty_optic')"


def upgrade() -> None:
    connection = op.get_bind()

    # 1. Ensure a Quality category exists for every procedure that owns one of
    #    the labels being moved. In the dev database both already exist (the
    #    category holds a mix of geometric and frame-classification labels), so
    #    this inserts nothing there -- it is here so the migration is correct in
    #    an environment whose taxonomy was imported differently.
    #    Quality stays procedure-specific by design: defocus is defocus, but the
    #    image differs between organs and such frames are plentiful, so keeping
    #    colono and egds apart preserves real training signal.
    connection.execute(sa.text(f"""
        INSERT INTO categories (name, procedure_id)
        SELECT DISTINCT 'Quality', c.procedure_id
        FROM labels l
        JOIN categories c ON c.id = l.category_id
        WHERE l.name IN {WHOLE_FRAME_QUALITY}
          AND NOT EXISTS (
              SELECT 1 FROM categories existing
              WHERE existing.name = 'Quality' AND existing.procedure_id = c.procedure_id
          )
    """))

    # 2. Give every such procedure its own low_quality parent. Colono's already
    #    exists (id 2373 in dev, holding all 32 CLASSIFICATION annotations) and
    #    is left untouched; egds gets a fresh one. This is the only row this
    #    migration creates.
    connection.execute(sa.text(f"""
        INSERT INTO labels (name, color, category_id, evaluation_type_id, taxonomy_version,
                            is_abstract, created_at)
        SELECT DISTINCT 'low_quality', '#FFFFFF', quality_cat.id, et.id, 1, false, now()
        FROM labels l
        JOIN categories own_cat ON own_cat.id = l.category_id
        JOIN categories quality_cat
          ON quality_cat.name = 'Quality' AND quality_cat.procedure_id = own_cat.procedure_id
        CROSS JOIN evaluation_types et
        WHERE l.name IN {WHOLE_FRAME_QUALITY}
          AND et.name = 'frame_classification'
          AND NOT EXISTS (
              SELECT 1 FROM labels existing
              JOIN categories existing_cat ON existing_cat.id = existing.category_id
              WHERE existing.name = 'low_quality'
                AND existing_cat.procedure_id = own_cat.procedure_id
          )
    """))

    # 3. Move the labels to frame_classification. Their category_id already
    #    points at their own procedure's Quality category, so only the
    #    evaluation type changes -- but set the category explicitly anyway, so
    #    the migration is correct where step 1 did create a category. Ids are
    #    preserved, and with them every annotation that references them.
    connection.execute(sa.text(f"""
        UPDATE labels l
        SET evaluation_type_id = (
                SELECT id FROM evaluation_types WHERE name = 'frame_classification'
            ),
            category_id = (
                SELECT quality_cat.id
                FROM categories quality_cat
                JOIN categories own ON own.id = l.category_id
                WHERE quality_cat.name = 'Quality'
                  AND quality_cat.procedure_id = own.procedure_id
                LIMIT 1
            )
        WHERE l.name IN {WHOLE_FRAME_QUALITY}
    """))

    # 4. Hang each moved label under the low_quality of its own procedure.
    connection.execute(sa.text(f"""
        UPDATE labels l
        SET parent_label_id = (
            SELECT parent.id
            FROM labels parent
            JOIN categories parent_cat ON parent_cat.id = parent.category_id
            JOIN categories own_cat ON own_cat.id = l.category_id
            WHERE parent.name = 'low_quality'
              AND parent_cat.procedure_id = own_cat.procedure_id
            LIMIT 1
        )
        WHERE l.name IN {WHOLE_FRAME_QUALITY}
    """))


def downgrade() -> None:
    connection = op.get_bind()

    connection.execute(sa.text(f"""
        UPDATE labels
        SET parent_label_id = NULL
        WHERE name IN {WHOLE_FRAME_QUALITY}
    """))

    # Return them to geometric. Their category does not change, for the same
    # reason it did not change on the way up.
    connection.execute(sa.text(f"""
        UPDATE labels
        SET evaluation_type_id = (SELECT id FROM evaluation_types WHERE name = 'geometric')
        WHERE name IN {WHOLE_FRAME_QUALITY}
    """))

    # Identify the low_quality rows this migration created: a procedure's
    # low_quality that has no annotations AND is not the oldest such row.
    # Ordering by created_at rather than id, since id ordering is an accident
    # of insert order rather than a fact about which row predates the migration.
    orphan_ids = [
        row[0]
        for row in connection.execute(sa.text("""
            SELECT l.id
            FROM labels l
            WHERE l.name = 'low_quality'
              AND l.created_at > (
                  SELECT min(created_at) FROM labels WHERE name = 'low_quality'
              )
        """))
    ]

    if not orphan_ids:
        return

    # Refuse to delete anything an annotator has since used. Silently deleting
    # annotated data on a downgrade is not acceptable; failing loudly is.
    annotated = connection.execute(
        sa.text("SELECT count(*) FROM annotations WHERE label_id = ANY(:ids)"),
        {"ids": orphan_ids},
    ).scalar()
    if annotated:
        raise RuntimeError(
            f"Refusing to downgrade: {annotated} annotation(s) reference a low_quality "
            "label this migration created. Reassign or delete them first."
        )

    connection.execute(
        sa.text("DELETE FROM labels WHERE id = ANY(:ids)"), {"ids": orphan_ids}
    )
