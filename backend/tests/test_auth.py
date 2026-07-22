from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_register_creates_user_and_returns_201():
    response = client.post(
        "/auth/register",
        json={"email": "annotator@example.com", "password": "s3cret-pass", "role": "annotator"},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["email"] == "annotator@example.com"
    assert body["role"] == "annotator"
    assert "hashed_password" not in body
    assert "password" not in body


def test_register_rejects_duplicate_email():
    client.post(
        "/auth/register",
        json={"email": "dup@example.com", "password": "s3cret-pass", "role": "annotator"},
    )
    response = client.post(
        "/auth/register",
        json={"email": "dup@example.com", "password": "other-pass", "role": "annotator"},
    )
    assert response.status_code == 409


def test_login_with_correct_credentials_returns_token():
    client.post(
        "/auth/register",
        json={"email": "login@example.com", "password": "correct-pass", "role": "annotator"},
    )
    response = client.post(
        "/auth/login", json={"email": "login@example.com", "password": "correct-pass"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["token_type"] == "bearer"
    assert len(body["access_token"]) > 0


def test_login_with_wrong_password_returns_401():
    client.post(
        "/auth/register",
        json={"email": "wrongpass@example.com", "password": "correct-pass", "role": "annotator"},
    )
    response = client.post(
        "/auth/login", json={"email": "wrongpass@example.com", "password": "bad-pass"}
    )
    assert response.status_code == 401


def test_me_requires_valid_token():
    response = client.get("/auth/me")
    assert response.status_code == 401


def test_me_returns_current_user_with_valid_token():
    client.post(
        "/auth/register",
        json={"email": "me@example.com", "password": "correct-pass", "role": "reviewer"},
    )
    login_response = client.post(
        "/auth/login", json={"email": "me@example.com", "password": "correct-pass"}
    )
    token = login_response.json()["access_token"]

    response = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 200
    assert response.json()["email"] == "me@example.com"
    assert response.json()["role"] == "reviewer"
