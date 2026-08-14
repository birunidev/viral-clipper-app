"""Tests for the FastAPI job service endpoints."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["ok"] is True


def test_start_job_requires_internal_key():
    res = client.post("/jobs", json={"jobId": "abc123"})
    assert res.status_code == 401
