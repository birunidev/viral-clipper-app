"""Tests for Midtrans (Indonesian) one-time credit-pack payments."""

from __future__ import annotations

import hashlib

import pytest

from app import db
from core import billing
from helpers import register_user

SERVER_KEY = "SB-Mid-server-testkey"


def _sign(order_id: str, status_code: str, gross_amount: str) -> str:
    return hashlib.sha512(
        f"{order_id}{status_code}{gross_amount}{SERVER_KEY}".encode()
    ).hexdigest()


@pytest.fixture(autouse=True)
def _midtrans_env(monkeypatch):
    monkeypatch.setenv("MIDTRANS_SERVER_KEY", SERVER_KEY)
    monkeypatch.setenv("MIDTRANS_CLIENT_KEY", "SB-Mid-client-testkey")
    yield


def _register(client, email="mid@example.com"):
    register_user(client, email=email)
    return db.get_user_by_email(email)["id"]


_ORDER_SEQ = [0]


def _create_order(user_id: str, plan_key: str = "starter", amount: int = 29_000) -> str:
    _ORDER_SEQ[0] += 1
    order_id = f"CF-{user_id[:8]}-{plan_key}-{_ORDER_SEQ[0]}"
    db.create_payment_order(
        user_id=user_id,
        provider="midtrans",
        order_id=order_id,
        plan_key=plan_key,
        gross_amount=amount,
        currency="IDR",
    )
    return order_id


def _notify(client, order_id: str, status: str, gross_amount="29000.00",
            status_code="200", signature=None, transaction_time=None):
    payload = {
        "order_id": order_id,
        "status_code": status_code,
        "gross_amount": gross_amount,
        "signature_key": signature or _sign(order_id, status_code, gross_amount),
        "transaction_status": status,
        "fraud_status": "accept",
        "transaction_time": transaction_time or "2026-08-25 10:00:00",
        "transaction_id": f"tx-{order_id}",
        "metadata": {"user_id": "whatever", "plan_key": "studio"},  # ignored
    }
    return client.post("/api/v1/webhooks/midtrans", json=payload)


# ------------------------------------------------------------------- routing


