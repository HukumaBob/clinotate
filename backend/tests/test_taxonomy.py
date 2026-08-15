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


def test_update_and_delete_procedure():
    headers = _auth_headers(_register_and_login("tax13@example.com"))
    procedure = client.post("/taxonomy/procedures", json={"name": "tax13-colono"}, headers=headers).json()

    update_response = client.patch(
        f"/taxonomy/procedures/{procedure['id']}", json={"name": "tax13-colono renamed"}, headers=headers
    )
    assert update_response.status_code == 200
    assert update_response.json()["name"] == "tax13-colono renamed"

    delete_response = client.delete(f"/taxonomy/procedures/{procedure['id']}", headers=headers)
    assert delete_response.status_code == 204


def test_delete_procedure_with_categories_returns_409():
    headers = _auth_headers(_register_and_login("tax14@example.com"))
    procedure = client.post("/taxonomy/procedures", json={"name": "tax14-colono"}, headers=headers).json()
    client.post(
        "/taxonomy/categories", json={"name": "Anatomy", "procedure_id": procedure["id"]}, headers=headers
    )

    delete_response = client.delete(f"/taxonomy/procedures/{procedure['id']}", headers=headers)
    assert delete_response.status_code == 409
    assert "categories" in delete_response.json()["detail"]


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
        "/taxonomy/evaluation-types",
        json={"name": "tax4-geometric", "annotation_scope": "region"},
        headers=token,
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


def test_create_evaluation_type_requires_annotation_scope():
    token = _auth_headers(_register_and_login("tax-scope1@example.com"))

    response = client.post(
        "/taxonomy/evaluation-types", json={"name": "tax-scope1-frame"}, headers=token
    )

    assert response.status_code == 422


def test_create_evaluation_type_with_frame_scope():
    token = _auth_headers(_register_and_login("tax-scope2@example.com"))

    response = client.post(
        "/taxonomy/evaluation-types",
        json={"name": "tax-scope2-frame", "annotation_scope": "frame"},
        headers=token,
    )

    assert response.status_code == 201
    assert response.json()["annotation_scope"] == "frame"


