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

    create_response = client.post("/taxonomy/procedures", json={"name": "tax1-gastroscopy"}, headers=token)
    assert create_response.status_code == 201

    list_response = client.get("/taxonomy/procedures", headers=token)
    assert list_response.status_code == 200
    names = [p["name"] for p in list_response.json()]
    assert "tax1-gastroscopy" in names


def test_create_category_requires_auth():
    response = client.post("/taxonomy/categories", json={"name": "Anatomy", "procedure_id": 1})
    assert response.status_code == 401


def test_create_and_list_categories_for_a_procedure():
    token = _auth_headers(_register_and_login("tax2@example.com"))
    procedure = client.post("/taxonomy/procedures", json={"name": "tax2-colono"}, headers=token).json()

    create_response = client.post(
        "/taxonomy/categories", json={"name": "Anatomy", "procedure_id": procedure["id"]}, headers=token
    )
    assert create_response.status_code == 201
    body = create_response.json()
    assert body["name"] == "Anatomy"
    assert body["procedure_id"] == procedure["id"]

    list_response = client.get(f"/taxonomy/categories?procedure_id={procedure['id']}", headers=token)
    assert list_response.status_code == 200
    assert any(c["name"] == "Anatomy" for c in list_response.json())


def test_update_and_delete_category():
    token = _auth_headers(_register_and_login("tax3@example.com"))
    procedure = client.post("/taxonomy/procedures", json={"name": "tax3-colono"}, headers=token).json()
    category = client.post(
        "/taxonomy/categories", json={"name": "Findings", "procedure_id": procedure["id"]}, headers=token
    ).json()

    update_response = client.patch(
        f"/taxonomy/categories/{category['id']}", json={"name": "Findings renamed"}, headers=token
    )
    assert update_response.status_code == 200
    assert update_response.json()["name"] == "Findings renamed"

    delete_response = client.delete(f"/taxonomy/categories/{category['id']}", headers=token)
    assert delete_response.status_code == 204


def test_delete_category_with_labels_returns_409():
    token = _auth_headers(_register_and_login("tax4@example.com"))
    procedure = client.post("/taxonomy/procedures", json={"name": "tax4-colono"}, headers=token).json()
    category = client.post(
        "/taxonomy/categories", json={"name": "Anatomy", "procedure_id": procedure["id"]}, headers=token
    ).json()
    evaluation_type = client.post(
        "/taxonomy/evaluation-types", json={"name": "tax4-geometric"}, headers=token
    ).json()
    client.post(
        "/taxonomy/labels",
        json={
            "name": "pharynx",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=token,
    )

    delete_response = client.delete(f"/taxonomy/categories/{category['id']}", headers=token)
    assert delete_response.status_code == 409


def test_create_and_list_evaluation_types():
    token = _auth_headers(_register_and_login("tax5@example.com"))

    create_response = client.post("/taxonomy/evaluation-types", json={"name": "tax5-geometric"}, headers=token)
    assert create_response.status_code == 201

    list_response = client.get("/taxonomy/evaluation-types", headers=token)
    assert list_response.status_code == 200
    assert any(e["name"] == "tax5-geometric" for e in list_response.json())


def test_delete_evaluation_type_with_labels_returns_409():
    token = _auth_headers(_register_and_login("tax6@example.com"))
    procedure = client.post("/taxonomy/procedures", json={"name": "tax6-colono"}, headers=token).json()
    category = client.post(
        "/taxonomy/categories", json={"name": "Anatomy", "procedure_id": procedure["id"]}, headers=token
    ).json()
    evaluation_type = client.post(
        "/taxonomy/evaluation-types", json={"name": "tax6-geometric"}, headers=token
    ).json()
    client.post(
        "/taxonomy/labels",
        json={
            "name": "pharynx",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=token,
    )

    delete_response = client.delete(f"/taxonomy/evaluation-types/{evaluation_type['id']}", headers=token)
    assert delete_response.status_code == 409


def test_create_and_list_labels():
    token = _auth_headers(_register_and_login("tax7@example.com"))
    procedure = client.post("/taxonomy/procedures", json={"name": "tax7-colono"}, headers=token).json()
    category = client.post(
        "/taxonomy/categories", json={"name": "Anatomy", "procedure_id": procedure["id"]}, headers=token
    ).json()
    evaluation_type = client.post(
        "/taxonomy/evaluation-types", json={"name": "tax7-geometric"}, headers=token
    ).json()

    response = client.post(
        "/taxonomy/labels",
        json={
            "name": "pharynx",
            "color": "#FF0000",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=token,
    )
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "pharynx"
    assert body["taxonomy_version"] == 1

    list_response = client.get(f"/taxonomy/labels?category_id={category['id']}", headers=token)
    assert any(label["name"] == "pharynx" for label in list_response.json())


def test_taxonomy_tree_groups_labels_by_category_and_evaluation_type():
    token = _auth_headers(_register_and_login("tax8@example.com"))
    procedure = client.post("/taxonomy/procedures", json={"name": "tax8-colono"}, headers=token).json()
    anatomy = client.post(
        "/taxonomy/categories", json={"name": "Anatomy", "procedure_id": procedure["id"]}, headers=token
    ).json()
    findings = client.post(
        "/taxonomy/categories", json={"name": "Findings", "procedure_id": procedure["id"]}, headers=token
    ).json()
    geometric = client.post(
        "/taxonomy/evaluation-types", json={"name": "tax8-geometric"}, headers=token
    ).json()
    morphological = client.post(
        "/taxonomy/evaluation-types", json={"name": "tax8-morphological"}, headers=token
    ).json()

    client.post(
        "/taxonomy/labels",
        json={"name": "pharynx", "category_id": anatomy["id"], "evaluation_type_id": geometric["id"]},
        headers=token,
    )
    client.post(
        "/taxonomy/labels",
        json={"name": "colon_adenoma", "category_id": findings["id"], "evaluation_type_id": morphological["id"]},
        headers=token,
    )

    response = client.get(f"/taxonomy/tree?procedure_id={procedure['id']}", headers=token)

    assert response.status_code == 200
    tree = response.json()
    assert len(tree) == 2

    anatomy_node = next(node for node in tree if node["category"]["id"] == anatomy["id"])
    assert len(anatomy_node["evaluation_types"]) == 1
    assert anatomy_node["evaluation_types"][0]["evaluation_type"]["id"] == geometric["id"]
    assert [label["name"] for label in anatomy_node["evaluation_types"][0]["labels"]] == ["pharynx"]

    findings_node = next(node for node in tree if node["category"]["id"] == findings["id"])
    assert findings_node["evaluation_types"][0]["evaluation_type"]["id"] == morphological["id"]


def test_taxonomy_tree_only_returns_categories_for_the_given_procedure():
    token = _auth_headers(_register_and_login("tax9@example.com"))
    procedure_a = client.post("/taxonomy/procedures", json={"name": "tax9-colono"}, headers=token).json()
    procedure_b = client.post("/taxonomy/procedures", json={"name": "tax9-egds"}, headers=token).json()
    client.post(
        "/taxonomy/categories", json={"name": "Anatomy", "procedure_id": procedure_a["id"]}, headers=token
    )
    client.post(
        "/taxonomy/categories", json={"name": "Anatomy", "procedure_id": procedure_b["id"]}, headers=token
    )

    response = client.get(f"/taxonomy/tree?procedure_id={procedure_a['id']}", headers=token)

    assert response.status_code == 200
    assert len(response.json()) == 1
