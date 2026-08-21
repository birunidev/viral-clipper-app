"""Encryption helpers for at-rest secrets (BYOK API keys).

API keys the user supplies (OpenAI/LLM, AssemblyAI) are stored in the
``user_settings`` table as Fernet-encrypted blobs so a DB leak doesn't
expose raw keys. The Fernet key is derived from ``APP_SECRET_KEY``
(a required env var, see .env.example) — any 32+ char secret works.

Design:
- ``encrypt_secret``/``decrypt_secret`` wrap Fernet over ``utf-8`` strings.
- Empty/None input stays empty/None (so "not set" is unambiguous and
  never produces ciphertext).
- ``decrypt_secret`` is defensive: bad keys/values return None rather than
  raising, so a misconfigured secret key degrades to "fall back to env"
  instead of crashing the pipeline.
"""

from __future__ import annotations

import os

from cryptography.fernet import Fernet, InvalidToken

SECRET_ENV = "APP_SECRET_KEY"


class SecretError(Exception):
    """Raised when the encryption key is missing/unusable."""


_fernet: Fernet | None = None


def is_configured() -> bool:
    """Whether ``APP_SECRET_KEY`` is present, i.e. key encryption is usable."""
    return bool(os.environ.get(SECRET_ENV, "").strip())


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        raw = os.environ.get(SECRET_ENV, "").strip()
        if not raw:
            raise SecretError(
                f"{SECRET_ENV} environment variable is required to encrypt user API keys."
            )
        # Any arbitrary string becomes a valid Fernet key via base64 url-safe
        # SHA-256. This keeps deployment simple (just set a long random value)
        # while still deriving a strong key from it.
        import base64
        import hashlib

        key = base64.urlsafe_b64encode(hashlib.sha256(raw.encode("utf-8")).digest())
        _fernet = Fernet(key)
    return _fernet


def encrypt_secret(value: str | None) -> str | None:
    """Encrypt ``value`` for at-rest storage. Empty/None pass through."""
    if not value:
        return value
    return _get_fernet().encrypt(value.encode("utf-8")).decode("utf-8")


def decrypt_secret(value: str | None) -> str | None:
    """Decrypt ``value`` back to plaintext. Empty/None pass through;
    undecryptable values (rotated key, tampered data) return None."""
    if not value:
        return value
    try:
        return _get_fernet().decrypt(value.encode("utf-8")).decode("utf-8")
    except (InvalidToken, SecretError, ValueError):
        return None


def reset_fernet() -> None:
    """Drop the cached Fernet instance (used by tests to rebind the key)."""
    global _fernet
    _fernet = None
