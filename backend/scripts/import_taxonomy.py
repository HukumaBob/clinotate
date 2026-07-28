import json
from pathlib import Path

from app.db import SessionLocal
from app.taxonomy.import_taxonomy import import_taxonomy

data_path = Path(__file__).resolve().parents[1] / "app" / "taxonomy" / "data" / "imported_taxonomy.json"
data = json.loads(data_path.read_text())

session = SessionLocal()
try:
    import_taxonomy(session, data)
finally:
    session.close()

print(f"Imported {len(data['labels'])} labels and {len(data['relations'])} relations "
      f"across {len(data['procedures'])} procedures from {data_path}")
