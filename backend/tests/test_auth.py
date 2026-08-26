"""Tests for the auth API (register/login/logout/me)."""

from __future__ import annotations

from app import db
from app.security import hash_password, hash_token

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


# ------------------------------------------------------- session hardening


def test_session_token_stored_hashed_not_plaintext(client):
    from app.security import (
        get_user_from_session,
        new_session_token,
        create_session,
    )

    uid = db.get_user_by_email(register_user(client).json()["email"])["id"]
    raw = new_session_token()
    session = create_session(uid, raw)

    # Real resolution path: the raw cookie token resolves to the user...
    resolved = get_user_from_session(raw)
    assert resolved is not None
    assert resolved.id == uid

    # ...because the row is stored under the SHA-256 of the token, never
    # the plaintext.
    stored = db.get_session_by_token(hash_token(raw))
    assert stored is not None
    assert stored["id"] == session["id"]
    assert stored["token"] == hash_token(raw)
    assert stored["token"] != raw


def test_login_rate_limited_after_repeated_failures(client):
    register_user(client, email="rl@example.com", password="correct-horse")
    for _ in range(10):
        res = client.post(
            "/api/v1/auth/login",
            json={"email": "rl@example.com", "password": "wrong-password"},
        )
        assert res.status_code in (200, 401)
    # The 11th attempt for the same ip+email is throttled.
    res = client.post(
        "/api/v1/auth/login",
        json={"email": "rl@example.com", "password": "correct-horse"},
    )
    assert res.status_code == 429


def test_logout_clears_cookie_even_with_dead_session(client):
    """Logout must clear the cookie (204) even when the session is already
    expired/unknown — otherwise a stale cookie rides along forever."""
    res = client.post(
        "/api/v1/auth/logout",
        cookies={"clipforge_session": "bogus-expired-token"},
    )
    assert res.status_code == 204


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
