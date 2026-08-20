"""Tests for the auth API (register/login/logout/me)."""

from __future__ import annotations

from app import db
from app.security import hash_password

from helpers import register_user


def test_register_creates_user_and_sets_cookie(client):
    res = register_user(client)
    assert res.status_code == 201
    data = res.json()
    assert data["email"] == "user@example.com"
    assert data["name"] == "Test User"
    assert "clipforge_session" in res.cookies


def test_register_duplicate_email_409(client):
    assert register_user(client).status_code == 201
    res = register_user(client)
    assert res.status_code == 409


def test_register_short_password_422(client):
    res = client.post(
        "/api/v1/auth/register",
        json={"name": "x", "email": "a@b.com", "password": "short"},
    )
    assert res.status_code == 422


def test_login_success_and_wrong_password(client):
    register_user(client, email="a@b.com", password="correct-horse")

    res = client.post(
        "/api/v1/auth/login", json={"email": "a@b.com", "password": "correct-horse"}
    )
    assert res.status_code == 200
    assert res.json()["email"] == "a@b.com"

    res = client.post(
        "/api/v1/auth/login", json={"email": "a@b.com", "password": "wrong"}
    )
    assert res.status_code == 401


def test_me_requires_auth(client):
    assert client.get("/api/v1/auth/me").status_code == 401


def test_me_returns_user(client):
    register_user(client)
    res = client.get("/api/v1/auth/me")
    assert res.status_code == 200
    assert res.json()["email"] == "user@example.com"


def test_logout_revokes_session(client):
    register_user(client)
    assert client.get("/api/v1/auth/me").status_code == 200

    res = client.post("/api/v1/auth/logout")
    assert res.status_code == 204
    assert client.get("/api/v1/auth/me").status_code == 401


def test_password_is_hashed_not_plaintext(client):
    register_user(client, email="h@b.com", password="super-secret")
    user = db.get_user_by_email("h@b.com")
    assert user["password_hash"] != "super-secret"
    assert hash_password("super-secret") != user["password_hash"]
