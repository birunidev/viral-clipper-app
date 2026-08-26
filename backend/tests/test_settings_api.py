"""Tests for the BYOK settings API (GET masked, PUT write-only)."""

from __future__ import annotations

import importlib.util

import pytest

from app import db
from core import billing, secrets, storage
from helpers import register_user


@pytest.fixture(autouse=True)
def _set_secret_key(monkeypatch):
    monkeypatch.setenv("APP_SECRET_KEY", "test-secret-key")
    secrets.reset_fernet()
    yield
    secrets.reset_fernet()


def _register(client):
    return register_user(client, email="byok@example.com")


def test_get_settings_requires_auth(client):
    assert client.get("/api/v1/settings").status_code == 401


def test_get_settings_defaults_empty(client):
    _register(client)
    res = client.get("/api/v1/settings")
    assert res.status_code == 200
    data = res.json()
    assert data["transcription_provider"] == "assemblyai"
    assert data["has_llm_api_key"] is False
    assert data["has_assemblyai_key"] is False
    assert data["llm_api_key_preview"] is None
    # A fresh user is on the trial plan, so the storage cap is plan-based.
    uid = db.get_user_by_email("byok@example.com")["id"]
    assert data["storage_cap_bytes"] == billing.storage_cap(uid)
    assert data["storage_remaining_bytes"] == billing.storage_cap(uid)


def test_put_saves_settings_and_get_masks_keys(client):
    _register(client)
    res = client.put(
        "/api/v1/settings",
        json={
            "llm_api_key": "sk-secret-llm-key",
            "assemblyai_key": "sk-secret-aai-key",
            "llm_base_url": "https://api.openai.com/v1",
            "llm_model": "gpt-4o-mini",
            "transcription_provider": "assemblyai",
        },
    )
    assert res.status_code == 200
    data = res.json()
    assert data["has_llm_api_key"] is True
    assert data["has_assemblyai_key"] is True
    assert data["llm_api_key_preview"] == "sk-…-key"
    assert data["assemblyai_key_preview"] == "sk-…-key"
    assert data["llm_base_url"] == "https://api.openai.com/v1"
    assert data["llm_model"] == "gpt-4o-mini"
    # Plaintext keys are never echoed back.
    assert "sk-secret-llm-key" not in res.text
    assert "sk-secret-aai-key" not in res.text

    # Stored row is encrypted, and decrypts back to the original.
    row = db.get_user_settings(db.get_user_by_email("byok@example.com")["id"])
    assert row["llm_api_key"] != "sk-secret-llm-key"
    assert secrets.decrypt_secret(row["llm_api_key"]) == "sk-secret-llm-key"


def _set_keys(client):
    """PUT a full valid config (aai + llm keys) so later partial updates
    don't trip the 'assemblyai provider needs a key' validation."""
    return client.put(
        "/api/v1/settings",
        json={
            "llm_api_key": "sk-keep",
            "assemblyai_key": "sk-aai",
            "transcription_provider": "assemblyai",
        },
    )


def test_put_with_null_keeps_existing_key(client):
    _register(client)
    _set_keys(client)
    res = client.put("/api/v1/settings", json={"llm_model": "gpt-4o"})
    assert res.status_code == 200
    assert res.json()["has_llm_api_key"] is True
    assert res.json()["has_assemblyai_key"] is True


def test_put_with_empty_string_clears_key(client):
    _register(client)
    _set_keys(client)
    res = client.put("/api/v1/settings", json={"llm_api_key": ""})
    data = res.json()
    assert data["has_llm_api_key"] is False
    assert data["llm_api_key_preview"] is None


def test_put_requires_aai_key_when_provider_is_assemblyai(client):
    _register(client)
    # No AssemblyAI key anywhere -> 400.
    res = client.put(
        "/api/v1/settings",
        json={"transcription_provider": "assemblyai", "llm_api_key": "sk-x"},
    )
    assert res.status_code == 400
    assert "AssemblyAI key is required" in res.json()["detail"]


def test_put_allows_local_provider_without_aai_key(client, monkeypatch):
    # The deployment supports local transcription (env opts in), so the
    # provider switch is accepted even though no AAI key is involved.
    monkeypatch.setenv("TRANSCRIPTION_PROVIDER", "local")
    _register(client)
    res = client.put(
        "/api/v1/settings",
        json={"transcription_provider": "local", "llm_api_key": "sk-x"},
    )
    assert res.status_code == 200
    assert res.json()["transcription_provider"] == "local"


def test_put_rejects_local_provider_when_unavailable(client, monkeypatch):
    # Deployment has no pywhispercpp and doesn't opt into local via env:
    # selecting ``local`` must fail fast instead of failing at job time.
    monkeypatch.delenv("TRANSCRIPTION_PROVIDER", raising=False)
    monkeypatch.setattr(importlib.util, "find_spec", lambda name: None)
    _register(client)
    res = client.put(
        "/api/v1/settings",
        json={"transcription_provider": "local", "llm_api_key": "sk-x"},
    )
    assert res.status_code == 400
    assert "not available" in res.json()["detail"]


def test_put_rejects_invalid_provider(client):
    _register(client)
    res = client.put(
        "/api/v1/settings",
        json={"transcription_provider": "bogus"},
    )
    assert res.status_code == 422


def test_put_partial_update_preserves_provider(client, monkeypatch):
    """A partial PUT (e.g. only llm_model) must not reset the stored
    transcription provider back to assemblyai."""
    monkeypatch.setenv("TRANSCRIPTION_PROVIDER", "local")
    _register(client)
    res = client.put(
        "/api/v1/settings",
        json={"transcription_provider": "local", "llm_api_key": "sk-x"},
    )
    assert res.status_code == 200

    # Partial update that doesn't mention the provider at all.
    res = client.put("/api/v1/settings", json={"llm_model": "gpt-4o"})
    assert res.status_code == 200
    assert res.json()["transcription_provider"] == "local"

    # Same for a key-only update.
    res = client.put("/api/v1/settings", json={"assemblyai_key": "sk-aai"})
    assert res.status_code == 200
    assert res.json()["transcription_provider"] == "local"


def test_short_keys_are_fully_masked(client):
    """Keys of 12 chars or fewer must be masked entirely — the 3+4 preview
    would leak the whole key for short values."""
    _register(client)
    res = client.put(
        "/api/v1/settings",
        json={"llm_api_key": "sk-12345", "assemblyai_key": "sk-1"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["llm_api_key_preview"] == "•" * len("sk-12345")
    assert data["assemblyai_key_preview"] == "•" * len("sk-1")
    assert "sk-12345" not in res.text


def test_get_and_put_return_503_when_secret_key_missing(client, monkeypatch):
    """Without APP_SECRET_KEY the app cannot encrypt/decrypt keys: both GET
    and PUT must fail loudly with 503 instead of silently reporting
    has_*=false or 500-ing on encrypt."""
    monkeypatch.delenv("APP_SECRET_KEY", raising=False)
    secrets.reset_fernet()
    try:
        _register(client)
        get_res = client.get("/api/v1/settings")
        assert get_res.status_code == 503
        put_res = client.put("/api/v1/settings", json={"llm_model": "gpt-4o"})
        assert put_res.status_code == 503
        assert "APP_SECRET_KEY" in put_res.json()["detail"]
    finally:
        monkeypatch.setenv("APP_SECRET_KEY", "test-secret-key")
        secrets.reset_fernet()
