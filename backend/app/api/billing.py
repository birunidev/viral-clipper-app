"""Billing endpoints + payment-gateway webhooks (Paddle global, Midtrans ID).

Credit-based, pay-per-clip model — there are no subscriptions or billing
periods. Provides:

- ``GET  /billing/status``   — credit balance, permanent tier, usage & packs
- ``POST /billing/checkout`` — but a one-time credit pack; routed by timezone:
  Paddle Billing (global, hosted-checkout URL) or Midtrans Snap (Indonesia,
  token for snap.js)
- ``POST /billing/packs``    — alias of ``/billing/checkout`` (semantic)
- ``POST /webhooks/paddle``  — Paddle Billing webhook receiver (HMAC-verified)
- ``POST /webhooks/midtrans``— Midtrans HTTP notification receiver

Checkout carries ``custom_data.user_id`` so purchase webhooks can map a pack
back to our user; the settlement then adds credits and permanently raises the
entitlement tier (never a period-based subscription).

Paddle Billing API specifics (developer.paddle.com): webhooks are signed with
an HMAC-SHA256 hex digest over ``{ts}:{raw_body}`` keyed by the notification
destination's secret, delivered in the ``Paddle-Signature`` header
(``ts=<unix>;h1=<hex>``).
"""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import logging
import os
import time
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

import requests
from fastapi import APIRouter, Depends, HTTPException, Request

from .. import db
from ..schemas import CheckoutRequest, CheckoutResponse
from ..security import SessionUser, current_user
from app.plans import (
    is_topup_key,
    pack_for_key,
    pack_for_price,
    price_for_pack_key,
    purchasable_for_key,
    topup_for_key,
)
from core import billing, midtrans

logger = logging.getLogger(__name__)

router = APIRouter(tags=["billing"])
# Webhook receivers are unauthenticated-by-design (gateway-signed instead),
# so they live on their own router for clarity in main.py.
hooks_router = APIRouter(tags=["billing"])

# Sandbox unless explicitly pointed at production.
def paddle_base_url() -> str:
    if os.environ.get("PADDLE_ENV", "").strip().lower() == "production":
        return "https://api.paddle.com"
    return "https://sandbox-api.paddle.com"


def _paddle_headers() -> dict[str, str]:
    key = os.environ.get("PADDLE_API_KEY", "").strip()
    if not key:
        raise HTTPException(status_code=503, detail="Billing API key is not configured.")
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


# ------------------------------------------------------------------ status


@router.get("/billing/status", response_model=dict)
def billing_status(user: SessionUser = Depends(current_user)) -> dict:
    return billing.billing_status(user.id)


@router.get("/billing/transactions", response_model=list[dict])
def list_transactions(user: SessionUser = Depends(current_user)) -> list[dict]:
    orders = db.list_payment_orders(user.id, limit=50)
    out: list[dict] = []
    for o in orders:
        pack = purchasable_for_key(o.get("plan_key")) or {}
        out.append({
            "order_id": o.get("order_id"),
            "plan_key": o.get("plan_key"),
            "plan_name": pack.get("name") or o.get("plan_key"),
            "credits": pack.get("credits") or 0,
            "provider": o.get("provider"),
            "gross_amount": o.get("gross_amount"),
            "currency": o.get("currency"),
            "status": o.get("status"),
            "created_at": (o.get("created_at").isoformat() if o.get("created_at") else None),
        })
    return out


# ---------------------------------------------------------------- checkout

# IANA zones covering Indonesian time (WIB/WITA/WIT). A browser reporting one
# of these is routed to the Midtrans gateway; everyone else gets Paddle.
INDONESIA_TIMEZONES = {
    "Asia/Jakarta",
    "Asia/Pontianak",
    "Asia/Makassar",
    "Asia/Jayapura",
}