def test_taxonomy_tree_includes_annotation_scope_on_evaluation_type():
    token = _auth_headers(_register_and_login("tax-scope3@example.com"))
    procedure = client.post(
        "/taxonomy/procedures", json={"name": "tax-scope3-colono"}, headers=token
    ).json()
    category = client.post(
        "/taxonomy/categories",
        json={"name": "Landmark", "procedure_id": procedure["id"]},
        headers=token,
    ).json()
    evaluation_type = client.post(
        "/taxonomy/evaluation-types",
        json={"name": "tax-scope3-frame", "annotation_scope": "frame"},
        headers=token,
    ).json()
    client.post(
        "/taxonomy/labels",
        json={
            "name": "antrum",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=token,
    )

    response = client.get(f"/taxonomy/tree?procedure_id={procedure['id']}", headers=token)

    assert response.status_code == 200
    tree = response.json()
    node = next(n for n in tree if n["category"]["id"] == category["id"])
    assert node["evaluation_types"][0]["evaluation_type"]["annotation_scope"] == "frame"


def test_create_and_list_evaluation_types():
    token = _auth_headers(_register_and_login("tax5@example.com"))

    create_response = client.post(
        "/taxonomy/evaluation-types",
        json={"name": "tax5-geometric", "annotation_scope": "region"},
        headers=token,
    )
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
        "/taxonomy/evaluation-types",
        json={"name": "tax6-geometric", "annotation_scope": "region"},
        headers=token,
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
        "/taxonomy/evaluation-types",
        json={"name": "tax7-geometric", "annotation_scope": "region"},
        headers=token,
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
        "/taxonomy/evaluation-types",
        json={"name": "tax8-geometric", "annotation_scope": "region"},
        headers=token,
    ).json()
    morphological = client.post(
        "/taxonomy/evaluation-types",
        json={"name": "tax8-morphological", "annotation_scope": "region"},
        headers=token,
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


def test_taxonomy_tree_without_procedure_id_returns_all_procedures():
    token = _auth_headers(_register_and_login("tax10@example.com"))
    procedure_a = client.post("/taxonomy/procedures", json={"name": "tax10-colono"}, headers=token).json()
    procedure_b = client.post("/taxonomy/procedures", json={"name": "tax10-egds"}, headers=token).json()
    client.post(
        "/taxonomy/categories", json={"name": "tax10-Anatomy-A", "procedure_id": procedure_a["id"]}, headers=token
    )
    client.post(
        "/taxonomy/categories", json={"name": "tax10-Anatomy-B", "procedure_id": procedure_b["id"]}, headers=token
    )

    response = client.get("/taxonomy/tree", headers=token)

    assert response.status_code == 200
    names = [node["category"]["name"] for node in response.json()]
    assert "tax10-Anatomy-A" in names
    assert "tax10-Anatomy-B" in names


def _create_frame(token: str) -> int:
    headers = _auth_headers(token)
    from pathlib import Path

    from app.db import SessionLocal
    from app.taxonomy.models import Procedure

    session = SessionLocal()
    procedure = session.query(Procedure).filter_by(name="tags-frame-procedure").one_or_none()
    if procedure is None:
        procedure = Procedure(name="tags-frame-procedure")
        session.add(procedure)
        session.commit()
        session.refresh(procedure)
    procedure_id = procedure.id
    session.close()

    fixture = Path(__file__).parent / "fixtures" / "tiny.mp4"
    with open(fixture, "rb") as f:
        upload = client.post(
            "/media/videos", files={"file": ("tiny.mp4", f, "video/mp4")},
            data={"title": "tags source", "procedure_id": procedure_id}, headers=headers,
        )
    video_id = upload.json()["id"]
    sequence = client.post(
        f"/media/videos/{video_id}/sequences",
        json={"name": "tags test sequence", "start_time": 0, "duration": 2},
        headers=headers,
    ).json()
    frames = client.get(f"/media/sequences/{sequence['id']}/frames", headers=headers).json()
    return frames[0]["id"]


def _create_annotation_for_label(token: str, frame_id: int, label_id: int, taxonomy_version: int) -> None:
    from app.annotation.models import Annotation, AnnotationStatus, AnnotationType
    from app.auth.models import User
    from app.db import SessionLocal

    session = SessionLocal()
    try:
        user = session.query(User).order_by(User.id.desc()).first()
        annotation = Annotation(
            frame_id=frame_id,
            label_id=label_id,
            taxonomy_version=taxonomy_version,
            annotation_type=AnnotationType.CLASSIFICATION,
            status=AnnotationStatus.DRAFT,
            created_by_id=user.id,
        )
        session.add(annotation)
        session.commit()
    finally:
        session.close()


def test_delete_label_with_annotations_returns_409():
    token = _register_and_login("tax11@example.com")
    headers = _auth_headers(token)
    procedure = client.post("/taxonomy/procedures", json={"name": "tax11-colono"}, headers=headers).json()
    category = client.post(
        "/taxonomy/categories", json={"name": "Anatomy", "procedure_id": procedure["id"]}, headers=headers
    ).json()
    evaluation_type = client.post(
        "/taxonomy/evaluation-types",
        json={"name": "tax11-geometric", "annotation_scope": "region"},
        headers=headers,
    ).json()
    label = client.post(
        "/taxonomy/labels",
        json={"name": "pharynx", "category_id": category["id"], "evaluation_type_id": evaluation_type["id"]},
        headers=headers,
    ).json()
    frame_id = _create_frame(token)
    _create_annotation_for_label(token, frame_id, label["id"], label["taxonomy_version"])

    delete_response = client.delete(f"/taxonomy/labels/{label['id']}", headers=headers)

    assert delete_response.status_code == 409


def test_label_mask_counts_reflects_annotation_usage():
    token = _register_and_login("tax12@example.com")
    headers = _auth_headers(token)
    procedure = client.post("/taxonomy/procedures", json={"name": "tax12-colono"}, headers=headers).json()
    category = client.post(
        "/taxonomy/categories", json={"name": "Anatomy", "procedure_id": procedure["id"]}, headers=headers
    ).json()
    evaluation_type = client.post(
        "/taxonomy/evaluation-types",
        json={"name": "tax12-geometric", "annotation_scope": "region"},
        headers=headers,
    ).json()
    label = client.post(
        "/taxonomy/labels",
        json={"name": "pharynx", "category_id": category["id"], "evaluation_type_id": evaluation_type["id"]},
        headers=headers,
    ).json()
    frame_id = _create_frame(token)
    _create_annotation_for_label(token, frame_id, label["id"], label["taxonomy_version"])

    response = client.get("/taxonomy/labels/mask-counts", headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert body[str(label["id"])] == 1


def test_label_read_exposes_hierarchy_fields():
    headers = _auth_headers(_register_and_login("tax-hier1@example.com"))
    procedure = client.post(
        "/taxonomy/procedures", json={"name": "tax-hier1-proc"}, headers=headers
    ).json()
    category = client.post(
        "/taxonomy/categories",
        json={"name": "tax-hier1-cat", "procedure_id": procedure["id"]},
        headers=headers,
    ).json()
    evaluation_type = client.post(
        "/taxonomy/evaluation-types",
        json={"name": "tax-hier1-et", "annotation_scope": "region"},
        headers=headers,
    ).json()

    label = client.post(
        "/taxonomy/labels",
        json={
            "name": "tax-hier1-label",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=headers,
    ).json()

    assert label["parent_label_id"] is None
    assert label["is_abstract"] is False


def test_assigning_a_valid_parent_succeeds_and_marking_abstract_works():
    headers = _auth_headers(_register_and_login("tax-hier2@example.com"))
    procedure = client.post(
        "/taxonomy/procedures", json={"name": "tax-hier2-proc"}, headers=headers
    ).json()
    category = client.post(
        "/taxonomy/categories",
        json={"name": "tax-hier2-cat", "procedure_id": procedure["id"]},
        headers=headers,
    ).json()
    evaluation_type = client.post(
        "/taxonomy/evaluation-types",
        json={"name": "tax-hier2-et", "annotation_scope": "region"},
        headers=headers,
    ).json()

    def make_label(name):
        return client.post(
            "/taxonomy/labels",
            json={
                "name": name,
                "category_id": category["id"],
                "evaluation_type_id": evaluation_type["id"],
            },
            headers=headers,
        ).json()

    parent = make_label("tax-hier2-parent")
    child = make_label("tax-hier2-child")

    response = client.patch(
        f"/taxonomy/labels/{child['id']}",
        json={"parent_label_id": parent["id"]},
        headers=headers,
    )
    assert response.status_code == 200
    assert response.json()["parent_label_id"] == parent["id"]

    abstract_response = client.patch(
        f"/taxonomy/labels/{parent['id']}", json={"is_abstract": True}, headers=headers
    )
    assert abstract_response.status_code == 200
    assert abstract_response.json()["is_abstract"] is True


def test_assigning_a_cross_procedure_parent_returns_422():
    headers = _auth_headers(_register_and_login("tax-hier3@example.com"))
    evaluation_type = client.post(
        "/taxonomy/evaluation-types",
        json={"name": "tax-hier3-et", "annotation_scope": "region"},
        headers=headers,
    ).json()

    def make_label_in(procedure_name, category_name, label_name):
        procedure = client.post(
            "/taxonomy/procedures", json={"name": procedure_name}, headers=headers
        ).json()
        category = client.post(
            "/taxonomy/categories",
            json={"name": category_name, "procedure_id": procedure["id"]},
            headers=headers,
        ).json()
        return client.post(
            "/taxonomy/labels",
            json={
                "name": label_name,
                "category_id": category["id"],
                "evaluation_type_id": evaluation_type["id"],
            },
            headers=headers,
        ).json()

    child = make_label_in("tax-hier3-proc-a", "tax-hier3-cat-a", "tax-hier3-child")
    parent = make_label_in("tax-hier3-proc-b", "tax-hier3-cat-b", "tax-hier3-parent")

    response = client.patch(
        f"/taxonomy/labels/{child['id']}",
        json={"parent_label_id": parent["id"]},
        headers=headers,
    )
    assert response.status_code == 422


def test_self_parent_returns_422():
    headers = _auth_headers(_register_and_login("tax-hier4@example.com"))
    procedure = client.post(
        "/taxonomy/procedures", json={"name": "tax-hier4-proc"}, headers=headers
    ).json()
    category = client.post(
        "/taxonomy/categories",
        json={"name": "tax-hier4-cat", "procedure_id": procedure["id"]},
        headers=headers,
    ).json()
    evaluation_type = client.post(
        "/taxonomy/evaluation-types",
        json={"name": "tax-hier4-et", "annotation_scope": "region"},
        headers=headers,
    ).json()
    label = client.post(
        "/taxonomy/labels",
        json={
            "name": "tax-hier4-label",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=headers,
    ).json()

    response = client.patch(
        f"/taxonomy/labels/{label['id']}",
        json={"parent_label_id": label["id"]},
        headers=headers,
    )
    assert response.status_code == 422


def test_combined_category_and_parent_patch_cannot_smuggle_a_cross_procedure_edge():
    """Important finding 1: validate_parent_assignment must not read stale fields.

    A single PATCH that changes category_id (moving the child to another
    procedure) AND sets parent_label_id in the same request used to be
    validated against the label's *pre-mutation* category_id, so the parent
    (which is legitimately in the child's old procedure) passed validation --
    then both fields were written, leaving a cross-procedure edge on disk.
    """
    headers = _auth_headers(_register_and_login("tax-hier5@example.com"))

    procedure_a = client.post(
        "/taxonomy/procedures", json={"name": "tax-hier5-proc-a"}, headers=headers
    ).json()
    procedure_b = client.post(
        "/taxonomy/procedures", json={"name": "tax-hier5-proc-b"}, headers=headers
    ).json()
    category_a = client.post(
        "/taxonomy/categories",
        json={"name": "tax-hier5-cat-a", "procedure_id": procedure_a["id"]},
        headers=headers,
    ).json()
    category_b = client.post(
        "/taxonomy/categories",
        json={"name": "tax-hier5-cat-b", "procedure_id": procedure_b["id"]},
        headers=headers,
    ).json()
    evaluation_type = client.post(
        "/taxonomy/evaluation-types",
        json={"name": "tax-hier5-et", "annotation_scope": "region"},
        headers=headers,
    ).json()

    parent = client.post(
        "/taxonomy/labels",
        json={
            "name": "tax-hier5-parent",
            "category_id": category_a["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=headers,
    ).json()
    child = client.post(
        "/taxonomy/labels",
        json={
            "name": "tax-hier5-child",
            "category_id": category_a["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=headers,
    ).json()

    # child moves to category_b (procedure B) AND gets parent (still in procedure A)
    # in the same request.
    response = client.patch(
        f"/taxonomy/labels/{child['id']}",
        json={"category_id": category_b["id"], "parent_label_id": parent["id"]},
        headers=headers,
    )

    assert response.status_code == 422

    unchanged = client.get(f"/taxonomy/labels?category_id={category_a['id']}", headers=headers).json()
    unchanged_child = next(label for label in unchanged if label["id"] == child["id"])
    assert unchanged_child["category_id"] == category_a["id"]
    assert unchanged_child["parent_label_id"] is None


def test_changing_category_alone_is_rejected_when_it_would_orphan_the_existing_parent_edge():
    """Important finding 2: category/evaluation_type changes must re-validate
    existing edges, not just when parent_label_id itself is in the payload.

    Reproduces the live exploit: PATCH {"category_id": <other procedure>} on a
    label that already has a parent must now fail with 422 and leave the row
    unchanged, instead of silently persisting a cross-procedure edge.
    """
    headers = _auth_headers(_register_and_login("tax-hier6@example.com"))

    procedure_a = client.post(
        "/taxonomy/procedures", json={"name": "tax-hier6-proc-a"}, headers=headers
    ).json()
    procedure_b = client.post(
        "/taxonomy/procedures", json={"name": "tax-hier6-proc-b"}, headers=headers
    ).json()
    category_a = client.post(
        "/taxonomy/categories",
        json={"name": "tax-hier6-cat-a", "procedure_id": procedure_a["id"]},
        headers=headers,
    ).json()
    category_b = client.post(
        "/taxonomy/categories",
        json={"name": "tax-hier6-cat-b", "procedure_id": procedure_b["id"]},
        headers=headers,
    ).json()
    evaluation_type = client.post(
        "/taxonomy/evaluation-types",
        json={"name": "tax-hier6-et", "annotation_scope": "region"},
        headers=headers,
    ).json()

    parent = client.post(
        "/taxonomy/labels",
        json={
            "name": "tax-hier6-parent",
            "category_id": category_a["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=headers,
    ).json()
    child = client.post(
        "/taxonomy/labels",
        json={
            "name": "tax-hier6-child",
            "category_id": category_a["id"],
            "evaluation_type_id": evaluation_type["id"],
        },
        headers=headers,
    ).json()
    give_parent = client.patch(
        f"/taxonomy/labels/{child['id']}",
        json={"parent_label_id": parent["id"]},
        headers=headers,
    )
    assert give_parent.status_code == 200

    response = client.patch(
        f"/taxonomy/labels/{child['id']}",
        json={"category_id": category_b["id"]},
        headers=headers,
    )

    assert response.status_code == 422

    unchanged = client.get(f"/taxonomy/labels?category_id={category_a['id']}", headers=headers).json()
    unchanged_child = next(label for label in unchanged if label["id"] == child["id"])
    assert unchanged_child["category_id"] == category_a["id"]
    assert unchanged_child["parent_label_id"] == parent["id"]


def test_changing_a_parents_evaluation_type_is_rejected_when_it_would_strand_children():
    """Important finding 2, parent side: changing a PARENT's evaluation_type_id
    must re-check every child edge pointing at it, not just its own edge.
    """
    headers = _auth_headers(_register_and_login("tax-hier7@example.com"))

    procedure = client.post(
        "/taxonomy/procedures", json={"name": "tax-hier7-proc"}, headers=headers
    ).json()
    category = client.post(
        "/taxonomy/categories",
        json={"name": "tax-hier7-cat", "procedure_id": procedure["id"]},
        headers=headers,
    ).json()
    evaluation_type_region = client.post(
        "/taxonomy/evaluation-types",
        json={"name": "tax-hier7-et-region", "annotation_scope": "region"},
        headers=headers,
    ).json()
    evaluation_type_frame = client.post(
        "/taxonomy/evaluation-types",
        json={"name": "tax-hier7-et-frame", "annotation_scope": "frame"},
        headers=headers,
    ).json()

    parent = client.post(
        "/taxonomy/labels",
        json={
            "name": "tax-hier7-parent",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type_region["id"],
        },
        headers=headers,
    ).json()
    child = client.post(
        "/taxonomy/labels",
        json={
            "name": "tax-hier7-child",
            "category_id": category["id"],
            "evaluation_type_id": evaluation_type_region["id"],
        },
        headers=headers,
    ).json()
    give_parent = client.patch(
        f"/taxonomy/labels/{child['id']}",
        json={"parent_label_id": parent["id"]},
        headers=headers,
    )
    assert give_parent.status_code == 200

    response = client.patch(
        f"/taxonomy/labels/{parent['id']}",
        json={"evaluation_type_id": evaluation_type_frame["id"]},
        headers=headers,
    )

    assert response.status_code == 422

    unchanged = client.get(
        f"/taxonomy/labels?evaluation_type_id={evaluation_type_region['id']}", headers=headers
    ).json()
    unchanged_parent = next(label for label in unchanged if label["id"] == parent["id"])
    assert unchanged_parent["evaluation_type_id"] == evaluation_type_region["id"]