def test_provider_routes_indonesian_timezones():
    from app.api.billing import provider_for

    for tz in ("Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "Asia/Pontianak"):
        assert provider_for(tz) == "midtrans"
    assert provider_for("Europe/Amsterdam") == "paddle"
    assert provider_for(None) == "paddle"
    assert provider_for("Asia/Fake_City") == "paddle"


def test_provider_falls_back_without_midtrans_config(monkeypatch):
    from app.api.billing import provider_for

    monkeypatch.delenv("MIDTRANS_SERVER_KEY", raising=False)
    monkeypatch.delenv("MIDTRANS_CLIENT_KEY", raising=False)
    assert provider_for("Asia/Jakarta") == "paddle"


# ------------------------------------------------------------------ checkout


def test_midtrans_checkout_creates_pending_order_and_snap_token(
    client, monkeypatch
):
    uid = _register(client, email="buy@example.com")

    captured = {}

    def fake_snap(**kwargs):
        captured.update(kwargs)
        return {"token": "snap-token-1", "redirect_url": "https://snap/x"}

    monkeypatch.setattr("core.midtrans.create_snap_transaction", fake_snap)

    res = client.post(
        "/api/v1/billing/checkout",
        json={"plan_key": "starter", "timezone": "Asia/Jakarta"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["provider"] == "midtrans"
    assert data["token"] == "snap-token-1"
    assert data["client_key"]
    assert data["url"] is None

    order_id = captured["order_id"]
    order = db.get_payment_order(order_id)
    assert order is not None
    assert order["gross_amount"] == 29_000
    assert order["plan_key"] == "starter"
    assert order["currency"] == "IDR"
    assert order["status"] == "pending"

    # No new credits granted yet — the pack is only settled after the
    # webhook (the user only has their one-time signup grant).
    assert billing.credit_balance(uid) == 5


def test_checkout_rejects_unknown_pack(client):
    _register(client, email="bogusbuy@example.com")
    res = client.post("/api/v1/billing/checkout", json={"plan_key": "trial"})
    assert res.status_code == 400


# ------------------------------------------------------------------- webhook


def test_webhook_rejects_invalid_signature(client):
    uid = _register(client, email="sig@example.com")
    order_id = _create_order(uid)
    res = _notify(client, order_id, "settlement", signature="deadbeef")
    assert res.status_code == 403


def test_webhook_rejects_unknown_order(client):
    res = _notify(client, "CF-nonexistent-order", "settlement")
    assert res.status_code == 404


def test_webhook_rejects_tampered_amount(client):
    """Paying less than the quoted price must never grant the pack."""
    uid = _register(client, email="tamper@example.com")
    order_id = _create_order(uid)
    res = _notify(client, order_id, "settlement", gross_amount="1.00")
    assert res.status_code == 400
    assert db.get_payment_order(order_id)["status"] == "failed"
    assert billing.credit_balance(uid) == 5


def test_settlement_grants_credits_and_permanent_tier(client):
    uid = _register(client, email="settle@example.com")
    order_id = _create_order(uid)

    res = _notify(client, order_id, "settlement")
    assert res.status_code == 200

    user = db.get_user(uid)
    assert user["entitlement_tier"] == "starter"
    assert user["credits"] >= 60  # starter pack includes 60 credits
    assert db.get_payment_order(order_id)["status"] == "settled"


def test_settlement_is_idempotent_on_redelivery(client):
    uid = _register(client, email="dupmt@example.com")
    order_id = _create_order(uid)
    first = _notify(client, order_id, "settlement")
    second = _notify(client, order_id, "settlement")
    assert first.json() == {"ok": True}
    assert second.json()["deduplicated"] is True
    # Credits are not double-granted on a replay.
    assert billing.credit_balance(uid) < 120


def test_capture_then_settlement_grants_exactly_once(client):
    """Card payments emit BOTH capture and settlement — distinct event keys
    for one payment. The pack must be granted exactly once."""
    uid = _register(client, email="capture@example.com")
    order_id = _create_order(uid)

    capture = _notify(client, order_id, "capture")
    settle = _notify(client, order_id, "settlement")
    assert capture.status_code == 200 and settle.status_code == 200

    user = db.get_user(uid)
    # Starter = 60 credits; a double grant would show 120+ here. The free
    # signup grant is 5, so exactly one pack means 65.
    assert user["credits"] == 5 + 60
    assert db.get_payment_order(order_id)["status"] == "settled"


def test_higher_pack_raises_tier_and_keeps_credits(client):
    uid = _register(client, email="upgrade@example.com")
    _notify(client, _create_order(uid, "starter"), "settlement")
    credits_after_starter = billing.credit_balance(uid)
    assert billing.entitlement_tier(uid) == "starter"

    _notify(client, _create_order(uid, "studio", amount=399_000), "settlement",
            gross_amount="399000.00", transaction_time="2026-08-25 11:00:00")
    assert billing.entitlement_tier(uid) == "studio"
    # Studio credits are added on top of the remaining starter balance.
    assert billing.credit_balance(uid) > credits_after_starter


def test_failure_status_does_not_grant_pack(client):
    uid = _register(client, email="deny@example.com")
    order_id = _create_order(uid)
    res = _notify(client, order_id, "deny")
    assert res.status_code == 200
    assert db.get_payment_order(order_id)["status"] == "failed"
    assert billing.entitlement_tier(uid) == "free"
    assert billing.credit_balance(uid) == 5


def test_refund_deducts_credits_but_keeps_tier(client):
    uid = _register(client, email="refund@example.com")
    order_id = _create_order(uid)
    _notify(client, order_id, "settlement")
    assert billing.credit_balance(uid) >= 60

    res = _notify(client, order_id, "refund")
    assert res.status_code == 200
    # Credits clawed back (back to the signup grant); the permanent tier is
    # intentionally not revoked.
    assert billing.credit_balance(uid) == 5
    assert billing.entitlement_tier(uid) == "starter"