def provider_for(timezone: str | None, *, forced: str | None = None) -> str:
    """Pick the payment gateway for a user (Midtrans only when configured).

    ``forced`` (``paddle`` | ``midtrans``) is an explicit user override from
    the checkout UI — it wins over the timezone heuristic so an Indonesian
    user whose browser reports a non-ID zone can still choose QRIS/GoPay.
    """
    f = (forced or "").strip().lower()
    if f in ("midtrans", "paddle"):
        if f == "midtrans" and not midtrans.is_configured():
            logger.warning("Forced midtrans but gateway not configured; falling back to paddle")
            return "paddle"
        logger.info("Checkout provider forced=%s (tz=%r, midtrans_configured=%s)", f, timezone, midtrans.is_configured())
        return f
    tz = (timezone or "").strip()
    provider = "midtrans" if tz in INDONESIA_TIMEZONES and midtrans.is_configured() else "paddle"
    logger.info("Checkout provider auto=%s (tz=%r, forced=%r, midtrans_configured=%s)", provider, tz, f, midtrans.is_configured())
    return provider


def _checkout_paddle(user: SessionUser, pack_key: str) -> CheckoutResponse:
    """Create a Paddle Billing one-time transaction for a credit pack or top-up.

    Supports two modes per item: catalog ``price_id`` if ``PADDLE_PRICE_<KEY>``
    is configured, otherwise a non-catalog custom price built from the pack's
    ``price_usd`` — no price ids needed. ``custom_data.user_id`` rides on the
    transaction so the settlement webhook can map the purchase back to the buyer.
    """
    pack = purchasable_for_key(pack_key)
    if pack is None:
        raise HTTPException(status_code=400, detail=f"Unknown pack: {pack_key!r}")
    price_id = price_for_pack_key(pack_key)
    if price_id:
        items = [{"quantity": 1, "price_id": price_id}]
    else:
        amount = str(int(pack.get("price_usd") or 0))
        if int(amount) <= 0:
            raise HTTPException(status_code=503, detail=f"Price for {pack_key!r} is not configured.")
        product_id = os.environ.get("PADDLE_PRODUCT_ID", "").strip()
        if product_id:
            price_obj = {
                "description": f"ClipForge {pack['name']} — {pack['credits']} min",
                "name": pack["name"],
                "billing_cycle": None,
                "unit_price": {"amount": amount, "currency_code": "USD"},
                "product_id": product_id,
            }
        else:
            price_obj = {
                "description": f"ClipForge {pack['name']} — {pack['credits']} min",
                "name": pack["name"],
                "billing_cycle": None,
                "unit_price": {"amount": amount, "currency_code": "USD"},
                "product": {"name": "ClipForge Credits", "description": "Pay-as-you-go credits", "tax_category": "standard"},
            }
        items = [{"quantity": 1, "price": price_obj}]

    # Create audit order for Paddle too so transaction history is unified
    paddle_order_id = f"PDL-{user.id[:8]}-{pack_key}-{int(time.time() * 1000)}"
    try:
        db.create_payment_order(
            user_id=user.id,
            provider="paddle",
            order_id=paddle_order_id,
            plan_key=pack_key,
            gross_amount=int(pack.get("price_usd") or 0),
            currency="USD",
        )
    except Exception:
        pass

    body = {
        "items": items,
        "collection_mode": "automatic",
        "custom_data": {"user_id": user.id, "pack": pack_key, "order_id": paddle_order_id},
    }

    try:
        resp = requests.post(
            f"{paddle_base_url()}/transactions",
            headers=_paddle_headers(),
            json=body,
            timeout=30,
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail="Could not reach billing provider.") from exc

    if resp.status_code >= 400:
        raise HTTPException(
            status_code=502, detail=f"Paddle checkout failed: {resp.text[:200]}"
        )
    try:
        data = resp.json()["data"]
        url = (data.get("checkout") or {}).get("url")
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="Unexpected billing response.") from exc
    if not url:
        raise HTTPException(
            status_code=502,
            detail="Paddle returned no checkout URL. Set a default payment link in your Paddle dashboard.",
        )
    return CheckoutResponse(provider="paddle", url=url)


