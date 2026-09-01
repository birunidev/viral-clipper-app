"""Credit entitlements, metering, and paywall enforcement.

Billing is credit-based and pay-per-clip (1 credit = 1 minute of source
video). There are no subscriptions or billing periods. A user's usable
limits come from their *entitlement tier* — the highest credit pack they've
ever bought, permanently (or the built-in free tier until first purchase).

Pay-per-clip metering:

- ``credits`` is a prepaid balance on ``users``, granted in one-time packs
  (and a small free allowance at signup).
- Every *managed* analysis job deducts credit equal to its source length
  (ceil to a whole minute) once transcription succeeds — the point of real
  API spend. A job that fails before transcription costs nothing.
- BYOK (bring-your-own-key) is disabled by default (``ENABLE_BYOK=0``): with
  the flag off, every user runs on the operator's keys and pays credits.
  When the flag is on, a user who has supplied any BYOK key is unmetered.

The paywall is "soft throttle": a user over a limit keeps read access but a
write action (new project, upload, start job) raises :class:`PaywallError`
(HTTP 402) with an upgrade hint.
"""

from __future__ import annotations

import os

from app import db
from decimal import ROUND_HALF_UP, Decimal

from app.plans import (
    FREE,
    all_packs,
    all_topups,
    entitlement_tier_key,
    entitlements_for_tier,
    free_credits,
    free_tier,
    is_topup_key,
    pack_for_key,
    purchasable_for_key,
    tier_rank,
    topup_for_key,
)

from core import midtrans as _midtrans


class PaywallError(Exception):
    """Raised when a user hits a limit on a paywalled write action."""

    def __init__(self, msg: str, *, needs_payment: bool = True, limit: str | None = None):
        self.needs_payment = needs_payment
        self.limit = limit
        super().__init__(msg)


def _byok_enabled() -> bool:
    """Whether the BYOK feature is on (opt-in via env; default off)."""
    val = os.environ.get("ENABLE_BYOK")
    if val is None:
        return False
    return val.strip().lower() in ("1", "true", "yes", "on")


def byok_enabled() -> bool:
    """Public alias so the pipeline can decide whether to honor user keys."""
    return _byok_enabled()


# ------------------------------------------------------------------ credits


def credit_balance(user_id: str) -> int:
    """Whole-minute balance.  Reads the denormalized cache column on
    ``users.credits``; the cache is kept in sync by the new ledger
    service (app.services.entitlements.grant_credits / spend_credits).
    """
    user = db.get_user(user_id)
    return int(user.get("credits") or 0) if user else 0


