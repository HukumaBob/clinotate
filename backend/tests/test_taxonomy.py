from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _register_and_login(email: str) -> str:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": "admin"})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return response.json()["access_token"]


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_create_procedure_and_list_it():
    token = _auth_headers(_register_and_login("tax1@example.com"))

    create_response = client.post("/taxonomy/procedures", json={"name": "Gastroscopy"}, headers=token)
    assert create_response.status_code == 201

    list_response = client.get("/taxonomy/procedures", headers=token)
    assert list_response.status_code == 200
    names = [p["name"] for p in list_response.json()]
    assert "Gastroscopy" in names


def test_create_label_requires_auth():
    response = client.post("/taxonomy/labels", json={"name": "Polyp", "label_type": "morphological"})
    assert response.status_code == 401


def test_create_and_list_labels():
    token = _auth_headers(_register_and_login("tax2@example.com"))

    response = client.post(
        "/taxonomy/labels",
        json={"name": "Polyp", "label_type": "morphological", "color": "#FF0000"},
        headers=token,
    )
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Polyp"
    assert body["taxonomy_version"] == 1

    list_response = client.get("/taxonomy/labels", headers=token)
    assert any(label["name"] == "Polyp" for label in list_response.json())


def test_label_descendants_via_recursive_relation():
    token = _auth_headers(_register_and_login("tax3@example.com"))

    parent = client.post(
        "/taxonomy/labels", json={"name": "GI Tract", "label_type": "geometric"}, headers=token
    ).json()
    child = client.post(
        "/taxonomy/labels", json={"name": "Stomach", "label_type": "geometric"}, headers=token
    ).json()
    grandchild = client.post(
        "/taxonomy/labels", json={"name": "Antrum", "label_type": "geometric"}, headers=token
    ).json()

    client.post(
        "/taxonomy/labels/relations",
        json={"parent_id": parent["id"], "child_id": child["id"], "confidence": 1.0},
        headers=token,
    )
    client.post(
        "/taxonomy/labels/relations",
        json={"parent_id": child["id"], "child_id": grandchild["id"], "confidence": 1.0},
        headers=token,
    )

    response = client.get(f"/taxonomy/labels/{parent['id']}/descendants", headers=token)

    assert response.status_code == 200
    descendant_ids = {label["id"] for label in response.json()}
    assert descendant_ids == {child["id"], grandchild["id"]}
