/**
 * Desktop entitlement gate.
 *
 * Every 6h (and on app start) we call `POST /api/v1/entitlement/check`
 * with a stable per-install `device_id` (a UUIDv4 stored once on
 * first run) and the OS info. The server returns either:
 *
 *   { entitled: true, tier, ..., signed_blob }
 *
 * or
 *
 *   403 with { entitled: false, reason: "no_license" | "device_limit", ... }
 *
 * The signed blob is an HMAC over the canonical-JSON payload. The
 * desktop reproduces the signature locally (using the same
 * `ENTITLEMENT_SIGN_SECRET` baked into the build) and only trusts the
 * cached blob if it matches.  The cache TTL is `cache_max_age_days`
 * from the server (default 7 days); after that the desktop blocks
 * until it can reach the server again.
 *
 * No license keys. No bypasses. The only way to be entitled is to
 * have a valid user session + a license on the server.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { authCookieHeader, currentSession, logout, type MeUser } from "./auth.js";
import { userDataRoot } from "./userData.js";

const API_URL = (() => {
  if (process.env.CLIPZARD_API_URL) return process.env.CLIPZARD_API_URL.replace(/\/+$/, "");
  if (!app.isPackaged) return "http://127.0.0.1:8000/api/v1";
  return "https://clipzard.web.id/api/v1";
})();

export type EntitlementPayload = {
  entitled: boolean;
  tier: string;
  max_devices: number;
  current_device_count: number;
  expires_at: string | null;
  credits: number;
  cloud_enabled: boolean;
  server_time: string;
  cache_max_age_days: number;
};

export type CachedEntitlement = {
  payload: EntitlementPayload;
  signed_blob: string;
  cached_at: string;
};

export type DenyReason = "no_license" | "device_limit" | "revoked" | "no_session" | "offline_expired" | "tampered" | "network";

export type EntitlementStatus =
  | { ok: true; payload: EntitlementPayload; cached: boolean; age_days: number }
  | { ok: false; reason: DenyReason; message: string; max_devices?: number; current_device_count?: number };

function _deviceIdFile(): string {
  return path.join(userDataRoot(), "device.id");
}

export function getDeviceId(): string {
  const f = _deviceIdFile();
  try {
    const existing = fs.readFileSync(f, "utf-8").trim();
    if (existing) return existing;
  } catch {}
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, id, "utf-8");
  } catch {}
  return id;
}

function getDeviceName(): string {
  return `${os.hostname()}`;
}

function getOs(): string {
  return os.platform();
}

function _entCacheFile(): string {
  return path.join(userDataRoot(), "entitlement_cache.json");
}

function _signingSecret(): string {
  // Same secret as the backend's `ENTITLEMENT_SIGN_SECRET`.  In
  // production this is baked into the build via electron-builder's
  // `extraResources` and loaded here at runtime. In dev we read
  // the env var to keep parity.
  if (process.env.ENTITLEMENT_SIGN_SECRET) return process.env.ENTITLEMENT_SIGN_SECRET;
  // In packaged builds, look for a sibling resource file.
  try {
    const p = path.join(process.resourcesPath ?? "", "entitlement_sign_secret");
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8").trim();
  } catch {}
  return "";
}

function _canonicalJson(value: unknown): string {
  // Match Python's `json.dumps(..., sort_keys=True, separators=(",", ":"))`:
  // sort keys, no whitespace, UTF-8, no escape of non-ASCII.
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(_canonicalJson).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + _canonicalJson(obj[k]));
  return "{" + parts.join(",") + "}";
}

function _signPayload(payload: EntitlementPayload): string {
  const secret = _signingSecret();
  if (!secret) return "";
  const body = _canonicalJson(payload);
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function _verifyPayload(payload: EntitlementPayload, expected: string): boolean {
  const actual = _signPayload(payload);
  if (!actual || !expected) return false;
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function _loadCache(): CachedEntitlement | null {
  try {
    const raw = fs.readFileSync(_entCacheFile(), "utf-8");
    return JSON.parse(raw) as CachedEntitlement;
  } catch {
    return null;
  }
}

function _saveCache(c: CachedEntitlement): void {
  try {
    fs.mkdirSync(path.dirname(_entCacheFile()), { recursive: true });
    fs.writeFileSync(_entCacheFile(), JSON.stringify(c), "utf-8");
  } catch {}
}

function _clearCache(): void {
  try {
    if (fs.existsSync(_entCacheFile())) fs.unlinkSync(_entCacheFile());
  } catch {}
}

export function clearEntitlementCache(): void {
  _clearCache();
}

const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000; // 6h

let _lastCheckAt = 0;
let _lastStatus: EntitlementStatus | null = null;

export async function checkEntitlement(force = false): Promise<EntitlementStatus> {
  const session = currentSession();
  if (!session) {
    _clearCache();
    return { ok: false, reason: "no_session", message: "Not signed in." };
  }
  const now = Date.now();
  if (!force && _lastStatus && now - _lastCheckAt < 5_000) {
    return _lastStatus;
  }

  // Call the server.
  let res: Response;
  try {
    res = await fetch(`${API_URL}/entitlement/check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookieHeader(),
      },
      body: JSON.stringify({
        device_id: getDeviceId(),
        device_name: getDeviceName(),
        os: getOs(),
      }),
    });
  } catch (e) {
    // Network error — fall back to cache.
    return _fromCacheOrFail(String((e as Error)?.message ?? e));
  }

  if (res.status === 401) {
    // Session expired — clear and bounce.
    await logout();
    return { ok: false, reason: "no_session", message: "Session expired. Please sign in again." };
  }
  if (res.status === 403) {
    let body: { reason?: string; max_devices?: number; current_device_count?: number } = {};
    try {
      body = await res.json();
    } catch {}
    _lastCheckAt = now;
    _lastStatus = {
      ok: false,
      reason: (body.reason as DenyReason) ?? "no_license",
      message: body.reason === "device_limit"
        ? `Device limit reached (${body.current_device_count}/${body.max_devices}). Revoke a device on the web to free a seat.`
        : "No active license. Buy one at clipzard.web.id to use ClipZard.",
      max_devices: body.max_devices,
      current_device_count: body.current_device_count,
    };
    return _lastStatus;
  }
  if (!res.ok) {
    return _fromCacheOrFail(`Server returned ${res.status}`);
  }
  const body = (await res.json()) as { payload?: EntitlementPayload; signed_blob?: string };
  if (!body.payload || !body.signed_blob) {
    return _fromCacheOrFail("Server response missing signed blob.");
  }
  if (!_verifyPayload(body.payload, body.signed_blob)) {
    return {
      ok: false,
      reason: "tampered",
      message: "Server response signature did not verify. Refusing to cache.",
    };
  }
  const cached: CachedEntitlement = {
    payload: body.payload,
    signed_blob: body.signed_blob,
    cached_at: new Date().toISOString(),
  };
  _saveCache(cached);
  _lastCheckAt = now;
  _lastStatus = { ok: true, payload: body.payload, cached: false, age_days: 0 };
  return _lastStatus;
}

function _fromCacheOrFail(networkMessage: string): EntitlementStatus {
  const cached = _loadCache();
  if (!cached) {
    return { ok: false, reason: "network", message: networkMessage };
  }
  if (!_verifyPayload(cached.payload, cached.signed_blob)) {
    _clearCache();
    return { ok: false, reason: "tampered", message: "Cached entitlement blob is invalid." };
  }
  const ageMs = Date.now() - new Date(cached.cached_at).getTime();
  const ageDays = ageMs / 86_400_000;
  const maxAge = cached.payload.cache_max_age_days || 7;
  if (ageDays > maxAge) {
    return {
      ok: false,
      reason: "offline_expired",
      message: `Offline cache expired (${ageDays.toFixed(1)}d > ${maxAge}d). Reconnect to verify.`,
    };
  }
  _lastCheckAt = Date.now();
  _lastStatus = { ok: true, payload: cached.payload, cached: true, age_days: ageDays };
  return _lastStatus;
}

export async function ensureFreshCheck(): Promise<EntitlementStatus> {
  const cached = _loadCache();
  if (!cached) return checkEntitlement(true);
  const ageMs = Date.now() - new Date(cached.cached_at).getTime();
  if (ageMs > REFRESH_AFTER_MS) return checkEntitlement(true);
  return _fromCacheOrFail("");
}

export function isEntitledSync(): boolean {
  const cached = _loadCache();
  if (!cached) return false;
  if (!_verifyPayload(cached.payload, cached.signed_blob)) return false;
  const ageMs = Date.now() - new Date(cached.cached_at).getTime();
  const maxAge = cached.payload.cache_max_age_days || 7;
  return ageMs <= maxAge * 86_400_000;
}
