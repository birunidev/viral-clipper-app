"""Tests for the credit-based billing paywall: balances, entitlements,
Paddle one-time pack webhook."""

from __future__ import annotations

import hashlib
import hmac
import time as time_mod

import pytest

from app import db
from core import billing
from helpers import register_user

MB = 1024 * 1024
WEBHOOK_SECRET = "pdl_ntfset_topsecret"


def _register(client, email="bill@example.com"):
    register_user(client, email=email)
    return db.get_user_by_email(email)["id"]


# ------------------------------------------------------------ credit balance


def test_signup_grants_one_time_free_credits(client):
    uid = _register(client)
    assert billing.credit_balance(uid) == 5
    assert billing.entitlement_tier(uid) == "free"


def test_record_credits_rounds_up_stays_non_negative(client):
    uid = _register(client)
    billing.record_credits(uid, 61)  # 61s -> 2 (ceil)
    assert billing.credit_balance(uid) == 3
    # Deducting more than the balance bottoms out at 0, never negative.
    billing.record_credits(uid, 1_000_000)
    assert billing.credit_balance(uid) == 0


def test_enforce_credits_blocks_when_exhausted(client):
    uid = _register(client)
    billing.record_credits(uid, 1_000_000)
    with pytest.raises(billing.PaywallError, match="credits"):
        billing.enforce_credits(uid)


def test_enforce_credits_blocks_oversize_job(client):
    uid = _register(client)  # 5 credits
    with pytest.raises(billing.PaywallError):
        billing.enforce_credits(uid, estimated_seconds=10 * 60)  # needs 10


def test_grant_pack_adds_credits_and_raises_tier(client):
    uid = _register(client)
    pack = billing.grant_pack(uid, "starter")
    assert pack is not None
    assert billing.credit_balance(uid) == 5 + 60
    assert billing.entitlement_tier(uid) == "starter"

    # Buying a lower/higher pack never lowers the tier; credits always add.
    billing.grant_pack(uid, "creator")
    assert billing.entitlement_tier(uid) == "creator"
    assert billing.credit_balance(uid) == 5 + 60 + 300


def test_grant_pack_unknown_key_returns_none(client):
    uid = _register(client)
    assert billing.grant_pack(uid, "nope") is None
    assert billing.entitlement_tier(uid) == "free"


# ------------------------------------------------------------ entitlements


def test_default_tier_is_free_limits(client):
    uid = _register(client)
    from app.plans import free_tier

    assert billing.storage_cap(uid) == int(free_tier()["storage_cap_bytes"])
    assert billing.storage_remaining(uid) == int(free_tier()["storage_cap_bytes"])


def test_storage_cap_comes_from_purchased_tier(client):
    uid = _register(client)
    billing.grant_pack(uid, "studio")
    from app.plans import pack_for_key

    assert billing.storage_cap(uid) == int(pack_for_key("studio")["storage_cap_bytes"])
    assert billing.render_allowed(uid)[1] == int(pack_for_key("studio")["max_resolution"])
    assert billing.render_allowed(uid)[2] is False


def test_project_cap_enforces(client):
    uid = _register(client)
    cap = billing.effective_entitlement(uid)["max_projects"]  # free default 3
    for _ in range(cap):
        db.create_project(uid, "P", "https://youtu.be/a", "youtube")
    with pytest.raises(billing.PaywallError):
        billing.enforce_project_cap(uid)


def test_higher_tier_unlocks_unlimited_projects(client):
    uid = _register(client)
    billing.grant_pack(uid, "creator")
    for _ in range(50):
        db.create_project(uid, "P", "https://youtu.be/a", "youtube")
    billing.enforce_project_cap(uid)  # no raise


# ------------------------------------------------------------- uses_managed


def test_uses_managed_true_by_default(client):
    # BYOK is disabled by default -> every user is managed and pays credits.
    uid = _register(client)
    assert billing.uses_managed(uid) is True


def test_uses_managed_opt_in_byok(monkeypatch, client):
    monkeypatch.setenv("ENABLE_BYOK", "1")
    monkeypatch.setenv("APP_SECRET_KEY", "test-secret-key")
    from core import secrets

    secrets.reset_fernet()
    uid = _register(client)
    try:
        db.upsert_user_settings(
            uid,
            {
                "llm_api_key": secrets.encrypt_secret("sk-user"),
                "assemblyai_key": secrets.encrypt_secret("sk-aai"),
                "transcription_provider": "assemblyai",
            },
        )
        assert billing.uses_managed(uid) is False
    finally:
        secrets.reset_fernet()


# ------------------------------------------------------------- checkout