def record_credits(user_id: str, seconds: float, job_id: str | None = None) -> int:
    """Deduct credits for a completed analysis (ceil to a whole minute).

    Returns the number of credits consumed (0 if the job is free/BYOK-less or
    too short to meter). The deduction is routed through the new
    credit-ledger service so ``credit_ledger`` / ``credit_spend`` and the
    ``User.credits`` cache stay consistent. Returns 0 if the wallet
    can't cover the spend (the pipeline doesn't block on this; it
    gracefully degrades the user's balance).
    """
    if seconds <= 0:
        return 0
    # Convert seconds -> deciminutes (1 minute = 10 units), round UP.
    need_dm = max(10, int(-(-int(seconds * 10) // 60)))
    try:
        from app.services.entitlements import spend_credits
        ok = spend_credits(user_id, need_dm, purpose="transcribe", job_id=job_id)
        if not ok:
            return 0
    except Exception:
        # If the ledger service is unavailable (e.g. during a schema
        # migration), don't break the analysis pipeline — the user's
        # cache column will be slightly off until the next ledger write.
        db.increment_user_credits(user_id, -(need_dm // 10))
    return need_dm // 10


def enforce_credits(user_id: str, estimated_seconds: float | None = None) -> None:
    """Soft-throttle starting an analysis when the credit balance is empty."""
    balance = credit_balance(user_id)
    if balance <= 0:
        raise PaywallError(
            "You're out of credits. Top up to keep finding viral clips "
            "(1 credit = 1 minute of video).",
            limit="credits",
        )
    if estimated_seconds:
        need = max(1, int(-(-estimated_seconds // 60)))
        if balance < need:
            raise PaywallError(
                f"This video needs ~{need} minute(s) but you only have "
                f"{balance} credit(s) left. Top up to continue.",
                limit="credits",
            )


def grant_pack(user_id: str, pack_key: str) -> dict | None:
    """Add a pack's credits and permanently raise the entitlement tier.

    Idempotent-ish: re-buying a pack re-adds its credit allowance but never
    *lowers* the tier. Returns the pack, or None if the key is unknown.

    Routes the credit grant through the new ledger service so the
    credit_ledger row + the ``User.credits`` cache stay in sync.
    """
    pack = pack_for_key(pack_key)
    if pack is None:
        return None

    user = db.get_user(user_id) or {}
    current_tier = entitlement_tier_key(
        (user.get("entitlement_tier") or FREE)
    )
    new_tier = pack["key"] if tier_rank(pack["key"]) >= tier_rank(current_tier) else current_tier

    try:
        from app.services.entitlements import grant_credits
        grant_credits(
            user_id=user_id,
            amount_dm=int(pack["credits"]) * 10,
            source="plan",
            plan_key=pack_key,
            note=f"Pack purchase: {pack.get('name') or pack_key}",
        )
    except Exception:
        # Fall back to the legacy denormalized bump if the ledger is unavailable.
        db.increment_user_credits(user_id, int(pack["credits"]))
    db.set_user_billing(
        user_id,
        entitlement_tier=new_tier,
        plan_key=pack_key,
        billing_email=user.get("billing_email"),
    )
    return pack


def grant_topup(user_id: str, topup_key: str) -> dict | None:
    topup = topup_for_key(topup_key)
    if topup is None:
        return None
    user = db.get_user(user_id) or {}
    try:
        from app.services.entitlements import grant_credits
        grant_credits(
            user_id=user_id,
            amount_dm=int(topup["credits"]) * 10,
            source="topup",
            plan_key=topup_key,
            note=f"Top-up: {topup.get('name') or topup_key}",
        )
    except Exception:
        db.increment_user_credits(user_id, int(topup["credits"]))
    db.set_user_billing(
        user_id,
        plan_key=topup_key,
        billing_email=user.get("billing_email"),
    )
    return topup


def grant_credits(user_id: str, key: str) -> dict | None:
    if is_topup_key(key):
        return grant_topup(user_id, key)
    return grant_pack(user_id, key)


# ------------------------------------------------------------ entitlements


def effective_entitlement(user_id: str) -> dict:
    """The user's permanent limits, from the highest tier ever purchased."""
    user = db.get_user(user_id)
    tier = entitlement_tier_key((user or {}).get("entitlement_tier") or FREE)
    return entitlements_for_tier(tier)


def entitlement_tier(user_id: str) -> str:
    return entitlement_tier_key(
        (db.get_user(user_id) or {}).get("entitlement_tier") or FREE
    )


# ------------------------------------------------------------------ storage
# Local storage: all clips/thumbs/source are on-device, no cloud cap.

def storage_cap(user_id: str) -> int:
    return 10 * 1024 * 1024 * 1024 * 1024  # 10TB effectively unlimited


def storage_used(user_id: str) -> int:
    user = db.get_user(user_id)
    return int(user.get("storage_used_bytes") or 0) if user else 0


def storage_remaining(user_id: str) -> int:
    return storage_cap(user_id) - storage_used(user_id)


def enforce_storage(user_id: str, additional_bytes: int) -> None:
    """No-op: storage is on-device, cloud cap disabled."""
    return


def has_storage_room(user_id: str, additional_bytes: int) -> bool:
    return True


# ------------------------------------------------------------------ projects


def project_count(user_id: str) -> int:
    return db.count_projects(user_id)


def enforce_project_cap(user_id: str, *, allow_existing: bool = True) -> None:
    """No-op: projects are on-device, no cap."""
    return


# ------------------------------------------------------------------ render


def render_allowed(user_id: str) -> tuple[bool, int | None, bool]:
    """Unlimited: no resolution/watermark gate — all on-device."""
    return (True, None, False)


# ------------------------------------------------------------------ managed


def uses_managed(user_id: str) -> bool:
    """True when a user's jobs run on the operator's managed API keys.

    With BYOK disabled (the default), every user is managed and pays credits.
    When ``ENABLE_BYOK=1``, a user who supplied any own key is unmetered.
    """
    if not _byok_enabled():
        return True
    row = db.get_user_settings(user_id)
    if not row:
        return True
    has_llm = bool(row.get("llm_api_key"))
    has_aai = bool(row.get("assemblyai_key"))
    return not (has_llm or has_aai)


# ------------------------------------------------------------------ status


def _usd(pack: dict) -> float:
    cents = int(pack.get("price_usd") or 0)
    return float((Decimal(cents) / Decimal(100)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _usd_cents(pack: dict) -> int:
    return int(pack.get("price_usd") or 0)


def _fmt_usd(cents: int) -> str:
    return str((Decimal(cents) / Decimal(100)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def billing_status(user_id: str) -> dict:
    """Credits-only status: unlimited local storage/projects."""
    user = db.get_user(user_id) or {}
    tier = entitlement_tier(user_id)
    entitlement = entitlements_for_tier(tier)
    return {
        "tier": tier,
        "tier_name": entitlement["name"],
        "credits": credit_balance(user_id),
        "byok_enabled": _byok_enabled(),
        "client_render": os.environ.get("CLIENT_RENDER", "1").strip().lower()
        in ("1", "true", "yes", "on"),
        "limits": {
            "storage_cap_bytes": storage_cap(user_id),
            "max_projects": None,
            "max_resolution": None,
            "watermark": False,
        },
        "usage": {
            "storage_used_bytes": storage_used(user_id),
            "storage_remaining_bytes": storage_remaining(user_id),
            "projects": project_count(user_id),
        },
        "packs": [
            {
                "key": p["key"],
                "name": p["name"],
                "credits": p["credits"],
                "price_usd": _usd(p),
                "price_usd_cents": _usd_cents(p),
                "price_idr": p["price_idr"],
                "limits": {
                    "storage_cap_bytes": storage_cap(user_id),
                    "max_projects": None,
                    "max_resolution": None,
                    "watermark": False,
                },
            }
            for p in all_packs()
        ],
        "topups": [
            {
                "key": p["key"],
                "name": p["name"],
                "credits": p["credits"],
                "price_usd": _usd(p),
                "price_usd_cents": _usd_cents(p),
                "price_idr": p["price_idr"],
            }
            for p in all_topups()
        ],
        "midtrans_available": _midtrans.is_configured(),
    }