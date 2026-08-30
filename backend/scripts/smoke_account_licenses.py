#!/usr/bin/env python3
"""Account / License / Entitlement smoke test.

Runs against the locally-running backend (default 127.0.0.1:8765) and
exercises every step of the user-account infrastructure: registration,
password reset, login, entitlement check, license list/revoke/reissue,
device cap, debug-only helpers.

Usage:
    .venv/Scripts/python.exe scripts/smoke_account_licenses.py
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

BASE = os.environ.get("CLIPZARD_API", "http://127.0.0.1:8765")
API = f"{BASE}/api/v1"
# Log path: try both Windows native and POSIX views, prefer newest
LOG_CANDIDATES = [
    os.environ.get("CLIPZARD_SMOKE_LOG", ""),
    os.path.join(os.environ.get("TEMP", ""), "clipzard-smoke.log"),
    os.path.join(os.environ.get("TMP", ""), "clipzard-smoke.log"),
    r"C:\Users\AL EL FAMILY\AppData\Local\Temp\clipzard-smoke.log",
    r"D:\tmp\clipzard-smoke.log",
    r"C:\tmp\clipzard-smoke.log",
    "/tmp/clipzard-smoke.log",
    "/c/tmp/clipzard-smoke.log",
    "/d/tmp/clipzard-smoke.log",
]


def _read_log() -> str:
    for p in LOG_CANDIDATES:
        if p and os.path.exists(p):
            return open(p, errors="replace").read()
    return ""

PASS = "[PASS]"
FAIL = "[FAIL]"

results: list[tuple[str, str, str]] = []


def step(name: str, ok: bool, detail: str = "") -> None:
    tag = PASS if ok else FAIL
    results.append((name, tag, detail))
    print(f"{tag} {name}  {detail}")


def call(
    method: str,
    path: str,
    body: Any = None,
    opener: urllib.request.OpenerDirector | None = None,
) -> tuple[int, str, dict]:
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json", "Origin": "https://clipzard.web.id"}
    req = urllib.request.Request(f"{API}{path}", data=data, method=method, headers=h)
    send = opener.open if opener is not None else urllib.request.urlopen
    try:
        with send(req, timeout=10) as r:
            return r.status, r.read().decode(errors="replace"), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace"), dict(e.headers)


def main() -> int:
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

    # Step 1: /health (root, not /api/v1)
    req = urllib.request.Request(f"{BASE}/health", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            s, b = r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        s, b = e.code, e.read().decode(errors="replace")
    step("01 health", s == 200 and "ok" in b, f"{s} {b[:60]}")

    # Step 2: register
    email = f"smoke-{int(time.time())}@test.com"
    s, b, _ = call("POST", "/auth/register", {
        "email": email, "password": "oldpass12345", "name": "Smoke", "accept_terms": True,
    }, opener=opener)
    step("02 register", s in (201, 409), f"{s} {b[:80]}")

    # Step 3: login
    s, b, _ = call("POST", "/auth/login", {"email": email, "password": "oldpass12345"}, opener=opener)
    step("03 login", s == 200, f"{s} {b[:80]}")
    cookies = [c.name for c in cj]
    step("03b session cookie set", "clipzard_session" in cookies, str(cookies))

    # Step 4: /auth/me
    s, b, _ = call("GET", "/auth/me", opener=opener)
    me = json.loads(b) if s == 200 else {}
    step("04 me", s == 200 and me.get("email") == email, f"{s} {b[:80]}")

    # Step 5: /auth/me shows no license
    step("05 me no license", me.get("has_license") is False, f"has_license={me.get('has_license')}")

    # Step 6: entitlement denied (no license)
    s, b, _ = call("POST", "/entitlement/check", {
        "device_id": "laptop-001", "device_name": "Test Laptop", "os": "win32",
    }, opener=opener)
    body = json.loads(b) if b else {}
    step("06 entitlement no_license", s == 403 and body.get("reason") == "no_license", f"{s} {b[:120]}")

    # Step 7: seed license
    s, b, _ = call("GET", f"/dev/_test/seed-license?email={urllib.parse.quote(email)}&plan=unlimited")
    seed = json.loads(b) if s == 200 else {}
    step("07 seed-license", s == 200 and seed.get("ok") is True and seed.get("license_id"), f"{s} {b[:160]}")
    license_id = seed.get("license_id", "")

    # Step 8: /auth/me now has license
    s, b, _ = call("GET", "/auth/me", opener=opener)
    me = json.loads(b) if s == 200 else {}
    step("08 me with license", s == 200 and me.get("has_license") is True and me.get("license_tier") == "unlimited", f"{s} {b[:160]}")

    # Step 9-12: 3 devices OK
    last_body: dict = {}
    for i, dev in enumerate(["laptop-001", "desktop-002", "macbook-003"]):
        s, b, _ = call("POST", "/entitlement/check", {
            "device_id": dev, "device_name": f"Dev {dev}", "os": "win32",
        }, opener=opener)
        body = json.loads(b) if b else {}
        last_body = body
        ok = s == 200 and body.get("entitled") is True and body.get("signed_blob")
        step(f"09.{i+1} entitlement device {dev}", ok, f"{s} tier={body.get('tier')} current={body.get('current_device_count')}/{body.get('max_devices')} signed={bool(body.get('signed_blob'))}")

    # Step 10: re-check first device (idempotent, no new seat)
    s2, b2, _ = call("POST", "/entitlement/check", {
        "device_id": "laptop-001", "device_name": "Dev laptop-001", "os": "win32",
    }, opener=opener)
    body2 = json.loads(b2) if b2 else {}
    step("10 same device no new seat", s2 == 200 and body2.get("current_device_count") == 3, f"{s2} current={body2.get('current_device_count')}")

    # Step 11: 4th device denied
    s, b, _ = call("POST", "/entitlement/check", {
        "device_id": "linux-004", "device_name": "Linux", "os": "linux",
    }, opener=opener)
    body = json.loads(b) if b else {}
    step("11 device cap", s == 403 and body.get("reason") == "device_limit" and body.get("current_device_count") == 3, f"{s} {b[:160]}")

    # Step 12: list licenses
    s, b, _ = call("GET", "/licenses/me", opener=opener)
    body = json.loads(b) if s == 200 else {}
    lic_count = len(body.get("licenses", []))
    step("12 list licenses", s == 200 and lic_count == 1, f"{s} licenses={lic_count}")

    # Step 13: list devices under license
    s, b, _ = call("GET", f"/licenses/{license_id}/devices", opener=opener)
    body = json.loads(b) if s == 200 else {}
    dev_count = len(body.get("devices", []))
    step("13 list devices", s == 200 and dev_count == 3, f"{s} devices={dev_count}")
    first_device_id = body["devices"][0]["id"] if body.get("devices") else None

    # Step 14: revoke one device
    s, b, _ = call("POST", f"/devices/{first_device_id}/revoke", opener=opener)
    step("14 revoke device", s == 200, f"{s} {b}")

    # Step 15: 4th device now allowed
    s, b, _ = call("POST", "/entitlement/check", {
        "device_id": "linux-004", "device_name": "Linux", "os": "linux",
    }, opener=opener)
    body = json.loads(b) if b else {}
    step("15 device allowed after revoke", s == 200 and body.get("entitled") is True, f"{s} {b[:120]}")

    # Step 16: reissue license
    s, b, _ = call("POST", f"/licenses/{license_id}/reissue", opener=opener)
    body = json.loads(b) if s == 200 else {}
    new_lic = body.get("new_license_id", "")
    step("16 reissue license", s == 200 and new_lic and new_lic != license_id, f"{s} new={new_lic[:16]}")

    # Step 17: old license has reissued_at
    s, b, _ = call("GET", "/licenses/me", opener=opener)
    body = json.loads(b) if s == 200 else {}
    old = next((l for l in body.get("licenses", []) if l["id"] == license_id), None)
    step("17 old license stamped", s == 200 and old and old.get("reissued_at") and old.get("is_active") is False, f"{s} reissued_at={old and old.get('reissued_at')}")

    # Step 18: new license is active
    new = next((l for l in body.get("licenses", []) if l["id"] == new_lic), None)
    step("18 new license active", s == 200 and new and new.get("is_active") is True, f"{s} active={new and new.get('is_active')}")

    # Step 19: reissue chain (new license points back to old)
    step("19 reissue chain", s == 200 and new and new.get("reissued_from_id") == license_id, f"{s} from={new and new.get('reissued_from_id')[:16] if new else None}")

    # Step 20: password reset request
    s, b, _ = call("POST", "/auth/password/reset-request", {"email": email})
    step("20 reset-request", s == 202 and json.loads(b).get("ok") is True, f"{s} {b}")

    # Step 21: read raw token from server log (SMTP fallback)
    time.sleep(0.5)
    log = _read_log()
    links = re.findall(r"/app/reset-password\?token=([A-Za-z0-9_-]+)", log)
    raw_token = links[-1] if links else None
    step("21 raw token in log", raw_token is not None, f"token={'YES' if raw_token else 'NO'}")

    # Step 22: dev reset-link endpoint
    s, b, _ = call("GET", f"/dev/_test/reset-link?email={urllib.parse.quote(email)}")
    step("22 dev reset-link", s == 200 and json.loads(b).get("ok") is True, f"{s} {b}")

    # Step 23: confirm reset
    if raw_token:
        s, b, _ = call("POST", "/auth/password/reset-confirm", {"token": raw_token, "new_password": "newpass98765"})
        step("23 reset-confirm", s == 200, f"{s} {b}")
    else:
        step("23 reset-confirm", False, "no token")

    # Step 24: login with new password (clear cookies first)
    cj.clear()
    s, b, _ = call("POST", "/auth/login", {"email": email, "password": "newpass98765"}, opener=opener)
    step("24 login(new pass)", s == 200, f"{s} {b[:80]}")

    # Step 25: login with old password fails
    cj.clear()
    s, b, _ = call("POST", "/auth/login", {"email": email, "password": "oldpass12345"}, opener=opener)
    step("25 login(old pass) 401", s == 401, f"{s} {b[:80]}")

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
