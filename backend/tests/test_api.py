"""Tests for the FastAPI app-level endpoints."""

from __future__ import annotations

from app.main import app


def test_health():
    from fastapi.testclient import TestClient

    with TestClient(app) as client:
        res = client.get("/health")
        assert res.status_code == 200
        assert res.json()["ok"] is True
        assert res.json()["service"] == "clipforge-backend"


def test_api_v1_routers_registered():
    paths = {route.path for route in app.routes}
    assert "/api/v1/auth/register" in paths
    assert "/api/v1/auth/login" in paths
    assert "/api/v1/auth/me" in paths
    assert "/api/v1/projects" in paths
    assert "/api/v1/projects/{project_id}" in paths
    assert "/api/v1/projects/{project_id}/start" in paths
    assert "/api/v1/jobs/{job_id}" in paths
    assert "/api/v1/uploads/presign" in paths
