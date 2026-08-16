import app.main  # noqa: F401
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _register_and_login(email: str) -> dict[str, str]:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "admin"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_sequence_list_reports_per_scope_annotation_counts():
    headers = _register_and_login("seq-scope1@example.com")

    procedure_id = client.post(
        "/taxonomy/procedures", json={"name": "seq-scope-counts-procedure"}, headers=headers
    ).json()["id"]
    client.post(
        "/media/sequences",
        json={"procedure_id": procedure_id, "name": "seq-scope-counts-sequence"},
        headers=headers,
    )

    response = client.get("/media/sequences", params={"page": 1, "page_size": 5}, headers=headers)

    assert response.status_code == 200
    items = response.json()["items"]
    assert items, "expected at least one sequence to exist after creating one"
    for item in items:
        assert "region_annotation_count" in item
        assert "frame_annotation_count" in item
        assert item["region_annotation_count"] >= 0
        assert item["frame_annotation_count"] >= 0