def _checkout_midtrans(user: SessionUser, pack_key: str) -> CheckoutResponse:
    """Create a Midtrans Snap one-time transaction (credit pack or top-up, IDR).

    The order is recorded BEFORE calling Midtrans with the exact amount we
    quoted, so the settlement webhook can verify the paid amount against
    ground truth instead of trusting the notification.
    """
    pack = purchasable_for_key(pack_key)
    if pack is None:
        raise HTTPException(status_code=400, detail=f"Unknown pack: {pack_key!r}")

    gross_amount = int(pack.get("price_idr") or 0)
    if gross_amount <= 0:
        raise HTTPException(
            status_code=503,
            detail=f"IDR price for pack {pack_key!r} is not configured.",
        )

    redirect_base = os.environ.get("FRONTEND_URL", "") or os.environ.get(
        "NEXT_PUBLIC_APP_URL", "http://localhost:3000"
    )
    order_id = f"CF-{user.id[:8]}-{pack_key}-{int(time.time() * 1000)}"
    db.create_payment_order(
        user_id=user.id,
        provider="midtrans",
        order_id=order_id,
        plan_key=pack_key,
        gross_amount=gross_amount,
        currency="IDR",
    )

    try:
        result = midtrans.create_snap_transaction(
            order_id=order_id,
            gross_amount=gross_amount,
            plan_name=f"SnapClip {pack['name']} pack",
            plan_key=pack_key,
            user_id=user.id,
            user_email=user.email,
            user_name=user.name,
            finish_url=f"{redirect_base}/app/billing",
        )
    except midtrans.MidtransError as exc:
        logger.warning("Midtrans checkout failed for user %s: %s", user.id, exc)
        raise HTTPException(status_code=502, detail="Could not reach payment provider.") from exc

    return CheckoutResponse(
        provider="midtrans",
        token=result["token"],
        client_key=midtrans.client_key(),
        snap_js_url=midtrans.snap_js_url(),
    )


@router.post("/billing/checkout", response_model=CheckoutResponse)
def create_checkout(
    payload: CheckoutRequest, user: SessionUser = Depends(current_user)
) -> CheckoutResponse:
    if purchasable_for_key(payload.plan_key) is None:
        raise HTTPException(status_code=400, detail=f"Unknown pack: {payload.plan_key!r}")
    provider = provider_for(payload.timezone, forced=payload.provider)
    if provider == "midtrans":
        return _checkout_midtrans(user, payload.plan_key)
    return _checkout_paddle(user, payload.plan_key)


# ------------------------------------------------------------------ webhook


# Replay window for the Paddle-Signature timestamp.
PADDLE_TS_TOLERANCE_SECONDS = 600


def _verify_paddle_signature(raw_body: bytes, header: str | None) -> bool:
    secret = os.environ.get("PADDLE_WEBHOOK_SECRET", "").strip()
    if not secret or not header:
        return False

    ts: str | None = None
    signatures: list[str] = []
    for part in header.split(";"):
        if part.startswith("ts="):
            ts = part[3:]
        elif part.startswith("h1="):
            signatures.append(part[3:])
    if not ts or not signatures:
        return False

    try:
        sent_at = int(ts)
    except ValueError:
        return False
    now = int(dt.datetime.now(dt.timezone.utc).timestamp())
    if abs(now - sent_at) > PADDLE_TS_TOLERANCE_SECONDS:
        return False

    signed_payload = f"{ts}:".encode() + raw_body
    expected = hmac.new(secret.encode(), signed_payload, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, sig) for sig in signatures)


def _find_user(custom_data: dict | None) -> dict | None:
    """Match a Paddle webhook to our user via custom data (user_id)."""
    uid = (custom_data or {}).get("user_id")
    if uid:
        user = db.get_user(str(uid))
        if user:
            return user
    return None


