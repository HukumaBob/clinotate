import app.main  # noqa: F401
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _register_and_login(email: str) -> dict[str, str]:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "admin"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_balance_endpoint_writes_nothing_and_returns_a_report():
    headers = _register_and_login("ds-api1@example.com")
    before = client.get("/datasets", headers=headers).json()

    response = client.post(
        "/datasets/balance",
        json={"sequence_ids": [], "task_type": "detection",
              "grouping_overrides": {}, "excluded_label_ids": [], "threshold": 10},
        headers=headers,
    )

    assert response.status_code == 200
    body = response.json()
    assert body["classes"] == []
    assert body["total_frames"] == 0
    assert body["metrics"]["severity"] == "no_data"
    assert client.get("/datasets", headers=headers).json() == before


def test_create_dataset_materializes_items_and_pins_taxonomy_version():
    headers = _register_and_login("ds-api2@example.com")
    sequences = client.get("/media/sequences", params={"page": 1, "page_size": 50}, headers=headers).json()
    sequence_ids = [s["id"] for s in sequences["items"]]

    response = client.post(
        "/datasets",
        json={
            "name": "ds-api2-dataset", "task_type": "detection",
            "sequence_ids": sequence_ids, "split_config": {"train": 70, "val": 20},
            "grouping_overrides": {}, "excluded_label_ids": [], "threshold": 10,
        },
        headers=headers,
    )

    assert response.status_code == 201
    body = response.json()
    assert body["taxonomy_version"] >= 1
    assert body["item_count"] == body["split_counts"]["train"] + body["split_counts"]["val"] + body["split_counts"]["test"]
    assert body["balance_metrics"]["severity"] in {
        "no_data", "balanced", "mild_imbalance", "moderate_imbalance",
        "severe_imbalance", "extreme_imbalance",
    }

    client.delete(f"/datasets/{body['id']}", headers=headers)


def test_every_frame_of_a_sequence_lands_in_the_same_split():
    # Frame-level splitting would leak: consecutive video frames are near-duplicates.
    headers = _register_and_login("ds-api3@example.com")
    sequences = client.get("/media/sequences", params={"page": 1, "page_size": 50}, headers=headers).json()
    sequence_ids = [s["id"] for s in sequences["items"]]

    created = client.post(
        "/datasets",
        json={
            "name": "ds-api3-dataset", "task_type": "detection",
            "sequence_ids": sequence_ids, "split_config": {"train": 70, "val": 20},
            "grouping_overrides": {}, "excluded_label_ids": [], "threshold": 10,
        },
        headers=headers,
    ).json()

    detail = client.get(f"/datasets/{created['id']}", headers=headers).json()
    splits_per_sequence: dict[int, set[str]] = {}
    for item in detail["items"]:
        splits_per_sequence.setdefault(item["sequence_id"], set()).add(item["split"])
    for sequence_id, splits in splits_per_sequence.items():
        assert len(splits) == 1, f"sequence {sequence_id} was split across {splits}"

    client.delete(f"/datasets/{created['id']}", headers=headers)


def test_delete_removes_the_dataset_and_its_items():
    headers = _register_and_login("ds-api4@example.com")
    created = client.post(
        "/datasets",
        json={
            "name": "ds-api4-dataset", "task_type": "detection", "sequence_ids": [],
            "split_config": {"train": 70, "val": 20}, "grouping_overrides": {},
            "excluded_label_ids": [], "threshold": 10,
        },
        headers=headers,
    ).json()

    assert client.delete(f"/datasets/{created['id']}", headers=headers).status_code == 204
    assert client.get(f"/datasets/{created['id']}", headers=headers).status_code == 404


def test_unknown_dataset_returns_404():
    headers = _register_and_login("ds-api5@example.com")
    assert client.get("/datasets/99999999", headers=headers).status_code == 404


def test_split_config_totalling_over_100_is_rejected():
    headers = _register_and_login("ds-api6@example.com")
    response = client.post(
        "/datasets",
        json={
            "name": "ds-api6-dataset", "task_type": "detection", "sequence_ids": [],
            "split_config": {"train": 70, "val": 70}, "grouping_overrides": {},
            "excluded_label_ids": [], "threshold": 10,
        },
        headers=headers,
    )
    assert response.status_code == 422


def test_split_config_with_a_negative_value_is_rejected():
    headers = _register_and_login("ds-api7@example.com")
    response = client.post(
        "/datasets",
        json={
            "name": "ds-api7-dataset", "task_type": "detection", "sequence_ids": [],
            "split_config": {"train": -10, "val": 20}, "grouping_overrides": {},
            "excluded_label_ids": [], "threshold": 10,
        },
        headers=headers,
    )
    assert response.status_code == 422


