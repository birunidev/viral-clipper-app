"""Authentication primitives: password hashing and session cookies.

Passwords are hashed with Argon2 (argon2-cffi). Sessions are opaque random
tokens stored in the ``sessions`` table and delivered as an httpOnly,
SameSite=Lax cookie named ``clipforge_session``.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass

import argon2
from argon2.exceptions import VerificationError as ArgonVerificationError

from fastapi import Cookie, HTTPException, Response

from . import db
from .database import session_scope

SESSION_COOKIE = "clipforge_session"
SESSION_DAYS = 30

_password_hasher = argon2.PasswordHasher(
    time_cost=2,
    memory_cost=19 * 1024,  # 19 MiB
    parallelism=1,
    hash_len=32,
)


@dataclass
class SessionUser:
    """The authenticated user attached to a request."""

    id: str
    email: str
    name: str | None


def hash_password(password: str) -> str:
    return _password_hasher.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    if not password_hash:
        return False
    try:
        return _password_hasher.verify(password_hash, password)
    except (ArgonVerificationError, argon2.exceptions.InvalidHashError, ValueError):
        return False


def new_session_token() -> str:
    return secrets.token_urlsafe(48)


def create_session(user_id: str, token: str, ttl_days: int = SESSION_DAYS) -> dict:
    """Persist a session row and return its fields (id, token, expires_at)."""
    import datetime as dt

    now = dt.datetime.now(dt.timezone.utc)
    expires = now + dt.timedelta(days=ttl_days)
    session_id = db.create_session_row(user_id=user_id, token=token, expires_at=expires)
    return {"id": session_id, "token": token, "expires_at": expires}


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_DAYS * 24 * 3600,
        httponly=True,
        samesite="lax",
        secure=False,  # set True behind TLS in production (see main.py / Caddy)
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")


def get_user_from_session(session_token: str | None) -> SessionUser | None:
    """Resolve a session token to a user, or None if invalid/expired."""
    if not session_token:
        return None
    row = db.get_session_by_token(session_token)
    if not row:
        return None
    if row["expires_at"] is None:
        return None
    import datetime as dt

    expires = row["expires_at"]
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=dt.timezone.utc)
    if expires < dt.datetime.now(dt.timezone.utc):
        db.delete_session(row["id"])
        return None
    user = db.get_user(row["user_id"])
    if not user:
        return None
    return SessionUser(id=user["id"], email=user["email"], name=user.get("name"))


def current_user(
    response: Response,
    session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> SessionUser:
    """FastAPI dependency: require a valid session, else 401."""
    user = get_user_from_session(session)
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def optional_user(
    session: str | None = Cookie(default=None, alias=SESSION_COOKIE),
) -> SessionUser | None:
    """FastAPI dependency: resolve the session if present, else None (no 401)."""
    return get_user_from_session(session)
