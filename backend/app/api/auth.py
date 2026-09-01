"""Auth endpoints: register, login, logout, me (session info), and the
email magic-link password-reset flow."""

from __future__ import annotations

import datetime as dt
import hashlib
import os
import secrets
import uuid

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .. import db
from ..ratelimit import RateLimitExceeded, limiter
from ..schemas import (
    LoginRequest,
    PasswordResetConfirm,
    PasswordResetRequest,
    PasswordResetResponse,
    RegisterRequest,
    UserResponse,
)
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
    # In DEBUG mode (local dev / smoke tests) the rate limit is a nuisance.
    if not os.environ.get("DEBUG", "").strip().lower() in ("1", "true", "yes", "on"):
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
            terms_accepted_at=dt.datetime.now(dt.timezone.utc),
        )
    except IntegrityError:
        # Concurrent registration for the same email raced past the
        # pre-check above; the unique constraint is authoritative.
        raise HTTPException(status_code=409, detail="Email already registered")

    token = new_session_token()
    create_session(user["id"], token)
    set_session_cookie(response, token)
    # Auto-license: every new account gets a permanent desktop license (max 3 devices)
    # and keeps the 100 free credits from create_user (FREE_CREDITS). No tier promotion.
    try:
        from ..services.entitlements import grant_license_for_user

        grant_license_for_user(user["id"], tier="unlimited", max_devices=3)
    except Exception:
        pass
    return UserResponse(
        id=user["id"],
        name=user["name"],
        email=user["email"],
        terms_accepted_at=user.get("terms_accepted_at"),
        has_license=True,
        license_tier="unlimited",
        credits=int(user.get("credits") or 0),
        current_device_count=0,
        max_devices=3,
    )


@router.post("/login", response_model=UserResponse)
def login(
    payload: LoginRequest, request: Request, response: Response
) -> UserResponse:
    if not os.environ.get("DEBUG", "").strip().lower() in ("1", "true", "yes", "on"):
        try:
            limiter.check(
                f"login:{_client_ip(request)}:{payload.email.strip().lower()}",
                LOGIN_LIMIT,
                300,
            )
        except RateLimitExceeded:
            raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")

    user = db.get_user_by_email(payload.email)
    if user is None:
        # Timing-attack mitigation: dummy Argon verify so non-existent vs wrong-password have same latency
        verify_password(payload.password, _DUMMY_HASH)
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not verify_password(payload.password, user.get("password_hash")):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    token = new_session_token()
    create_session(user["id"], token)
    set_session_cookie(response, token)
    return UserResponse(
        id=user["id"],
        name=user["name"],
        email=user["email"],
        terms_accepted_at=user.get("terms_accepted_at"),
    )


@router.post("/accept-terms", response_model=UserResponse)
def accept_terms(
    user: SessionUser = Depends(current_user),
) -> UserResponse:
    """Record consent to the Terms of Service and Privacy Policy.

    Idempotent: accepting twice keeps the original timestamp. Lets
    pre-existing accounts (created before the consent gate shipped) opt in
    without re-registering.
    """
    db.accept_user_terms(user.id)
    refreshed = db.get_user(user.id)
    return UserResponse(
        id=refreshed["id"],
        name=refreshed["name"],
        email=refreshed["email"],
        terms_accepted_at=refreshed.get("terms_accepted_at"),
    )


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
    """Return the current session user + license / device summary.

    Single round-trip so the web sidebar can render Profile/Licenses/Billing
    badges without a second request.
    """
    from sqlalchemy import select

    from ..database import session_scope
    from ..models import DeviceActivation, Entitlement

    with session_scope() as session:
        ent = session.execute(
            select(Entitlement).where(
                Entitlement.user_id == user.id, Entitlement.is_active == True  # noqa: E712
            ).order_by(Entitlement.created_at.desc()).limit(1)
        ).scalars().first()
        active_devices = session.execute(
            select(DeviceActivation).where(
                DeviceActivation.user_id == user.id,
                DeviceActivation.is_revoked == False,  # noqa: E712
            )
        ).scalars().all()
        # Directly read credits from User row — matches billing_status credit_balance
        from ..models import User as _User

        urow = session.get(_User, user.id)
        credits = int(getattr(urow, "credits", 0) or 0) if urow else 0
    return UserResponse(
        id=user.id,
        name=user.name,
        email=user.email,
        terms_accepted_at=user.terms_accepted_at,
        has_license=ent is not None,
        license_tier=(ent.tier if ent else None),
        credits=credits,
        current_device_count=len(active_devices),
        max_devices=(int(ent.max_devices) if ent else 0),
    )


# ------------------------------------------------------------ magic link

PASSWORD_RESET_LIMIT_PER_EMAIL = 5   # /hour
PASSWORD_RESET_LIMIT_PER_IP = 20     # /hour
PASSWORD_RESET_TOKEN_TTL_HOURS = 1
PASSWORD_RESET_TOKEN_BYTES = 32


