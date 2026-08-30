#!/usr/bin/env python3
"""Credit-purchase smoke test.

Exercises the cloud credit wallet end-to-end without a real Paddle/Midtrans
integration.  Uses the dev ``/dev/_test/*`` endpoints to simulate
webhook settlements, then verifies the ledger + ``User.credits`` cache
stay in sync and that the spend path enforces a 402 on insufficient
balance.

Steps:
  1. login as a fresh user
  2. wallet balance is 0
  3. POST /dev/_test/purchase-credits?amount_minutes=60&order_id=ord-1  -> 200
  4. balance is 60 minutes
  5. repeat with same order_id=ord-1 -> 200, balance still 60 (idempotent)
  6. POST /dev/_test/spend-credits?amount_minutes=30 -> 200
  7. balance is 30 minutes
  8. spend 100 minutes -> 402

Usage:
    .venv/Scripts/python.exe scripts/smoke_credit_purchase.py
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

BASE = os.environ.get("CLIPZARD_API", "http://127.0.0.1:8765")
API = f"{BASE}/api/v1"
PASS = "[PASS]"
FAIL = "[FAIL]"

results: list[tuple[str, str, str]] = []


def call(
    method: str,
    path: str,
    body: Any = None,
    opener: urllib.request.OpenerDirector | None = None,
    *,
    raw: bool = False,
) -> tuple[int, str, dict]:
    data = json.dumps(body).encode() if body is not None else None
    h = {
        "Content-Type": "application/json",
        "Origin": "https://clipzard.web.id",
    }
    req = urllib.request.Request(f"{API}{path}", data=data, method=method, headers=h)
    send = opener.open if opener is not None else urllib.request.urlopen
    try:
        with send(req, timeout=10) as r:
            return r.status, r.read().decode(errors="replace"), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace"), dict(e.headers)


def step(name: str, ok: bool, detail: str = "") -> None:
    tag = PASS if ok else FAIL
    results.append((name, tag, detail))
    print(f"{tag} {name}  {detail}")


def main() -> int:
    nonce = int(time.time())
    email = f"smoke-credit-{nonce}@clipzard.dev"
    PASSWORD = "smoke-credit-pass"
    # Unique order_id per run so the (source, order_id) idempotency
    # check doesn't resolve to a row from a prior smoke run.
    ORDER_ID = f"smoke-ord-{nonce}"

    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

    # Step 1: login (register then login)
    s, b, _ = call("POST", "/auth/register", {
        "email": email, "password": PASSWORD, "name": "Smoke Credits", "accept_terms": True,
    }, opener=opener)
    if s not in (201, 409):
        step("01 register", False, f"{s} {b[:200]}")
        return 1
    s, b, _ = call("POST", "/auth/login", {"email": email, "password": PASSWORD}, opener=opener)
    step("01 login", s == 200, f"{s} {b[:80]}")

    # Step 2: balance is 0
    s, b, _ = call("GET", "/dev/_test/wallet?email=" + urllib.parse.quote(email), opener=opener)
    body = json.loads(b) if s == 200 else {}
    step("02 balance 0", s == 200 and body.get("balance_minutes") == 0, f"balance={body.get('balance_minutes')}")

    # Step 3: purchase 60 minutes
    s, b, _ = call("POST", "/dev/_test/purchase-credits?email=" + urllib.parse.quote(email) +
                  f"&amount_minutes=60&source=paddle&order_id={ORDER_ID}", opener=opener)
    body = json.loads(b) if s == 200 else {}
    step("03 purchase 60", s == 200 and body.get("ok") is True and body.get("balance_minutes") == 60,
         f"s={s} balance={body.get('balance_minutes')} body={b[:200]}")

    # Step 4: balance now 60
    s, b, _ = call("GET", "/dev/_test/wallet?email=" + urllib.parse.quote(email), opener=opener)
    body = json.loads(b) if s == 200 else {}
    step("04 balance 60", s == 200 and body.get("balance_minutes") == 60, f"balance={body.get('balance_minutes')}")

    # Step 5: idempotent — same order_id returns 200 and balance is still 60
    s, b, _ = call("POST", "/dev/_test/purchase-credits?email=" + urllib.parse.quote(email) +
                  f"&amount_minutes=60&source=paddle&order_id={ORDER_ID}", opener=opener)
    body = json.loads(b) if s == 200 else {}
    s2, b2, _ = call("GET", "/dev/_test/wallet?email=" + urllib.parse.quote(email), opener=opener)
    body2 = json.loads(b2) if s2 == 200 else {}
    step("05 idempotent same order_id",
         s == 200 and body2.get("balance_minutes") == 60 and len(body2.get("ledger", [])) == 1,
         f"re-post s={s} balance={body2.get('balance_minutes')} ledger_rows={len(body2.get('ledger', []))}")

    # Step 6: spend 30 minutes
    s, b, _ = call("POST", "/dev/_test/spend-credits?email=" + urllib.parse.quote(email) +
                  "&amount_minutes=30&purpose=transcribe", opener=opener)
    body = json.loads(b) if s == 200 else {}
    step("06 spend 30", s == 200 and body.get("ok") is True, f"s={s} body={b[:120]}")

    # Step 7: balance is now 30
    s, b, _ = call("GET", "/dev/_test/wallet?email=" + urllib.parse.quote(email), opener=opener)
    body = json.loads(b) if s == 200 else {}
    step("07 balance 30", s == 200 and body.get("balance_minutes") == 30, f"balance={body.get('balance_minutes')}")

    # Step 8: spend 100 minutes -> 402
    s, b, _ = call("POST", "/dev/_test/spend-credits?email=" + urllib.parse.quote(email) +
                  "&amount_minutes=100&purpose=transcribe", opener=opener)
    step("08 spend 100 over balance -> 402", s == 402, f"s={s} body={b[:120]}")

    # Final summary
    passed = sum(1 for _, t, _ in results if t == PASS)
    failed = sum(1 for _, t, _ in results if t == FAIL)
    print()
    print(f"=== {passed} passed, {failed} failed ===")
    if failed:
        print("Failed steps:")
        for n, t, d in results:
            if t == FAIL:
                print(f"  {n}  {d}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
