"""Auth endpoints: register, login, logout, me (session info)."""

from __future__ import annotations

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from sqlalchemy.exc import IntegrityError

from .. import db
from ..ratelimit import RateLimitExceeded, limiter
from ..schemas import LoginRequest, RegisterRequest, UserResponse
from ..security import (
    SESSION_COOKIE,
    SessionUser,
    clear_session_cookie,
    create_session,
    current_user,
    hash_password,
    new_session_token,
    optional_user,
    revoke_session,
    set_session_cookie,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])

# Online-guessing / spam guards (OWASP A07). Keyed by IP+identifier so one
# attacker can't lock out a victim's account outright, and a NAT'd office
# isn't collectively throttled by a single global bucket.
LOGIN_LIMIT = 10  # attempts per 5 minutes per ip+email
REGISTER_LIMIT = 5  # registrations per hour per IP


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


@router.post("/register", response_model=UserResponse, status_code=201)
def register(
    payload: RegisterRequest, request: Request, response: Response
) -> UserResponse:
    try:
        limiter.check(f"register:{_client_ip(request)}", REGISTER_LIMIT, 3600)
    except RateLimitExceeded:
        raise HTTPException(status_code=429, detail="Too many signups. Try again later.")

    email = payload.email
    if db.get_user_by_email(email) is not None:
        raise HTTPException(status_code=409, detail="Email already registered")

    try:
        user = db.create_user(
            email=email,
            password_hash=hash_password(payload.password),
            name=payload.name,
        )
    except IntegrityError:
        # Concurrent registration for the same email raced past the
        # pre-check above; the unique constraint is authoritative.
        raise HTTPException(status_code=409, detail="Email already registered")

    token = new_session_token()
    create_session(user["id"], token)
    set_session_cookie(response, token)
    return UserResponse(id=user["id"], name=user["name"], email=user["email"])


@router.post("/login", response_model=UserResponse)
def login(
    payload: LoginRequest, request: Request, response: Response
) -> UserResponse:
    try:
        limiter.check(
            f"login:{_client_ip(request)}:{payload.email.strip().lower()}",
            LOGIN_LIMIT,
            300,
        )
    except RateLimitExceeded:
        raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")

    user = db.get_user_by_email(payload.email)
    if user is None or not verify_password(payload.password, user.get("password_hash")):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    token = new_session_token()
    create_session(user["id"], token)
    set_session_cookie(response, token)
    return UserResponse(id=user["id"], name=user["name"], email=user["email"])


@router.post("/logout", status_code=204, response_model=None)
def logout(
    response: Response,
    session_token: str = Cookie(default=None, alias=SESSION_COOKIE),
    user: SessionUser | None = Depends(optional_user),
) -> None:
    """Revoke the current session server-side and clear the cookie.

    Uses ``optional_user`` so the cookie is ALWAYS cleared — even when the
    session is already expired/unknown (otherwise a stale cookie would keep
    riding along on every request).
    """
    revoke_session(session_token)
    clear_session_cookie(response)


@router.get("/me", response_model=UserResponse)
def me(user: SessionUser = Depends(current_user)) -> UserResponse:
    return UserResponse(id=user.id, name=user.name, email=user.email)
