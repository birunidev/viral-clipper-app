"""Authentication primitives: password hashing and session cookies.

Passwords are hashed with Argon2 (argon2-cffi). Sessions are opaque random
tokens stored in the ``sessions`` table and delivered as an httpOnly,
SameSite=Lax cookie named ``clipforge_session``.
"""

from __future__ import annotations

import hashlib
import os
import secrets
from dataclasses import dataclass

import argon2
from argon2.exceptions import VerificationError as ArgonVerificationError

from fastapi import Cookie, HTTPException, Response

from . import db
from .database import session_scope

SESSION_COOKIE = "clipforge_session"
SESSION_DAYS = 30


def hash_token(token: str) -> str:
    """SHA-256 of a session token — the value stored at rest.

    Session tokens are bearer credentials equivalent to passwords; storing
    them hashed means a database read leak cannot be replayed as live
    sessions. Lookup cost is irrelevant (indexed equality on a 64-char hex).
    """
    return hashlib.sha256(token.encode()).hexdigest()

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
    """Persist a session row and return its fields (id, token, expires_at).

    Only the SHA-256 of ``token`` is stored (see :func:`hash_token`); the
    raw token exists solely in the issued cookie.
    """
    import datetime as dt

    now = dt.datetime.now(dt.timezone.utc)
    expires = now + dt.timedelta(days=ttl_days)
    session_id = db.create_session_row(
        user_id=user_id, token=hash_token(token), expires_at=expires
    )
    return {"id": session_id, "token": token, "expires_at": expires}


def revoke_session(session_token: str | None) -> None:
    """Delete the server-side session row for a raw cookie token."""
    if session_token:
        db.delete_session_by_token(hash_token(session_token))


def _cookie_secure_default() -> bool:
    """Secure flag ON unless explicitly disabled via COOKIE_SECURE=0.

    Secure keeps the session cookie off cleartext HTTP. It must default to
    enabled in production (https behind Caddy); local http development opts
    out explicitly.
    """
    raw = os.environ.get("COOKIE_SECURE", "").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return False
    if raw in ("1", "true", "yes", "on"):
        return True
    # Auto: on when the app itself is served over https.
    urls = os.environ.get("FRONTEND_URLS", "")
    return "https://" in urls


def set_session_cookie(response: Response, token: str) -> None:
    # Sets the `Secure` flag so the session cookie is only sent over HTTPS —
    # required in production (Caddy terminates TLS). Auto-enabled whenever
    # FRONTEND_URLS is https; local http dev can force it off with
    # COOKIE_SECURE=0. (OWASP A07/A02: without Secure, the cookie travels in
    # cleartext and session hijack is possible.)
    secure = _cookie_secure_default()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_DAYS * 24 * 3600,
        httponly=True,
        samesite="lax",
        secure=secure,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    # Mirror the Secure flag: with Secure the clear-cookie response is only
    # delivered over HTTPS, so it must itself be Secure or the browser won't
    # process it and the session won't be cleared on logout.
    secure = _cookie_secure_default()
    response.delete_cookie(SESSION_COOKIE, path="/", secure=secure)


def get_user_from_session(session_token: str | None) -> SessionUser | None:
    """Resolve a session token to a user, or None if invalid/expired."""
    if not session_token:
        return None
    row = db.get_session_by_token(hash_token(session_token))
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