def _grant_paddle_pack(user_id: str, data: dict, event_type: str) -> None:
    """Grant credits for a paid Paddle transaction.

    The pack is resolved from ``custom_data.pack`` (our own token), falling
    back to the transaction price mapping. Two integrity checks guard it:

    - Price binding: when catalog price ids are used, every id must map to
      the SAME pack as ``custom_data.pack``. Custom (non-catalog) prices have
      no binding and skip this check — amount sanity below is authoritative.
    - Amount sanity: when the transaction reports USD totals they must
      match the pack's configured USD price. Other currencies are skipped
      (Paddle local pricing makes exact comparison impossible server-side).
    """
    custom = (data.get("custom_data") or {})
    user = db.get_user(user_id) or {}

    pack_key = str(custom.get("pack") or "") or None
    if pack_key:
        if purchasable_for_key(pack_key) is None:
            pack_key = None
    if not pack_key:
        # Fall back to the price id on the transaction's items.
        for item in data.get("items") or []:
            price_id = str(((item.get("price") or {}).get("id") or ""))
            price_pack = pack_for_price(price_id)
            if price_pack:
                pack_key = price_pack["key"]
                break
    if not pack_key:
        logger.warning("Paddle %s for user %s carried no resolvable pack", event_type, user_id)
        return

    # Integrity check 1: item price ids must all bind to the same pack.
    item_pack_keys = set()
    for item in data.get("items") or []:
        price_id = str(((item.get("price") or {}).get("id") or ""))
        price_pack = pack_for_price(price_id)
        if price_pack:
            item_pack_keys.add(price_pack["key"])
    if item_pack_keys and item_pack_keys != {pack_key}:
        logger.error(
            "Paddle %s rejected: pack/price mismatch for user %s "
            "(claimed pack=%s, item prices=%s)",
            event_type,
            user_id,
            pack_key,
            sorted(item_pack_keys),
        )
        return

    # Integrity check 2: USD totals vs configured price (best-effort, Decimal-safe).
    pack = purchasable_for_key(pack_key) or {}
    expected_usd_cents = int(pack.get("price_usd") or 0)
    details = data.get("details") or {}
    totals = (details.get("totals") or {})
    currency = str((totals.get("currency_code") or data.get("currency_code") or "")).upper()
    raw_total = totals.get("total")
    total_minor: int | None = None
    if raw_total is not None:
        try:
            total_minor = int(Decimal(str(raw_total)).to_integral_value(rounding=ROUND_HALF_UP))
        except (InvalidOperation, ValueError, TypeError):
            total_minor = None
    if expected_usd_cents > 0 and currency == "USD" and total_minor is not None:
        if total_minor < expected_usd_cents:
            logger.error(
                "Paddle %s rejected: paid %s < list price %s (USD) for user %s",
                event_type,
                total_minor,
                expected_usd_cents,
                user_id,
            )
            return

    if is_topup_key(pack_key):
        billing.grant_topup(user_id, pack_key)
    else:
        billing.grant_pack(user_id, pack_key)
    order_id = str(custom.get("order_id") or "")
    if order_id:
        try:
            db.mark_order_settled(order_id)
        except Exception:
            pass
    logger.info(
        "Granted pack %s to user %s (%s credits)", pack_key, user_id, user.get("email")
    )


@hooks_router.post("/webhooks/paddle")
async def paddle_webhook(request: Request) -> dict:
    raw = await request.body()
    if not _verify_paddle_signature(raw, request.headers.get("Paddle-Signature", "")):
        logger.warning(
            "Rejected Paddle webhook: invalid Paddle-Signature (ip=%s)",
            request.client.host if request.client else "?",
        )
        raise HTTPException(status_code=403, detail="Invalid signature")

    try:
        payload = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    event_id = str(payload.get("event_id") or "")
    event_type = str(payload.get("event_type") or "")
    data = payload.get("data") or {}

    if not event_id:
        raise HTTPException(status_code=400, detail="Missing event_id")

    # Claim the idempotency slot BEFORE any grant: the insert is atomic
    # (unique event_id), so concurrent redeliveries can't double-process.
    if not db.claim_billing_event(event_id, event_type, payload):
        return {"ok": True, "deduplicated": True}

    # One-time pack purchases settle under transaction.* lifecycle events.
    if event_type.startswith("transaction.") and "transaction.completed" in event_type:
        status = str((data.get("status") or "").lower())
        payments = (data.get("payments") or [])
        paid = any((p.get("status") or "").lower() in ("paid", "completed") for p in payments)
        if status in ("completed", "paid") or paid:
            user = _find_user(data.get("custom_data"))
            if user:
                _grant_paddle_pack(user["id"], data, event_type)
            else:
                logger.warning("Paddle %s for unknown user (txn=%s)", event_type, data.get("id"))

    return {"ok": True}


# ------------------------------------------------------------- midtrans webhook

# Midtrans transaction_status -> (order status, grants pack?)
_MT_FAILURE_STATUSES = {"deny": "failed", "cancel": "failed", "expire": "expired"}
_MT_SETTLE_STATUSES = {"settlement", "capture"}


