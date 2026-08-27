"""Credit packs & entitlement tiers for the ClipForge pay-per-clip model.

Billing is entirely credit-based: **1 credit = 1 minute of source video**
transcribed+analyzed by the operator's keys. There are no subscriptions,
recurring plans, or billing periods; users buy one-time credit packs and are
metred by prepaid credit balance.

Each pack bundles a credit allowance with a permanent entitlement tier. The
**highest tier ever purchased** wins forever (entitlements never expire or
reset) — a user who buys Creator then Studio keeps Studio limits even after
the credits are spent. The built-in ``free`` tier applies until the first
purchase and grants a small one-time credit allowance at signup.

Field meaning (per pack / tier):

- ``credits`` — source-minutes included in the pack.
- ``storage_cap_bytes`` — the user's S3 quota.
- ``max_projects`` — maximum concurrent projects (``None`` = unlimited).
- ``max_resolution`` — tallest export dimension allowed (``None`` = source).
- ``watermark`` — whether rendered clips get the brand watermark.
- ``price_usd`` / ``price_idr`` — one-time pack prices.

All values are env-tunable (``<PACK>_*`` and ``BASE_*`` / ``FREE_CREDITS``),
so launch packs/prices never require a code change.
"""

from __future__ import annotations

import os

FREE = "free"
STARTER = "starter"
CREATOR = "creator"
STUDIO = "studio"

# Ascending entitlement rank; buying a pack with a higher rank upgrades the
# user's permanent tier.
TIER_ORDER = [FREE, STARTER, CREATOR, STUDIO]


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


def _bool_env(name: str, default: bool) -> bool:
    val = os.environ.get(name)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


def _mb(mb: int) -> int:
    return mb * 1024 * 1024


def free_tier() -> dict:
    """The built-in tier every new user starts on (env-tunable BASE_*)."""
    return {
        "key": FREE,
        "name": "Free",
        "storage_cap_bytes": _mb(_int_env("BASE_STORAGE_MB", 500)),
        "max_projects": _int_env("BASE_MAX_PROJECTS", 3),
        "max_resolution": _int_env("BASE_MAX_RESOLUTION", 720),
        "watermark": _bool_env("BASE_WATERMARK", True),
    }


def free_credits() -> int:
    """One-time credit grant at signup (whole source-minutes). No expiry."""
    return max(0, _int_env("FREE_CREDITS", 100))


TOPUP_10 = "topup_10"
TOPUP_30 = "topup_30"
TOPUP_60 = "topup_60"
TOPUP_120 = "topup_120"
TOPUP_KEYS = [TOPUP_10, TOPUP_30, TOPUP_60, TOPUP_120]

# Paid packs: key -> entitlements + credit allowance + one-time prices.
_BUILTIN_PACKS = {
    STARTER: {
        "key": STARTER,
        "name": "Starter",
        "credits": _int_env("STARTER_CREDITS", 60),
        "storage_cap_bytes": _mb(_int_env("STARTER_STORAGE_MB", 1024)),
        "max_projects": _int_env("STARTER_MAX_PROJECTS", 10),
        "max_resolution": _int_env("STARTER_MAX_RESOLUTION", 1080),
        "watermark": _bool_env("STARTER_WATERMARK", False),
        "price_usd": _int_env("STARTER_PRICE_USD", 290),
        "price_idr": _int_env("STARTER_PRICE_IDR", 29_000),
    },
    CREATOR: {
        "key": CREATOR,
        "name": "Creator",
        "credits": _int_env("CREATOR_CREDITS", 300),
        "storage_cap_bytes": _mb(_int_env("CREATOR_STORAGE_MB", 5120)),
        "max_projects": None,
        "max_resolution": _int_env("CREATOR_MAX_RESOLUTION", 1080),
        "watermark": _bool_env("CREATOR_WATERMARK", False),
        "price_usd": _int_env("CREATOR_PRICE_USD", 1290),
        "price_idr": _int_env("CREATOR_PRICE_IDR", 129_000),
    },
    STUDIO: {
        "key": STUDIO,
        "name": "Studio",
        "credits": _int_env("STUDIO_CREDITS", 1200),
        "storage_cap_bytes": _mb(_int_env("STUDIO_STORAGE_MB", 20480)),
        "max_projects": None,
        "max_resolution": _int_env("STUDIO_MAX_RESOLUTION", 2160),
        "watermark": _bool_env("STUDIO_WATERMARK", False),
        "price_usd": _int_env("STUDIO_PRICE_USD", 3900),
        "price_idr": _int_env("STUDIO_PRICE_IDR", 399_000),
    },
}

