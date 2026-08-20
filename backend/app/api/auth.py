"""Auth endpoints: register, login, logout, me (session info)."""

from __future__ import annotations

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response

from .. import db
from ..schemas import LoginRequest, RegisterRequest, UserResponse
from ..security import (
    SESSION_COOKIE,
    SessionUser,
    clear_session_cookie,
    create_session,
    current_user,
    hash_password,
    new_session_token,
    set_session_cookie,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=UserResponse, status_code=201)
def register(payload: RegisterRequest, response: Response) -> UserResponse:
    email = payload.email
    if db.get_user_by_email(email) is not None:
        raise HTTPException(status_code=409, detail="Email already registered")

    user = db.create_user(
        email=email,
        password_hash=hash_password(payload.password),
        name=payload.name,
    )

    token = new_session_token()
    create_session(user["id"], token)
    set_session_cookie(response, token)
    return UserResponse(id=user["id"], name=user["name"], email=user["email"])


@router.post("/login", response_model=UserResponse)
def login(payload: LoginRequest, response: Response) -> UserResponse:
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
    user: SessionUser = Depends(current_user),
) -> None:
    """Revoke the current session server-side and clear the cookie."""
    if session_token:
        db.delete_session_by_token(session_token)
    clear_session_cookie(response)


@router.get("/me", response_model=UserResponse)
def me(user: SessionUser = Depends(current_user)) -> UserResponse:
    return UserResponse(id=user.id, name=user.name, email=user.email)
