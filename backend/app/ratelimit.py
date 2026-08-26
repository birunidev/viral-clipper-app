"""Lightweight fixed-window rate limiter for credential endpoints.

No Redis / external dependency: an in-process token bucket per key
(e.g. ``login:<ip>:<email>``). Sized for the single-process uvicorn
deployment this app ships as; if you ever scale to multiple workers,
move the counters to Postgres or Redis — the interface stays the same.

OWASP A07: online password guessing and registration spam are the
cheapest attacks against any public auth endpoint; Argon2 alone only
slows them down.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque


class RateLimitExceeded(Exception):
    """Raised when too many attempts hit a bucket within its window."""


class _Window:
    __slots__ = ("hits",)

    def __init__(self) -> None:
        self.hits: deque[float] = deque()


class RateLimiter:
    def __init__(self) -> None:
        self._buckets: dict[str, _Window] = defaultdict(_Window)
        self._lock = threading.Lock()

    def check(self, key: str, limit: int, window_seconds: int) -> None:
        """Record one attempt for ``key``; raise when over ``limit`` per window.

        Old hits are pruned lazily; empty buckets are dropped on prune so
        memory stays bounded to active traffic.
        """
        now = time.monotonic()
        with self._lock:
            bucket = self._buckets[key]
            hits = bucket.hits
            while hits and now - hits[0] > window_seconds:
                hits.popleft()
            if len(hits) >= limit:
                # Report when the oldest hit leaves the window.
                retry_after = max(1, int(window_seconds - (now - hits[0])))
                raise RateLimitExceeded(retry_after)
            hits.append(now)
            if not hits:  # pragma: no cover - defensive
                self._buckets.pop(key, None)
            # Opportunistic global prune (cheap, amortized).
            if len(self._buckets) > 10_000:
                stale = [k for k, v in self._buckets.items() if not v.hits]
                for k in stale:
                    self._buckets.pop(k, None)


limiter = RateLimiter()