@hooks_router.post("/webhooks/midtrans")
async def midtrans_webhook(request: Request) -> dict:
    """Midtrans HTTP notification receiver for one-time credit packs.

    Security model: the notification is unauthenticated input until
    ``signature_key`` verifies AND its ``gross_amount`` matches the amount we
    recorded on the ``payment_orders`` row at checkout time. Entitlements are
    granted from our own row (user/pack), never from notification fields.
    """
    try:
        payload = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    order_id = str(payload.get("order_id") or "")
    status_code = str(payload.get("status_code") or "")
    gross_amount = str(payload.get("gross_amount") or "")
    signature_key = payload.get("signature_key")

    if not order_id:
        raise HTTPException(status_code=400, detail="Missing order_id")
    if not midtrans.is_configured():
        logger.warning("Midtrans notification received but gateway is not configured")
        raise HTTPException(status_code=503, detail="Midtrans is not configured.")
    if not midtrans.verify_signature(order_id, status_code, gross_amount, signature_key):
        logger.warning(
            "Rejected Midtrans notification: invalid signature (order=%s ip=%s)",
            order_id,
            request.client.host if request.client else "?",
        )
        raise HTTPException(status_code=403, detail="Invalid signature")

    order = db.get_payment_order(order_id)
    if order is None:
        logger.warning("Midtrans notification for unknown order %s", order_id)
        raise HTTPException(status_code=404, detail="Unknown order")

    transaction_status = str(payload.get("transaction_status") or "").lower()
    fraud_status = str(payload.get("fraud_status") or "accept").lower()
    transaction_time = str(payload.get("transaction_time") or "")

    event_key = f"{order_id}:{transaction_status}:{transaction_time}"
    # Claim BEFORE any grant (atomic insert; unique key). Concurrent
    # duplicate notifications lose the race here.
    if not db.claim_billing_event(event_key, transaction_status, payload):
        return {"ok": True, "deduplicated": True}

    try:
        paid_amount = int(Decimal(gross_amount).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except (InvalidOperation, ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Malformed gross_amount")

    if paid_amount != int(order["gross_amount"]):
        logger.error(
            "Midtrans amount mismatch for order %s: paid %s, quoted %s",
            order_id,
            paid_amount,
            order["gross_amount"],
        )
        db.set_payment_order_status(order_id, "failed")
        raise HTTPException(status_code=400, detail="Amount mismatch")

    if transaction_status in _MT_SETTLE_STATUSES:
        if transaction_status == "capture" and fraud_status == "challenge":
            # Don't downgrade an already-settled order back to pending.
            if order["status"] != "settled":
                db.set_payment_order_status(order_id, "pending")
            return {"ok": True, "status": "pending"}
        # Card payments legitimately produce BOTH a capture and a settlement
        # notification — two different event keys for one payment. The atomic
        # status transition below guarantees the pack is granted exactly once.
        if not db.mark_order_settled(order_id):
            logger.warning(
                "Midtrans order %s already settled; skipping duplicate grant", order_id
            )
            return {"ok": True, "deduplicated": True}
        before = billing.credit_balance(order["user_id"])
        if is_topup_key(order["plan_key"]):
            billing.grant_topup(order["user_id"], order["plan_key"])
        else:
            billing.grant_pack(order["user_id"], order["plan_key"])
        after = billing.credit_balance(order["user_id"])
        logger.info("Midtrans settled %s: user=%s pack=%s credits %s->%s tier=%s", order_id, order["user_id"], order["plan_key"], before, after, billing.entitlement_tier(order["user_id"]))
    elif transaction_status in _MT_FAILURE_STATUSES:
        db.set_payment_order_status(order_id, _MT_FAILURE_STATUSES[transaction_status])
    elif transaction_status in ("refund", "chargeback"):
        db.set_payment_order_status(order_id, "refunded" if transaction_status == "refund" else "chargeback")
        # A refunded/charged-back pack has its credits deducted back. The tier
        # is intentionally left as-is (permanent entitlements are never revoked).
        pack = purchasable_for_key(order["plan_key"])
        if pack:
            db.increment_user_credits(order["user_id"], -int(pack["credits"]))
    # "pending" and anything unknown: just record it.

    return {"ok": True}