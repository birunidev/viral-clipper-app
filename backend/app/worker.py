"""Bounded background worker pool for clip jobs.

Design goals under traffic:

1. **Tier priority** — jobs from higher entitlement tiers (Studio > Creator
   > Starter > Free) are picked up first; ties break FIFO. Priority is
   resolved at claim time from the user's permanent tier, so paying users
   never wait behind a free-tier backlog.
2. **Restart safety** — the ``jobs`` table is the source of truth. On
   startup the pool re-enqueues every row still marked ``queued``, and rows
   stuck in ``running`` longer than STALE_RUNNING_MINUTES (a crashed
   process mid-job) are reset to ``queued`` so no job is ever lost.
3. **Backpressure** — the in-memory pending set is capped at
   ``MAX_QUEUE_DEPTH``. Beyond that, ``submit`` raises :class:`QueueFull`
   and the API answers 429, instead of silently accepting hours of lag.

Concurrency stays bounded by ``WORKERS`` threads regardless of queue depth,
so RAM never scales with traffic.
"""

from __future__ import annotations

import os
import queue
import threading
import time

from . import pipeline

DEFAULT_WORKERS = 1
DEFAULT_MAX_QUEUE_DEPTH = 100
STALE_RUNNING_MINUTES = 45


class QueueFull(Exception):
    """Raised when the pending-job budget is exhausted (backpressure)."""


def _worker_count() -> int:
    raw = os.environ.get("WORKERS", "")
    try:
        count = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_WORKERS
    return count if count >= 1 else DEFAULT_WORKERS


def _max_queue_depth() -> int:
    raw = os.environ.get("MAX_QUEUE_DEPTH", "")
    try:
        depth = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_MAX_QUEUE_DEPTH
    return depth if depth >= 1 else DEFAULT_MAX_QUEUE_DEPTH


class WorkerPool:
    """Fixed-size thread pool draining a tier-priority job queue.

    Entries are ``(-tier_rank, submit_seq, job_id)``: higher rank first
    (negated for a min-heap), then submission order. ``submit`` raises
    :class:`QueueFull` past ``MAX_QUEUE_DEPTH`` pending jobs.
    """

    def __init__(self, count: int | None = None, logger=None) -> None:
        self._count = count if count is not None else _worker_count()
        self._queue: queue.PriorityQueue = queue.PriorityQueue(maxsize=_max_queue_depth())
        self._threads: list[threading.Thread] = []
        self._logger = logger
        self._started = False
        self._seq = 0

    def start(self) -> None:
        if self._started:
            return
        self._recover_from_db()
        self._started = True
        for _ in range(self._count):
            thread = threading.Thread(
                target=self._loop,
                name=f"clipzard-worker-{len(self._threads)}",
                daemon=True,
            )
            thread.start()
            self._threads.append(thread)

    def _recover_from_db(self) -> None:
        """Re-enqueue persisted queued jobs; rescue stale running ones.

        Keeps the DB honest after a crash or redeploy: nothing marked
        ``queued`` is ever forgotten just because the process restarted.
        """
        try:
            from . import db

            stale = db.requeue_stale_running_jobs(STALE_RUNNING_MINUTES)
            if stale:
                if self._logger:
                    self._logger.warning(
                        "Reset %d stuck 'running' job(s) back to queued", stale
                    )
            for job_id, rank, created_at in db.queued_jobs_by_priority():
                # Recover in priority order; seq keeps FIFO within a tier.
                self._seq += 1
                ts = created_at.timestamp() if created_at else time.time()
                self._queue.put((-rank, ts, self._seq, job_id))
        except Exception:
            # Never block startup on recovery; rows stay recoverable next boot.
            if self._logger:
                self._logger.exception("Job recovery failed")

    def submit(self, job_id: str) -> None:
        """Enqueue a job ID at its owner's tier priority."""
        rank = self._priority_for(job_id)
        self._seq += 1
        try:
            self._queue.put((-rank, time.time(), self._seq, job_id), block=False)
        except queue.Full:
            raise QueueFull(
                f"Processing queue is full ({_max_queue_depth()} pending jobs)"
            ) from None

    def _priority_for(self, job_id: str) -> int:
        """Owner's entitlement rank; unknown/failed lookups degrade to free."""
        try:
            from . import db

            return db.job_owner_tier_rank(job_id)
        except Exception:
            return 0

    def _loop(self) -> None:
        while True:
            _, _, _, job_id = self._queue.get()
            try:
                pipeline.run_job(job_id)
            except Exception as exc:  # pipeline.run_job never raises, but be safe
                if self._logger:
                    self._logger.exception(f"Worker crashed on job {job_id}: {exc}")
            finally:
                self._queue.task_done()

    def wait(self, timeout: float | None = None) -> None:
        """Block until all submitted jobs are done (used by tests)."""
        self._queue.join()


pool = WorkerPool()
