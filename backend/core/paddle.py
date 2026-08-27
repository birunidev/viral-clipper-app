from __future__ import annotations

import logging
import os

import requests

logger = logging.getLogger(__name__)

PADDLE_EVENTS = [
    "transaction.completed",
    "transaction.billed",
    "transaction.updated",
    "transaction.created",
    "transaction.payment_failed",
    "transaction.ready",
    "transaction.canceled",
]


def paddle_base_url() -> str:
    if os.environ.get("PADDLE_ENV", "").strip().lower() == "production":
        return "https://api.paddle.com"
    return "https://sandbox-api.paddle.com"


def _paddle_headers() -> dict[str, str]:
    key = os.environ.get("PADDLE_API_KEY", "").strip()
    if not key:
        raise RuntimeError("PADDLE_API_KEY not configured")
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def resolve_notification_url() -> str | None:
    explicit = os.environ.get("PADDLE_NOTIFICATION_URL", "").strip()
    if explicit:
        return explicit.rstrip("/")
    for k in ("BACKEND_URL", "PUBLIC_BACKEND_URL", "API_URL"):
        base = os.environ.get(k, "").strip()
        if base:
            return base.rstrip("/") + "/api/v1/webhooks/paddle"
    return None


def ensure_notification_destination(timeout: int = 15) -> dict | None:
    if os.environ.get("PADDLE_AUTO_CREATE_NOTIFICATION", "1").strip().lower() in ("0", "false", "no", "off"):
        return None
    desired = resolve_notification_url()
    if not desired:
        logger.info("Paddle notification auto-setup skipped: no BACKEND_URL/PADDLE_NOTIFICATION_URL")
        return None
    if not os.environ.get("PADDLE_API_KEY", "").strip():
        logger.info("Paddle notification auto-setup skipped: PADDLE_API_KEY not set")
        return None
    base = paddle_base_url()
    headers = _paddle_headers()
    try:
        resp = requests.get(f"{base}/notification-settings", headers=headers, timeout=timeout)
        if resp.status_code >= 400:
            logger.warning("Paddle list notification-settings failed: %s %s", resp.status_code, resp.text[:300])
            return None
        data = resp.json().get("data") or []
        for item in data:
            if (item.get("destination") or "").rstrip("/") == desired:
                active = item.get("active")
                events = {e.get("name") for e in (item.get("subscribed_events") or [])}
                if active and "transaction.completed" in events:
                    logger.info("Paddle notification destination already exists: %s", desired)
                    return item
                # patch existing
                try:
                    pr = requests.patch(f"{base}/notification-settings/{item['id']}", headers=headers, json={"destination": desired, "active": True, "subscribed_events": PADDLE_EVENTS}, timeout=timeout)
                    if pr.status_code < 400:
                        logger.info("Paddle notification destination updated: %s", desired)
                        return pr.json().get("data")
                    logger.warning("Paddle patch destination failed: %s %s", pr.status_code, pr.text[:300])
                except Exception as e:
                    logger.warning("Paddle patch error: %s", e)
                return None
        # create new
        body = {
            "description": "ClipForge Paddle webhook",
            "type": "url",
            "destination": desired,
            "active": True,
            "api_version": 1,
            "include_sensitive_fields": True,
            "subscribed_events": PADDLE_EVENTS,
        }
        cr = requests.post(f"{base}/notification-settings", headers=headers, json=body, timeout=timeout)
        if cr.status_code < 400:
            logger.info("Paddle notification destination created: %s", desired)
            return cr.json().get("data")
        logger.warning("Paddle create destination failed: %s %s", cr.status_code, cr.text[:300])
    except Exception as e:
        logger.warning("Paddle notification auto-setup error: %s", e)
    return None
