import app.main  # noqa: F401 -- registers every model on Base.metadata
from fastapi.testclient import TestClient

import app.db as db_module
from app.annotation.models import Annotation
from app.datasets.models import DatasetItem, SplitName
from app.main import app
from split_island import build_island

client = TestClient(app)

# X is in all four videos, Y only in the second-smallest two (see
# test_dataset_split_plan.py): dealing by frame count alone leaves Y out of val.
VIDEOS = [{"X": 10}, {"X": 3, "Y": 2}, {"X": 6}, {"X": 2, "Y": 2}]
SPLIT = {"train": 70, "val": 20}


def _headers(email):
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "admin"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _committed_island(tag, videos=VIDEOS):
    session = db_module.SessionLocal()
    try:
        sequence_ids, label_ids, _ = build_island(session, tag, videos)
        session.commit()
        return sequence_ids, label_ids
    finally:
        session.close()


def _balance(headers, sequence_ids, **extra):
    body = {"sequence_ids": sequence_ids, "task_type": "classification",
            "grouping_overrides": {}, "excluded_label_ids": [], "threshold": 10, **extra}
    return client.post("/datasets/balance", json=body, headers=headers)


def _create(headers, sequence_ids, name):
    return client.post(
        "/datasets",
        json={"name": name, "task_type": "classification", "sequence_ids": sequence_ids,
              "split_config": SPLIT, "grouping_overrides": {}, "excluded_label_ids": [],
              "threshold": 10},
        headers=headers,
    )


def _cells(report):
    return {c["label_id"]: {p: c[p] for p in ("train", "val", "test")} for c in report["classes"]}


def test_balance_returns_split_report_when_split_config_given():
    headers = _headers("splapi1@example.com")
    sequence_ids, label_ids = _committed_island("splapi1")

    response = _balance(headers, sequence_ids, split_config=SPLIT)

    assert response.status_code == 200
    report = response.json()["split_report"]
    by_id = _cells(report)
    assert by_id[label_ids["X"]]["train"]["units"] >= 1
    assert {"train", "val"} <= {p for p in ("train", "val", "test") if by_id[label_ids["Y"]][p]["frames"] > 0}
    assert set(report) >= {"classes", "train", "val", "test", "warnings"}
    assert report["train"]["target"] == 0.7


def test_balance_split_report_is_none_without_split_config():
    headers = _headers("splapi2@example.com")
    sequence_ids, _ = _committed_island("splapi2")

    response = _balance(headers, sequence_ids)

    assert response.status_code == 200
    assert response.json()["split_report"] is None


def test_split_report_endpoint_matches_the_preview():
    headers = _headers("splapi3@example.com")
    sequence_ids, _ = _committed_island("splapi3")
    preview = _balance(headers, sequence_ids, split_config=SPLIT).json()["split_report"]
    created = _create(headers, sequence_ids, "splapi3-ds")
    assert created.status_code == 201

    stored = client.get(f"/datasets/{created.json()['id']}/split-report", headers=headers)

    assert stored.status_code == 200
    assert _cells(stored.json()) == _cells(preview)
    assert stored.json()["warnings"] == preview["warnings"]


def test_split_report_for_unknown_dataset_is_404():
    headers = _headers("splapi4@example.com")

    response = client.get("/datasets/999999999/split-report", headers=headers)

    assert response.status_code == 404
    assert response.json()["detail"] == "Dataset not found"


def test_split_report_survives_deleted_annotations():
    headers = _headers("splapi5@example.com")
    sequence_ids, label_ids = _committed_island("splapi5")
    dataset_id = _create(headers, sequence_ids, "splapi5-ds").json()["id"]
    before = _cells(client.get(f"/datasets/{dataset_id}/split-report", headers=headers).json())
    session = db_module.SessionLocal()
    try:
        item = session.query(DatasetItem).filter(DatasetItem.dataset_id == dataset_id).first()
        session.query(Annotation).filter(Annotation.id == item.annotation_ids[0]).delete()
        session.commit()
    finally:
        session.close()

    response = client.get(f"/datasets/{dataset_id}/split-report", headers=headers)

    assert response.status_code == 200
    after = _cells(response.json())
    total = lambda cells: sum(p["frames"] for c in cells.values() for p in c.values())  # noqa: E731
    assert total(after) == total(before) - 1


def test_split_report_for_a_dataset_whose_items_have_arbitrary_splits():
    headers = _headers("splapi6@example.com")
    sequence_ids, label_ids = _committed_island("splapi6")
    dataset_id = _create(headers, sequence_ids, "splapi6-ds").json()["id"]
    session = db_module.SessionLocal()
    try:
        session.query(DatasetItem).filter(DatasetItem.dataset_id == dataset_id).update(
            {DatasetItem.split: SplitName.TRAIN}
        )
        session.commit()
    finally:
        session.close()

    response = client.get(f"/datasets/{dataset_id}/split-report", headers=headers)

    assert response.status_code == 200
    report = response.json()
    assert report["val"]["frames"] == 0 and report["test"]["frames"] == 0
    kinds = {w["kind"] for w in report["warnings"]}
    assert "missing_in_split" in kinds and "split_share" in kinds
