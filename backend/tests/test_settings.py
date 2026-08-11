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
    response = client.patch("/settings", json={"max_track_range_frames": 5}, headers=_headers(token))
    assert response.status_code == 403


def test_patch_settings_allows_admin_and_persists_value():
    token = _register_and_login("settings-patch2@example.com", role="admin")
    response = client.patch("/settings", json={"max_track_range_frames": 8}, headers=_headers(token))
    assert response.status_code == 200
    assert response.json()["max_track_range_frames"] == 8

    get_response = client.get("/settings", headers=_headers(token))
    assert get_response.json()["max_track_range_frames"] == 8

    # Restore the seeded default so later tests (and manual runs) aren't
    # affected by this test's side effect on the singleton row.
    client.patch("/settings", json={"max_track_range_frames": 10}, headers=_headers(token))


def test_patch_settings_rejects_value_below_one():
    token = _register_and_login("settings-patch3@example.com", role="admin")
    response = client.patch("/settings", json={"max_track_range_frames": 0}, headers=_headers(token))
    assert response.status_code == 422