# Minute-only top-ups: credits only, no entitlement change (pay-as-you-go).
_TOPUP_PACKS = {
    TOPUP_10: {
        "key": TOPUP_10,
        "name": "Top-up 10 Minutes",
        "credits": _int_env("TOPUP_10_CREDITS", 10),
        "price_usd": _int_env("TOPUP_10_PRICE_USD", 99),
        "price_idr": _int_env("TOPUP_10_PRICE_IDR", 16_000),
    },
    TOPUP_30: {
        "key": TOPUP_30,
        "name": "Top-up 30 Minutes",
        "credits": _int_env("TOPUP_30_CREDITS", 30),
        "price_usd": _int_env("TOPUP_30_PRICE_USD", 199),
        "price_idr": _int_env("TOPUP_30_PRICE_IDR", 32_000),
    },
    TOPUP_60: {
        "key": TOPUP_60,
        "name": "Top-up 60 Minutes",
        "credits": _int_env("TOPUP_60_CREDITS", 60),
        "price_usd": _int_env("TOPUP_60_PRICE_USD", 349),
        "price_idr": _int_env("TOPUP_60_PRICE_IDR", 55_000),
    },
    TOPUP_120: {
        "key": TOPUP_120,
        "name": "Top-up 120 Minutes",
        "credits": _int_env("TOPUP_120_CREDITS", 120),
        "price_usd": _int_env("TOPUP_120_PRICE_USD", 599),
        "price_idr": _int_env("TOPUP_120_PRICE_IDR", 95_000),
    },
}

# Paddle price id -> pack/topup key. Populated at import from env so launch-time
# mapping needs no code changes; the free tier is never purchasable.
_PRICE_TO_PACK: dict[str, str] = {}


def register_price(price_id: str, pack_key: str) -> None:
    """Map a Paddle price id to a built-in pack or top-up key."""
    if price_id and (pack_key in _BUILTIN_PACKS or pack_key in _TOPUP_PACKS):
        _PRICE_TO_PACK[price_id] = pack_key


def _load_price_map() -> None:
    for key in list(_BUILTIN_PACKS.keys()) + list(_TOPUP_PACKS.keys()):
        price = os.environ.get(f"PADDLE_PRICE_{key.upper()}", "").strip()
        if price:
            register_price(price, key)


_load_price_map()


def pack_for_key(pack_key: str | None) -> dict | None:
    if not pack_key:
        return None
    return _BUILTIN_PACKS.get(pack_key)


def pack_for_price(price_id: str | None) -> dict | None:
    if not price_id:
        return None
    key = _PRICE_TO_PACK.get(price_id)
    if not key:
        return None
    return _BUILTIN_PACKS.get(key) or _TOPUP_PACKS.get(key)


def price_for_pack_key(pack_key: str) -> str | None:
    if pack_key not in _BUILTIN_PACKS and pack_key not in _TOPUP_PACKS:
        return None
    return os.environ.get(f"PADDLE_PRICE_{pack_key.upper()}", "").strip() or None


def all_packs() -> list[dict]:
    return list(_BUILTIN_PACKS.values())


def topup_for_key(topup_key: str | None) -> dict | None:
    if not topup_key:
        return None
    return _TOPUP_PACKS.get(topup_key)


def topup_for_price(price_id: str | None) -> dict | None:
    if not price_id:
        return None
    key = _PRICE_TO_PACK.get(price_id)
    return _TOPUP_PACKS.get(key) if key else None


def price_for_topup_key(topup_key: str) -> str | None:
    return price_for_pack_key(topup_key)


def all_topups() -> list[dict]:
    return list(_TOPUP_PACKS.values())


def purchasable_for_key(key: str | None) -> dict | None:
    if not key:
        return None
    return _BUILTIN_PACKS.get(key) or _TOPUP_PACKS.get(key)


def is_topup_key(key: str | None) -> bool:
    return key in _TOPUP_PACKS


def tier_entries() -> list[dict]:
    """Every purchasable tier (free + paid packs) for pricing/status UI."""
    return [free_tier(), *all_packs()]


def entitlement_tier_key(value: str) -> str:
    """Normalize a stored tier key, falling back to ``free`` for unknowns."""
    return value if value in TIER_ORDER else FREE


def entitlements_for_tier(tier_key: str) -> dict:
    """The limits for a permanent entitlement tier (free or worst-or-better)."""
    key = entitlement_tier_key(tier_key)
    if key == FREE:
        return free_tier()
    pack = _BUILTIN_PACKS[key]
    return {
        "key": pack["key"],
        "name": pack["name"],
        "storage_cap_bytes": pack["storage_cap_bytes"],
        "max_projects": pack["max_projects"],
        "max_resolution": pack["max_resolution"],
        "watermark": pack["watermark"],
    }


def tier_rank(tier_key: str) -> int:
    return TIER_ORDER.index(entitlement_tier_key(tier_key))