def test_checkout_creates_paddle_transaction(client, monkeypatch):
    register_user(client, email="checkout@example.com")
    monkeypatch.setenv("PADDLE_API_KEY", "pdl_api_key_test")
    monkeypatch.setenv("PADDLE_PRICE_STARTER", "pri_starter_test")

    captured = {}

    class FakeResp:
        status_code = 200

        def json(self):
            return {"data": {"id": "txn_1", "checkout": {"url": "https://buy.example.com/txn_1"}}}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured.update(url=url, headers=headers, body=json)
        return FakeResp()

    monkeypatch.setattr("app.api.billing.requests.post", fake_post)

    res = client.post(
        "/api/v1/billing/checkout",
        json={"plan_key": "starter", "timezone": "Europe/Amsterdam"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["provider"] == "paddle"
    assert data["url"] == "https://buy.example.com/txn_1"
    assert captured["url"].endswith("/transactions")
    assert captured["headers"]["Authorization"] == "Bearer pdl_api_key_test"
    assert captured["body"]["items"][0]["quantity"] == 1
    uid = db.get_user_by_email("checkout@example.com")["id"]
    assert captured["body"]["custom_data"] == {"user_id": uid, "pack": "starter"}


def test_checkout_rejects_unknown_pack(client):
    register_user(client, email="bogusplan@example.com")
    res = client.post("/api/v1/billing/checkout", json={"plan_key": "nope"})
    assert res.status_code == 400


# ----------------------------------------------------------------- webhook


def _paddle_signature(body: bytes, secret: str = WEBHOOK_SECRET, ts: str | None = None) -> str:
    ts = ts or str(int(time_mod.time()))
    digest = hmac.new(secret.encode(), f"{ts}:".encode() + body, hashlib.sha256).hexdigest()
    return f"ts={ts};h1={digest}"


def _paddle_transaction(
    uid: str,
    *,
    event_id: str = "evt_1",
    pack: str = "starter",
    price_id: str = "pri_starter_test",
    status: str = "completed",
) -> dict:
    return {
        "event_id": event_id,
        "event_type": "transaction.completed",
        "occurred_at": "2026-08-25T00:00:00.000Z",
        "data": {
            "id": "txn_900",
            "status": status,
            "custom_data": {"user_id": uid, "pack": pack},
            "items": [{"price": {"id": price_id}}],
            "payments": [{"status": "paid"}],
        },
    }


def _post_event(client, payload: dict, secret: str = WEBHOOK_SECRET):
    body = __import__("json").dumps(payload).encode()
    return client.post(
        "/api/v1/webhooks/paddle",
        content=body,
        headers={"Paddle-Signature": _paddle_signature(body, secret)},
    )


def test_webhook_rejects_bad_signature(client, monkeypatch):
    monkeypatch.setenv("PADDLE_WEBHOOK_SECRET", WEBHOOK_SECRET)
    res = client.post(
        "/api/v1/webhooks/paddle",
        json=_paddle_transaction("whatever"),
        headers={"Paddle-Signature": "ts=1;h1=deadbeef"},
    )
    assert res.status_code == 403


def test_webhook_rejects_stale_timestamp(client, monkeypatch):
    monkeypatch.setenv("PADDLE_WEBHOOK_SECRET", WEBHOOK_SECRET)
    body = __import__("json").dumps(_paddle_transaction("x")).encode()
    old_ts = str(int(time_mod.time()) - 7200)
    res = client.post(
        "/api/v1/webhooks/paddle",
        content=body,
        headers={"Paddle-Signature": _paddle_signature(body, ts=old_ts)},
    )
    assert res.status_code == 403


def test_webhook_grants_pack_and_credits(client, monkeypatch):
    monkeypatch.setenv("PADDLE_WEBHOOK_SECRET", WEBHOOK_SECRET)
    uid = _register(client, email="sub@example.com")

    res = _post_event(client, _paddle_transaction(uid))
    assert res.status_code == 200

    user = db.get_user(uid)
    assert user["entitlement_tier"] == "starter"
    assert user["credits"] == 5 + 60
    assert user["plan_key"] == "starter"


def test_webhook_deduplicates_on_redelivery(client, monkeypatch):
    monkeypatch.setenv("PADDLE_WEBHOOK_SECRET", WEBHOOK_SECRET)
    uid = _register(client, email="dup@example.com")
    payload = _paddle_transaction(uid, event_id="evt_dup")
    first = _post_event(client, payload)
    second = _post_event(client, payload)
    assert first.status_code == 200 and second.status_code == 200
    assert second.json()["deduplicated"] is True
    assert billing.credit_balance(uid) == 5 + 60


def test_webhook_ignores_uncompleted_transactions(client, monkeypatch):
    monkeypatch.setenv("PADDLE_WEBHOOK_SECRET", WEBHOOK_SECRET)
    uid = _register(client, email="pending@example.com")
    payload = _paddle_transaction(uid, event_id="evt_pend", status="pending")
    # Force the paid payment check to fail: no paid payments recorded.
    payload["data"]["payments"] = [{"status": "authorized"}]
    res = _post_event(client, payload)
    assert res.status_code == 200
    assert billing.credit_balance(uid) == 5
    assert billing.entitlement_tier(uid) == "free"


def test_webhook_unknown_user_logs_but_ok(client, monkeypatch):
    monkeypatch.setenv("PADDLE_WEBHOOK_SECRET", WEBHOOK_SECRET)
    res = _post_event(client, _paddle_transaction("nonexistent-uid"))
    assert res.status_code == 200


# ---------------------------------------------------------------- status


def test_billing_status_shape(client):
    uid = _register(client)
    billing.grant_pack(uid, "creator")
    status = billing.billing_status(uid)
    assert status["tier"] == "creator"
    assert status["credits"] == 5 + 300
    assert status["byok_enabled"] is False
    assert {p["key"] for p in status["packs"]} == {"starter", "creator", "studio"}
    assert "storage_used_bytes" in status["usage"]
    assert "storage_cap_bytes" in status["limits"]


def test_billing_status_byok_flag(monkeypatch, client):
    monkeypatch.setenv("ENABLE_BYOK", "1")
    uid = _register(client)
    assert billing.billing_status(uid)["byok_enabled"] is True