"""Tests for the tier-priority worker queue (worker.py + db helpers)."""

from __future__ import annotations

import threading

import pytest

from app import db, worker
from core import billing
from helpers import register_user


def _tiered_users(client, *emails_and_tiers):
    """Register users and grant packs so their tiers differ."""
    out = []
    for email, pack in emails_and_tiers:
        register_user(client, email=email)
        uid = db.get_user_by_email(email)["id"]
        if pack:
            billing.grant_pack(uid, pack)
        out.append((uid, pack or "free"))
    return out


@pytest.fixture()
def fake_pipeline(monkeypatch):
    """Replace pipeline.run_job with a recorder; returns the run order list."""
    order = []
    started = threading.Event()

    def fake_run(job_id):
        order.append(job_id)

    monkeypatch.setattr("app.pipeline.run_job", fake_run)
    return order


def test_priority_picks_higher_tier_first(client, monkeypatch):
    """Queued jobs are claimed Studio > Creator > Starter > Free, even when
    the free-tier job was persisted first."""
    users = _tiered_users(
        client,
        ("free1@example.com", None),      # rank 0
        ("starter@example.com", "starter"),
        ("creator@example.com", "creator"),
        ("studio@example.com", "studio"),
    )
    # Persist jobs worst-tier-first.
    for uid, _ in users:
        p = db.create_project(uid, "P", "https://youtu.be/abc", "youtube")
        db.create_job(p["id"], {}, job_type="analyze")

    job_tiers = {j["id"]: tier for j, (u, tier) in [
        (db.get_job(jid), t) for jid, t in []
    ]} if False else None

    ran = []
    monkeypatch.setattr(worker.pipeline, "run_job", lambda jid: ran.append(jid))

    fresh = worker.WorkerPool()  # start() recovers from DB in priority order
    fresh.start()
    try:
        fresh.wait(timeout=30)

        tiers_in_order = []
        for jid in ran:
            job = db.get_job(jid)
            if not job:
                continue
            owner_id = db.get_project(job["project_id"])["user_id"]
            for uid, tier in users:
                if uid == owner_id:
                    tiers_in_order.append(tier)
        assert tiers_in_order == ["studio", "creator", "starter", "free"]
    finally:
        pass


def test_queue_full_raises_when_saturated(client, monkeypatch):
    monkeypatch.setenv("MAX_QUEUE_DEPTH", "2")
    # Fresh pool honoring the new depth.
    pool = worker.WorkerPool(count=0)
    blocking = threading.Event()
    monkeypatch.setattr(worker.pipeline, "run_job", lambda jid: blocking.wait())

    pool.start()
    try:
        pool.submit("job-1")
        pool.submit("job-2")
        with pytest.raises(worker.QueueFull):
            pool.submit("job-3")
    finally:
        blocking.set()


def test_start_recovers_queued_jobs_from_db(client, monkeypatch):
    """Jobs persisted as 'queued' survive a process restart: a fresh pool
    picks them up at startup."""
    register_user(client, email="recover@example.com")
    uid = db.get_user_by_email("recover@example.com")["id"]
    project = db.create_project(uid, "P", "https://youtu.be/abc", "youtube")
    job = db.create_job(project["id"], {}, job_type="analyze")
    assert job["status"] == "queued"

    ran = []
    monkeypatch.setattr(worker.pipeline, "run_job", lambda jid: ran.append(jid))
    fresh = worker.WorkerPool()  # start() triggers DB recovery
    fresh.start()
    try:
        fresh.wait(timeout=30)
        assert job["id"] in ran
    finally:
        pass


def test_stale_running_jobs_are_reset_to_queued(client):
    register_user(client, email="stale@example.com")
    uid = db.get_user_by_email("stale@example.com")["id"]
    project = db.create_project(uid, "P", "https://youtu.be/abc", "youtube")
    job = db.create_job(project["id"], {}, job_type="analyze")
    db.update_job(job["id"], status="running", stage="transcribing", progress=40)

    reset = db.requeue_stale_running_jobs(max_minutes=45)
    assert reset == 0  # not stale yet

    # Backdate past the stale threshold.
    import datetime as dt

    from app.database import session_scope
    from app.models import Job

    old = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=60)
    with session_scope() as s:
        s.get(Job, job["id"]).updated_at = old

    assert db.requeue_stale_running_jobs(max_minutes=45) >= 1
    assert db.get_job(job["id"])["status"] == "queued"
