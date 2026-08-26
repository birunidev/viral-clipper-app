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
from app.plans import (
    FREE,
    all_packs,
    entitlement_tier_key,
    entitlements_for_tier,
    free_credits,
    free_tier,
    pack_for_key,
    tier_rank,
)


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
    user = db.get_user(user_id)
    return int(user.get("credits") or 0) if user else 0


def record_credits(user_id: str, seconds: float) -> int:
    """Deduct credits for a completed analysis (ceil to a whole minute).

    Returns the number of credits consumed (0 if the job is free/BYOK-less or
    too short to meter). The deduction is a plain ceil of ``seconds/60``.
    """
    if seconds <= 0:
        return 0
    need = max(1, int(-(-seconds // 60)))
    db.increment_user_credits(user_id, -need)
    return need


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
    """
    pack = pack_for_key(pack_key)
    if pack is None:
        return None

    user = db.get_user(user_id) or {}
    current_tier = entitlement_tier_key(
        (user.get("entitlement_tier") or FREE)
    )
    new_tier = pack["key"] if tier_rank(pack["key"]) >= tier_rank(current_tier) else current_tier

    db.set_user_billing(
        user_id,
        credits=int((user.get("credits") or 0)) + int(pack["credits"]),
        entitlement_tier=new_tier,
        plan_key=pack_key,
        billing_email=user.get("billing_email"),
    )
    return pack


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


def storage_cap(user_id: str) -> int:
    return int(effective_entitlement(user_id)["storage_cap_bytes"])


def storage_used(user_id: str) -> int:
    user = db.get_user(user_id)
    return int(user.get("storage_used_bytes") or 0) if user else 0


def storage_remaining(user_id: str) -> int:
    return max(0, storage_cap(user_id) - storage_used(user_id))


def enforce_storage(user_id: str, additional_bytes: int) -> None:
    """Raise PaywallError if adding ``additional_bytes`` exceeds the cap."""
    if additional_bytes <= 0:
        return
    used = storage_used(user_id)
    cap = storage_cap(user_id)
    if used + additional_bytes > cap:
        raise PaywallError(
            f"Storage limit reached ({used} of {cap} bytes used). Delete a "
            "project or buy a bigger credit pack to free up space.",
            limit="storage",
        )


def has_storage_room(user_id: str, additional_bytes: int) -> bool:
    if additional_bytes <= 0:
        return True
    return storage_used(user_id) + additional_bytes <= storage_cap(user_id)


# ------------------------------------------------------------------ projects


def project_count(user_id: str) -> int:
    return db.count_projects(user_id)


def enforce_project_cap(user_id: str, *, allow_existing: bool = True) -> None:
    """Soft-throttle project creation at the tier's project cap.

    Read access to existing projects is never blocked; only creation is.
    ``allow_existing`` is retained for API ergonomics.
    """
    entitlement = effective_entitlement(user_id)
    cap = entitlement.get("max_projects")
    if cap is None:
        return
    if project_count(user_id) >= cap:
        raise PaywallError(
            f"You've reached the {entitlement['name']} tier's limit of "
            f"{cap} project(s). Buy a bigger credit pack to create more.",
            limit="projects",
        )


# ------------------------------------------------------------------ render


def render_allowed(user_id: str) -> tuple[bool, int | None, bool]:
    """Return (allowed, max_resolution|None, watermark) for the user's tier.

    Rendering is always allowed (it's the core feature); the tier only
    constrains resolution and whether a brand watermark is stamped.
    """
    entitlement = effective_entitlement(user_id)
    return (
        True,
        entitlement.get("max_resolution"),
        bool(entitlement.get("watermark")),
    )


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
    # price_usd is stored in whole cents; expose dollars for display.
    return int(pack.get("price_usd") or 0) / 100.0


def billing_status(user_id: str) -> dict:
    """The user's full entitlement + usage summary for /billing/status."""
    user = db.get_user(user_id) or {}
    tier = entitlement_tier(user_id)
    entitlement = entitlements_for_tier(tier)
    base = free_tier()
    # Project the tier's limits onto a status payload the UI already knows.
    limit_keys = (
        "storage_cap_bytes",
        "max_projects",
        "max_resolution",
        "watermark",
    )
    return {
        "tier": tier,
        "tier_name": entitlement["name"],
        "credits": credit_balance(user_id),
        "byok_enabled": _byok_enabled(),
        "limits": {
            k: entitlement.get(k, base.get(k)) for k in limit_keys
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
                "price_idr": p["price_idr"],
                "limits": {k: p.get(k) for k in limit_keys},
            }
            for p in all_packs()
        ],
    }