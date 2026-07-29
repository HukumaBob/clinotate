# Brief: re-import taxonomy data into the dev DB

## Why you're reading this

The dev Postgres database (`endoscopy` in the `endoscopy-platform-postgres-1`
container) periodically gets wiped — usually by a `TRUNCATE` run before a
backend test suite pass (see CLAUDE.md's note on backend tests hitting the
real dev DB via `TestClient`, not an isolated fixture). Every time that
happens, `categories`, `evaluation_types`, and `labels` go empty and any
manual browser verification of taxonomy-dependent UI (CascadingLabelPicker,
MasksList, mask coloring, SAM predict/track) breaks until it's re-imported.

## How to re-import

The real taxonomy data lives at:
`backend/app/taxonomy/data/imported_taxonomy.json`

Run this from the `backend/` directory (needs the `uv` venv, needs
`docker compose`'s `postgres` container up and reachable per `.env`):

```bash
cd backend && uv run python -c "
import json
from app.db import SessionLocal
from app.taxonomy.import_taxonomy import import_taxonomy

with open('app/taxonomy/data/imported_taxonomy.json') as f:
    data = json.load(f)

session = SessionLocal()
import_taxonomy(session, data)
session.close()
print('done')
"
```

This creates `Procedure` rows (notably `egds` and `colono`, the two with
real substantial taxonomy — 5 and 4 categories respectively last time this
was checked) plus their `Category`/`EvaluationType`/`Label` trees.

## Verifying it worked

```bash
docker exec endoscopy-platform-postgres-1 psql -U endoscopy -d endoscopy -c \
  "select p.id, p.name, count(c.id) as categories from procedures p join categories c on c.procedure_id=p.id group by p.id, p.name order by categories desc limit 10;"
```

You want to see `egds`/`colono` (or whatever procedure names are current)
with several categories each.

## If you also need a sequence to test against

`import_taxonomy` only populates the taxonomy tables — it does not create
any `Video`/`Sequence`/`Frame` rows. A sequence's `procedure_id` must be
set to one of the procedures the import just created before the frame
editor's taxonomy tree (`GET /taxonomy/tree?procedure_id=...`) will return
anything for it. If you already have a sequence pointing at a
now-deleted procedure, update it directly:

```bash
docker exec endoscopy-platform-postgres-1 psql -U endoscopy -d endoscopy -c \
  "update sequences set procedure_id=<new_procedure_id> where id=<sequence_id>;"
```

Get `<new_procedure_id>` from the verification query above (pick `egds` or
`colono`, whichever matches the sequence's actual content).

## Don't repeat this mistake

Before running `TRUNCATE` on `categories`/`evaluation_types`/`labels`/
`procedures` (or any table CLAUDE.md's truncate snippet includes) for a
clean test run, know that it also destroys whatever taxonomy you imported
for manual verification — re-running the import above is a 5-second fix,
not a reason to avoid truncating, but don't be surprised when the browser
suddenly shows an empty category dropdown right after a test run and
assume something is broken in the code before checking this first.
