#!/usr/bin/env python3
"""License-purchase smoke test.

Exercises the desktop license grant path end-to-end without a real
Paddle/Midtrans webhook.  Uses the dev ``/dev/_test/grant-license``
endpoint to simulate the settlement, then verifies:

  1. login as a fresh user
  2. /entitlement/check -> 403 no_license
  3. POST /dev/_test/grant-license?plan=unlimited -> 200
  4. wallet balance is 60 (auto-bundle on first license)
  5. /entitlement/check -> 200, tier=unlimited, signed_blob present
  6. revoke via POST /licenses/{id}/revoke -> 200, /entitlement/check -> 403 again

Usage:
    .venv/Scripts/python.exe scripts/smoke_license_purchase.py
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
    email = f"smoke-license-{int(time.time())}@clipzard.dev"
    PASSWORD = "smoke-license-pass"
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

    # Step 1: login
    s, b, _ = call("POST", "/auth/register", {
        "email": email, "password": PASSWORD, "name": "Smoke License", "accept_terms": True,
    }, opener=opener)
    if s not in (201, 409):
        step("01 register", False, f"{s} {b[:200]}")
        return 1
    s, b, _ = call("POST", "/auth/login", {"email": email, "password": PASSWORD}, opener=opener)
    step("01 login", s == 200, f"{s} {b[:80]}")

    # Step 2: entitlement check -> 403 no_license
    s, b, _ = call("POST", "/entitlement/check", {
        "device_id": "smoke-device-001",
        "device_name": "Smoke Test Device",
        "os": "win32",
    }, opener=opener)
    body = json.loads(b) if b else {}
    step("02 entitlement no_license", s == 403 and body.get("reason") == "no_license",
         f"s={s} body={b[:160]}")

    # Step 3: grant license
    s, b, _ = call("POST", f"/dev/_test/grant-license?email={urllib.parse.quote(email)}&plan=unlimited",
                  opener=opener)
    body = json.loads(b) if s == 200 else {}
    license_id = body.get("license_id", "")
    bundle_id = body.get("bundle_id", "")
    step("03 grant license",
         s == 200 and bool(license_id) and bool(bundle_id),
         f"s={s} license_id={license_id[:16] if license_id else 'None'} bundle_id={bundle_id[:16] if bundle_id else 'None'}")

    # Step 4: wallet balance is 60 (auto-bundle on first license)
    s, b, _ = call("GET", f"/dev/_test/wallet?email={urllib.parse.quote(email)}", opener=opener)
    body = json.loads(b) if s == 200 else {}
    step("04 bundle grants 60 credits",
         s == 200 and body.get("balance_minutes") == 60,
         f"balance={body.get('balance_minutes')}")

    # Step 5: entitlement check now -> 200 entitled
    s, b, _ = call("POST", "/entitlement/check", {
        "device_id": "smoke-device-001",
        "device_name": "Smoke Test Device",
        "os": "win32",
    }, opener=opener)
    body = json.loads(b) if s == 200 else {}
    step("05 entitlement entitled",
         s == 200 and body.get("entitled") is True and body.get("tier") == "unlimited" and bool(body.get("signed_blob")),
         f"s={s} tier={body.get('tier')} signed_blob={'YES' if body.get('signed_blob') else 'NO'}")

    # Step 6: revoke -> 200, then check -> 403
    s, b, _ = call("POST", f"/licenses/{license_id}/revoke", {"reason": "smoke_test"}, opener=opener)
    step("06a revoke license", s == 200, f"s={s} body={b[:120]}")
    s, b, _ = call("POST", "/entitlement/check", {
        "device_id": "smoke-device-001",
        "device_name": "Smoke Test Device",
        "os": "win32",
    }, opener=opener)
    body = json.loads(b) if b else {}
    step("06b entitlement after revoke -> 403",
         s == 403 and body.get("reason") in ("no_license", "revoked"),
         f"s={s} reason={body.get('reason')}")

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