# Dummy hash for timing-attack mitigation on login enumeration
_DUMMY_HASH = hash_password("dummy-password-for-timing-mitigation-32chars!!")

def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _is_debug() -> bool:
    raw = os.environ.get("DEBUG", "").strip().lower()
    return raw in ("1", "true", "yes", "on")


@router.post("/password/reset-request", response_model=PasswordResetResponse, status_code=202)
async def password_reset_request(payload: PasswordResetRequest, request: Request) -> PasswordResetResponse:
    """Email a one-time password-reset link.

    Always returns 202 with ``ok=true`` regardless of whether the email
    matches an account (no email enumeration).  The token is single-use
    and expires in 1h.  In dev (``DEBUG=1``) the response is augmented
    with ``dev_reset_link`` so the smoke script can complete the flow
    without an SMTP server.
    """
    email = payload.email.strip().lower()
    ip = request.client.host if request.client else "unknown"
    # Per-email + per-IP rate limits (5/h per email, 20/h per IP).
    try:
        limiter.check(f"pwreset:email:{email}", PASSWORD_RESET_LIMIT_PER_EMAIL, 3600)
    except RateLimitExceeded:
        return PasswordResetResponse(ok=True)
    try:
        limiter.check(f"pwreset:ip:{ip}", PASSWORD_RESET_LIMIT_PER_IP, 3600)
    except RateLimitExceeded:
        return PasswordResetResponse(ok=True)

    from core import mailer
    from ..database import session_scope
    from ..models import PasswordResetToken, User

    user_id: str | None = None
    raw_token: str | None = None
    with session_scope() as session:
        user = session.execute(
            select(User).where(User.email == email)
        ).scalars().first()
        if user is not None:
            user_id = user.id
            raw_token = secrets.token_urlsafe(PASSWORD_RESET_TOKEN_BYTES)
            now = dt.datetime.now(dt.timezone.utc)
            session.add(
                PasswordResetToken(
                    id=uuid.uuid4().hex,
                    user_id=user_id,
                    token_hash=_hash_token(raw_token),
                    expires_at=now + dt.timedelta(hours=PASSWORD_RESET_TOKEN_TTL_HOURS),
                    ip_address=ip,
                    user_agent=request.headers.get("user-agent"),
                )
            )

    if user_id is not None and raw_token is not None:
        link = f"{mailer.site_url()}/app/reset-password?token={raw_token}"
        await mailer.send(
            to=email,
            subject="Reset your ClipZard password",
            text=(
                f"Hi,\n\n"
                f"Click the link below to reset your ClipZard password. "
                f"It expires in {PASSWORD_RESET_TOKEN_TTL_HOURS} hour and can be used once.\n\n"
                f"{link}\n\n"
                f"If you didn't request this, you can ignore this email.\n\n"
                f"— ClipZard"
            ),
        )
    return PasswordResetResponse(ok=True)


@router.post("/password/reset-confirm", response_model=PasswordResetResponse)
def password_reset_confirm(payload: PasswordResetConfirm) -> PasswordResetResponse:
    """Redeem a single-use reset token.  Returns 400 if the token is
    missing/expired/already-used. Uses atomic UPDATE to prevent double-use race."""
    raw = (payload.token or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="invalid")
    from sqlalchemy import select, update

    from ..database import session_scope
    from ..models import PasswordResetToken, User
    from ..security import hash_password

    h = _hash_token(raw)
    now = dt.datetime.now(dt.timezone.utc)
    with session_scope() as session:
        # Atomic claim: only one concurrent request can set used_at from NULL
        result = session.execute(
            update(PasswordResetToken)
            .where(
                PasswordResetToken.token_hash == h,
                PasswordResetToken.used_at.is_(None),
                PasswordResetToken.expires_at > now,
            )
            .values(used_at=now)
        )
        if result.rowcount == 1:
            row = session.execute(
                select(PasswordResetToken).where(PasswordResetToken.token_hash == h)
            ).scalars().first()
            user = session.execute(
                select(User).where(User.id == row.user_id)
            ).scalars().first()
            if user is None:
                raise HTTPException(status_code=400, detail="invalid")
            user.password_hash = hash_password(payload.new_password)
            return PasswordResetResponse(ok=True)
        # No row claimed — determine why for proper error
        row = session.execute(
            select(PasswordResetToken).where(PasswordResetToken.token_hash == h)
        ).scalars().first()
        if row is None:
            raise HTTPException(status_code=400, detail="invalid")
        if row.used_at is not None:
            raise HTTPException(status_code=400, detail="already_used")
        if row.expires_at < now:
            raise HTTPException(status_code=400, detail="expired")
        raise HTTPException(status_code=400, detail="invalid")