def test_export_download_returns_a_presigned_url_for_a_succeeded_job():
    from app.db import SessionLocal
    from app.jobs.models import Job, JobStatus, JobType

    headers = _register_and_login("ds-api9@example.com")
    created = client.post(
        "/datasets",
        json={
            "name": "ds-api9-dataset", "task_type": "detection", "sequence_ids": [],
            "split_config": {"train": 70, "val": 20}, "grouping_overrides": {},
            "excluded_label_ids": [], "threshold": 10,
        },
        headers=headers,
    ).json()

    session = SessionLocal()
    try:
        user_id = client.get("/auth/me", headers=headers).json()["id"]
        job = Job(
            job_type=JobType.DATASET_EXPORT,
            status=JobStatus.SUCCEEDED,
            payload={"dataset_id": created["id"], "include_images": True},
            result_ref=f"datasets/{created['id']}/export-x.zip",
            created_by_id=user_id,
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        job_id = job.id
    finally:
        session.close()

    response = client.get(f"/datasets/{created['id']}/export/{job_id}/download", headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert "download_url" in body
    assert body["download_url"]

    client.delete(f"/datasets/{created['id']}", headers=headers)


def test_export_download_404s_for_a_job_belonging_to_another_dataset():
    from app.db import SessionLocal
    from app.jobs.models import Job, JobStatus, JobType

    headers = _register_and_login("ds-api10@example.com")
    dataset_a = client.post(
        "/datasets",
        json={
            "name": "ds-api10-dataset-a", "task_type": "detection", "sequence_ids": [],
            "split_config": {"train": 70, "val": 20}, "grouping_overrides": {},
            "excluded_label_ids": [], "threshold": 10,
        },
        headers=headers,
    ).json()
    dataset_b = client.post(
        "/datasets",
        json={
            "name": "ds-api10-dataset-b", "task_type": "detection", "sequence_ids": [],
            "split_config": {"train": 70, "val": 20}, "grouping_overrides": {},
            "excluded_label_ids": [], "threshold": 10,
        },
        headers=headers,
    ).json()

    session = SessionLocal()
    try:
        user_id = client.get("/auth/me", headers=headers).json()["id"]
        job = Job(
            job_type=JobType.DATASET_EXPORT,
            status=JobStatus.SUCCEEDED,
            payload={"dataset_id": dataset_a["id"], "include_images": True},
            result_ref=f"datasets/{dataset_a['id']}/export-x.zip",
            created_by_id=user_id,
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        job_id = job.id
    finally:
        session.close()

    # Job belongs to dataset_a; requesting it via dataset_b must 404.
    response = client.get(f"/datasets/{dataset_b['id']}/export/{job_id}/download", headers=headers)
    assert response.status_code == 404

    client.delete(f"/datasets/{dataset_a['id']}", headers=headers)
    client.delete(f"/datasets/{dataset_b['id']}", headers=headers)


def test_export_download_404s_for_an_unknown_job():
    headers = _register_and_login("ds-api11@example.com")
    created = client.post(
        "/datasets",
        json={
            "name": "ds-api11-dataset", "task_type": "detection", "sequence_ids": [],
            "split_config": {"train": 70, "val": 20}, "grouping_overrides": {},
            "excluded_label_ids": [], "threshold": 10,
        },
        headers=headers,
    ).json()

    response = client.get(f"/datasets/{created['id']}/export/99999999/download", headers=headers)
    assert response.status_code == 404

    client.delete(f"/datasets/{created['id']}", headers=headers)


def test_export_download_rejects_a_job_that_has_not_succeeded():
    from app.db import SessionLocal
    from app.jobs.models import Job, JobStatus, JobType

    headers = _register_and_login("ds-api12@example.com")
    created = client.post(
        "/datasets",
        json={
            "name": "ds-api12-dataset", "task_type": "detection", "sequence_ids": [],
            "split_config": {"train": 70, "val": 20}, "grouping_overrides": {},
            "excluded_label_ids": [], "threshold": 10,
        },
        headers=headers,
    ).json()

    session = SessionLocal()
    try:
        user_id = client.get("/auth/me", headers=headers).json()["id"]
        job = Job(
            job_type=JobType.DATASET_EXPORT,
            status=JobStatus.RUNNING,
            payload={"dataset_id": created["id"], "include_images": True},
            result_ref=None,
            created_by_id=user_id,
        )
        session.add(job)
        session.commit()
        session.refresh(job)
        job_id = job.id
    finally:
        session.close()

    response = client.get(f"/datasets/{created['id']}/export/{job_id}/download", headers=headers)
    assert response.status_code == 409

    client.delete(f"/datasets/{created['id']}", headers=headers)


def test_created_dataset_taxonomy_version_matches_its_included_annotations():
    headers = _register_and_login("ds-api8@example.com")
    sequences = client.get("/media/sequences", params={"page": 1, "page_size": 50}, headers=headers).json()
    sequence_ids = [s["id"] for s in sequences["items"]]

    created = client.post(
        "/datasets",
        json={
            "name": "ds-api8-dataset", "task_type": "detection",
            "sequence_ids": sequence_ids, "split_config": {"train": 70, "val": 20},
            "grouping_overrides": {}, "excluded_label_ids": [], "threshold": 10,
        },
        headers=headers,
    ).json()

    # The real dev DB's annotations are all taxonomy_version 1, while Label
    # rows can carry higher (test-debris) versions -- the dataset must pin
    # from the annotations it actually included, not the global label max.
    assert created["taxonomy_version"] == 1

    client.delete(f"/datasets/{created['id']}", headers=headers)
