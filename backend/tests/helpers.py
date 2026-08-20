"""Small test helpers shared across the API test modules."""

from __future__ import annotations

from fastapi.testclient import TestClient


def register_user(
    client: TestClient,
    email: str = "user@example.com",
    password: str = "password123",
    name: str = "Test User",
):
    return client.post(
        "/api/v1/auth/register",
        json={"name": name, "email": email, "password": password},
    )
