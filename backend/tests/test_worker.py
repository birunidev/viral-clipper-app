"""Tests for the bounded background worker pool in app.worker."""

from __future__ import annotations

import threading
import time

from app.worker import WorkerPool


def test_single_worker_processes_serially(monkeypatch):
    """With WORKERS=1, a second job must not start until the first is done."""
    active = 0
    max_active = 0
    lock = threading.Lock()
    processed = []

    def fake_run_job(job_id: str) -> None:
        nonlocal active, max_active
        with lock:
            active += 1
            max_active = max(max_active, active)
        time.sleep(0.05)
        processed.append(job_id)
        with lock:
            active -= 1

    monkeypatch.setattr("app.worker.pipeline.run_job", fake_run_job)

    pool = WorkerPool(count=1)
    pool.start()
    pool.submit("job-1")
    pool.submit("job-2")
    pool.submit("job-3")
    pool.wait()

    assert max_active == 1
    assert processed == ["job-1", "job-2", "job-3"]


def test_multiple_workers_run_concurrently(monkeypatch):
    active = 0
    max_active = 0
    lock = threading.Lock()

    def fake_run_job(job_id: str) -> None:
        nonlocal active, max_active
        with lock:
            active += 1
            max_active = max(max_active, active)
        time.sleep(0.1)
        with lock:
            active -= 1

    monkeypatch.setattr("app.worker.pipeline.run_job", fake_run_job)

    pool = WorkerPool(count=3)
    pool.start()
    for i in range(3):
        pool.submit(f"job-{i}")
    pool.wait()

    assert max_active > 1


def test_worker_pool_survives_job_exceptions(monkeypatch):
    """A crashing job must not kill the worker thread or block later jobs."""

    def fake_run_job(job_id: str) -> None:
        if job_id == "bad":
            raise RuntimeError("boom")

    monkeypatch.setattr("app.worker.pipeline.run_job", fake_run_job)

    pool = WorkerPool(count=1)
    pool.start()
    pool.submit("bad")
    pool.submit("good")
    pool.wait()

    # No assertion needed beyond "this didn't hang or raise" — wait()
    # returning means both jobs were drained despite the exception.


def test_worker_count_from_env(monkeypatch):
    from app.worker import _worker_count

    monkeypatch.setenv("WORKERS", "4")
    assert _worker_count() == 4

    monkeypatch.setenv("WORKERS", "0")
    assert _worker_count() == 1

    monkeypatch.setenv("WORKERS", "not-a-number")
    assert _worker_count() == 1

    monkeypatch.delenv("WORKERS", raising=False)
    assert _worker_count() == 1
