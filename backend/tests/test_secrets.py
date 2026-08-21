"""Tests for core.secrets (Fernet at-rest key encryption)."""

from __future__ import annotations

import os

import pytest

from core import secrets


@pytest.fixture(autouse=True)
def _set_secret_key(monkeypatch):
    monkeypatch.setenv("APP_SECRET_KEY", "test-secret-key")
    secrets.reset_fernet()
    yield
    secrets.reset_fernet()


def test_roundtrip():
    assert secrets.decrypt_secret(secrets.encrypt_secret("sk-abc123")) == "sk-abc123"


def test_empty_and_none_pass_through():
    assert secrets.encrypt_secret("") == ""
    assert secrets.encrypt_secret(None) is None
    assert secrets.decrypt_secret("") == ""
    assert secrets.decrypt_secret(None) is None


def test_encrypted_is_not_plaintext():
    assert secrets.encrypt_secret("sk-secret") != "sk-secret"


def test_rotated_key_returns_none(monkeypatch):
    enc = secrets.encrypt_secret("sk-secret")
    secrets.reset_fernet()
    monkeypatch.setenv("APP_SECRET_KEY", "a-different-key")
    secrets.reset_fernet()
    # Undecryptable under the new key -> None (graceful, not a crash).
    assert secrets.decrypt_secret(enc) is None


def test_missing_key_raises_on_encrypt(monkeypatch):
    monkeypatch.delenv("APP_SECRET_KEY")
    secrets.reset_fernet()
    with pytest.raises(secrets.SecretError):
        secrets.encrypt_secret("sk-x")
