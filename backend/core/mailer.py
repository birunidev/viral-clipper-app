"""SMTP email sender with stdout-log fallback.

Used by the magic-link password reset flow.  Configuration is via env:

    SMTP_HOST         smtp.example.com
    SMTP_PORT         587
    SMTP_USER         user
    SMTP_PASS         pass
    SMTP_FROM         noreply@clipzard.web.id
    SMTP_TLS          starttls  (starttls | tls | none)
    SITE_URL          https://clipzard.web.id   (used to build the magic link)

If any of SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS is unset, the
helper logs the would-be email to stdout and returns success.  This is
the dev / smoke-test fallback: no silent drops, no fake-OKs — the link
still appears in the log so the smoke script can pull it via a dev-only
HTTP endpoint.

The module does not call out to network for any reason other than
``send()``.  All other helpers are pure functions over the env config.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage
from typing import Optional


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return default


def smtp_configured() -> bool:
    """True when all required SMTP env vars are set."""
    return all(
        (os.environ.get(k, "").strip() for k in ("SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"))
    )


def from_address() -> str:
    return os.environ.get("SMTP_FROM", "noreply@clipzard.web.id").strip() or "noreply@clipzard.web.id"


def site_url() -> str:
    return (os.environ.get("SITE_URL", "https://clipzard.web.id").strip() or "https://clipzard.web.id").rstrip("/")


def _format_message(to: str, subject: str, text: str, html: Optional[str] = None) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = from_address()
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    return msg


async def send(to: str, subject: str, text: str, html: Optional[str] = None) -> bool:
    """Send an email.  Returns True on success, False otherwise.

    When SMTP env is not configured the message is appended to stdout
    and the function returns True (so the caller can pretend it sent).
    This is the dev / smoke-test fallback.
    """
    if not smtp_configured():
        # Stdout-log fallback.  Timestamp + To/Subject so multiple
        # sessions in the same log are easy to scan.
        ts = dt.datetime.now(dt.timezone.utc).isoformat()
        print(
            f"[smtp-fallback] {ts} -> {to}\n  subject: {subject}\n  body:\n{text}",
            file=sys.stdout,
            flush=True,
        )
        return True

    host = os.environ["SMTP_HOST"].strip()
    port = int(os.environ.get("SMTP_PORT", "587").strip() or "587")
    user = os.environ["SMTP_USER"].strip()
    pwd = os.environ["SMTP_PASS"]
    tls_mode = (os.environ.get("SMTP_TLS", "starttls").strip().lower() or "starttls")

    msg = _format_message(to, subject, text, html)
    return await asyncio.to_thread(_send_blocking, host, port, user, pwd, tls_mode, msg)


def _send_blocking(host: str, port: int, user: str, pwd: str, tls_mode: str, msg: EmailMessage) -> bool:
    try:
        if tls_mode == "tls":
            ctx = ssl.create_default_context()
            with smtplib.SMTP_SSL(host, port, context=ctx, timeout=15) as s:
                s.login(user, pwd)
                s.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=15) as s:
                s.ehlo()
                if tls_mode == "starttls":
                    s.starttls(context=ssl.create_default_context())
                    s.ehlo()
                s.login(user, pwd)
                s.send_message(msg)
        return True
    except Exception as e:  # pragma: no cover
        # Surface failure rather than silently dropping the message.
        print(f"[smtp] send failed: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        return False
