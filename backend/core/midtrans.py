"""Midtrans Snap client for Indonesian payments (fixed-term passes in IDR).

Midtrans is a payment *gateway*, not a Merchant of Record: unlike Lemon
Squeezy there is no hosted redirect URL — we create a **Snap token** and the
frontend pays via ``snap.js`` (GoPay / OVO / QRIS / virtual accounts /
cards). Access is granted as a fixed-term pass on the settlement webhook;
there is no gateway-side auto-renewal for e-wallet/VA methods.

API specifics (docs.midtrans.com):
- Create token: ``POST {base}/snap/v1/transactions`` with
  ``Authorization: Basic base64(server_key + ":")``.
- HTTP notifications are JSON POSTs whose authenticity is proven by
  ``signature_key = sha512(order_id + status_code + gross_amount + server_key)``
  where ``gross_amount`` is the string form with two decimals ("100000.00").
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
from typing import Any

import requests

SNAP_TIMEOUT = 30


class MidtransError(Exception):
    """Raised when Midtrans configuration or an API call fails."""


def _is_production() -> bool:
    return os.environ.get("MIDTRANS_IS_PRODUCTION", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def snap_base_url() -> str:
    """The Snap API base (sandbox unless MIDTRANS_IS_PRODUCTION is set)."""
    return (
        "https://app.midtrans.com"
        if _is_production()
        else "https://app.sandbox.midtrans.com"
    )


def snap_js_url() -> str:
    """The snap.js script the frontend loads to render the payment popup."""
    return (
        "https://app.midtrans.com/snap/snap.js"
        if _is_production()
        else "https://app.sandbox.midtrans.com/snap/snap.js"
    )


def server_key() -> str:
    key = os.environ.get("MIDTRANS_SERVER_KEY", "").strip()
    if not key:
        raise MidtransError("MIDTRANS_SERVER_KEY is not configured.")
    return key


def client_key() -> str:
    key = os.environ.get("MIDTRANS_CLIENT_KEY", "").strip()
    if not key:
        raise MidtransError("MIDTRANS_CLIENT_KEY is not configured.")
    return key


def is_configured() -> bool:
    """True when both keys are present (gates checkout routing)."""
    return bool(
        os.environ.get("MIDTRANS_SERVER_KEY", "").strip()
        and os.environ.get("MIDTRANS_CLIENT_KEY", "").strip()
    )


def verify_signature(
    order_id: str, status_code: str, gross_amount: str, signature_key: str | None
) -> bool:
    """Verify a notification's ``signature_key`` in constant time.

    ``gross_amount`` must be the exact string from the notification (Midtrans
    formats it with two decimals) — it participates in the hash.
    """
    if not signature_key:
        return False
    expected = hashlib.sha512(
        f"{order_id}{status_code}{gross_amount}{server_key()}".encode()
    ).hexdigest()
    return hmac.compare_digest(expected, signature_key)


def create_snap_transaction(
    *,
    order_id: str,
    gross_amount: int,
    plan_name: str,
    plan_key: str,
    user_id: str,
    user_email: str,
    user_name: str | None,
    finish_url: str | None = None,
) -> dict[str, Any]:
    """Create a Snap transaction and return its payload (token + redirect).

    Raises :class:`MidtransError` on any API failure. ``metadata`` carries the
    user/plan mapping back on every notification so entitlements can be
    granted without trusting caller-supplied fields.
    """
    body: dict[str, Any] = {
        "transaction_details": {
            "order_id": order_id,
            "gross_amount": int(gross_amount),
        },
        "item_details": [
            {
                "id": plan_key,
                "price": int(gross_amount),
                "quantity": 1,
                "name": plan_name[:50],
            }
        ],
        "customer_details": {
            "email": user_email,
            "first_name": (user_name or user_email.split("@")[0])[:255],
        },
        "metadata": {"user_id": user_id, "plan_key": plan_key},
        # IDR only; expiry keeps stale VAs from settling months later.
        "credit_card": {"secure": True},
        "expiry": {"duration": 24, "unit": "hour"},
    }
    if finish_url:
        body["callbacks"] = {"finish": finish_url}

    auth = base64.b64encode(f"{server_key()}:".encode()).decode()
    try:
        resp = requests.post(
            f"{snap_base_url()}/snap/v1/transactions",
            json=body,
            headers={
                "Authorization": f"Basic {auth}",
                "Content-Type": "application/json",
            },
            timeout=SNAP_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise MidtransError(f"Could not reach Midtrans: {exc}") from exc

    if resp.status_code >= 400:
        raise MidtransError(f"Snap transaction failed: {resp.text[:200]}")
    try:
        data = resp.json()
    except ValueError as exc:
        raise MidtransError("Unexpected Midtrans response.") from exc
    if not data.get("token"):
        raise MidtransError("Midtrans returned no Snap token.")
    return data
