from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _register_and_login(email: str, role: str = "annotator") -> str:
    client.post("/auth/register", json={"email": email, "password": "pass1234", "role": role})
    response = client.post("/auth/login", json={"email": email, "password": "pass1234"})
    return response.json()["access_token"]


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_get_settings_requires_auth():
    response = client.get("/settings")
    assert response.status_code == 401


def test_get_settings_returns_current_value_for_any_authenticated_role():
    token = _register_and_login("settings-get1@example.com", role="annotator")
    response = client.get("/settings", headers=_headers(token))
    assert response.status_code == 200
    assert "max_track_range_frames" in response.json()


def test_patch_settings_requires_auth():
    response = client.patch("/settings", json={"max_track_range_frames": 5})
    assert response.status_code == 401


def test_patch_settings_rejects_non_admin():
    token = _register_and_login("settings-patch1@example.com", role="annotator")
    response = client.patch(
        "/settings",
        json={"max_track_range_frames": 5, "mask_postprocess_strength": 0.3, "min_mask_area_fraction": 0.0005},
        headers=_headers(token),
    )
    assert response.status_code == 403


def test_patch_settings_allows_admin_and_persists_value():
    token = _register_and_login("settings-patch2@example.com", role="admin")
    response = client.patch(
        "/settings",
        json={"max_track_range_frames": 8, "mask_postprocess_strength": 0.3, "min_mask_area_fraction": 0.0005},
        headers=_headers(token),
    )
    assert response.status_code == 200
    assert response.json()["max_track_range_frames"] == 8

    get_response = client.get("/settings", headers=_headers(token))
    assert get_response.json()["max_track_range_frames"] == 8

    # Restore the seeded default so later tests (and manual runs) aren't
    # affected by this test's side effect on the singleton row.
    client.patch(
        "/settings",
        json={"max_track_range_frames": 10, "mask_postprocess_strength": 0.3, "min_mask_area_fraction": 0.0005},
        headers=_headers(token),
    )


def test_patch_settings_rejects_value_below_one():
    token = _register_and_login("settings-patch3@example.com", role="admin")
    response = client.patch("/settings", json={"max_track_range_frames": 0}, headers=_headers(token))
    assert response.status_code == 422


def test_get_settings_includes_mask_postprocess_strength():
    token = _register_and_login("settings-get2@example.com", role="annotator")
    response = client.get("/settings", headers=_headers(token))
    assert response.status_code == 200
    assert "mask_postprocess_strength" in response.json()


def test_patch_settings_allows_admin_to_update_mask_postprocess_strength():
    token = _register_and_login("settings-patch4@example.com", role="admin")
    response = client.patch(
        "/settings",
        json={"max_track_range_frames": 10, "mask_postprocess_strength": 0.6, "min_mask_area_fraction": 0.0005},
        headers=_headers(token),
    )
    assert response.status_code == 200
    assert response.json()["mask_postprocess_strength"] == 0.6

    get_response = client.get("/settings", headers=_headers(token))
    assert get_response.json()["mask_postprocess_strength"] == 0.6

    client.patch(
        "/settings",
        json={"max_track_range_frames": 10, "mask_postprocess_strength": 0.3, "min_mask_area_fraction": 0.0005},
        headers=_headers(token),
    )


def test_patch_settings_rejects_mask_postprocess_strength_out_of_range():
    token = _register_and_login("settings-patch5@example.com", role="admin")
    response = client.patch(
        "/settings",
        json={"max_track_range_frames": 10, "mask_postprocess_strength": 1.5, "min_mask_area_fraction": 0.0005},
        headers=_headers(token),
    )
    assert response.status_code == 422


def test_settings_expose_and_update_min_mask_area_fraction():
    headers = _headers(_register_and_login("settings-mmaf@example.com", role="admin"))

    read = client.get("/settings", headers=headers)
    assert read.status_code == 200
    assert "min_mask_area_fraction" in read.json()

    updated = client.patch(
        "/settings",
        json={
            "max_track_range_frames": 10,
            "mask_postprocess_strength": 0.3,
            "min_mask_area_fraction": 0.002,
        },
        headers=headers,
    )
    assert updated.status_code == 200
    assert updated.json()["min_mask_area_fraction"] == 0.002


def test_min_mask_area_fraction_rejects_values_outside_zero_to_one():
    headers = _headers(_register_and_login("settings-mmaf2@example.com", role="admin"))

    for bad in (-0.1, 1.5):
        response = client.patch(
            "/settings",
            json={
                "max_track_range_frames": 10,
                "mask_postprocess_strength": 0.3,
                "min_mask_area_fraction": bad,
            },
            headers=headers,
        )
        assert response.status_code == 422
