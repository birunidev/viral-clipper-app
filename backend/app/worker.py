"""Bounded background worker pool for clip jobs.

Local models (whisper.cpp STT, Ollama LLM) are GPU/CPU/RAM-bound and share
one machine, so jobs must never run unbounded. This module runs a fixed
number of worker threads (``WORKERS``, default 1) that drain a queue of
job IDs. Workers pick up a job, run the full pipeline, then look for the
next one.

Model residency is managed by the pipeline itself: whisper.cpp models are
loaded per job and released immediately after transcription, and the LLM
(Ollama) is configured with a short ``OLLAMA_KEEP_ALIVE`` so neither model
stays resident once a job finishes. On a 16GB laptop the two should never
be in memory at the same time.
"""

from __future__ import annotations

import os
import queue
import threading

from . import pipeline

DEFAULT_WORKERS = 1


def _worker_count() -> int:
    raw = os.environ.get("WORKERS", "")
    try:
        count = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_WORKERS
    return count if count >= 1 else DEFAULT_WORKERS


class WorkerPool:
    """A pool of daemon threads that run jobs from a FIFO queue.

    Jobs are job IDs as strings. ``submit`` enqueues a job; workers pull
    from the queue, so only ``WORKERS`` jobs run at a time (default 1 —
    the right value whenever local models are in play).
    """

    def __init__(self, count: int | None = None, logger=None) -> None:
        self._count = count if count is not None else _worker_count()
        self._queue: queue.Queue[str] = queue.Queue()
        self._threads: list[threading.Thread] = []
        self._logger = logger
        self._started = False

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        for _ in range(self._count):
            thread = threading.Thread(
                target=self._loop,
                name=f"clipforge-worker-{len(self._threads)}",
                daemon=True,
            )
            thread.start()
            self._threads.append(thread)

    def submit(self, job_id: str) -> None:
        """Enqueue a job ID for processing."""
        self._queue.put(job_id)

    def _loop(self) -> None:
        while True:
            job_id = self._queue.get()
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
