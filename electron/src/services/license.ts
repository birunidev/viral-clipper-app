import { getRaw, nowIso } from "./db.js";
import crypto from "node:crypto";
import os from "node:os";

let _isPackaged: boolean | null = null;
function isDevBypass(): boolean {
  if (_isPackaged !== null) return !_isPackaged;
  try {
    const { app } = require("electron") as { app: { isPackaged: boolean } };
    _isPackaged = app.isPackaged;
    return !_isPackaged;
  } catch {
    return process.env.NODE_ENV === "development";
  }
}

const VERIFY_URL = process.env.LICENSE_VERIFY_URL ?? "https://clipforge.com/api/license/verify";
const GRACE_DAYS = 30;

function deviceHash(): string {
  const raw = `${os.hostname()}:${os.platform()}:${os.arch()}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

const FALLBACK_URLS = ["http://localhost:3005/api/license/verify", "http://localhost:8000/api/v1/license/verify"];

async function fetchLicense(url: string, key: string, email?: string): Promise<{ valid?: boolean; message?: string; signature?: string; tier?: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ licenseKey: key, email: email ?? undefined, deviceHash: deviceHash() }),
  });
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (!ct.includes("application/json")) {
    throw new Error(`License server returned non-JSON (${res.status}): ${text.slice(0, 120)} — is ${url} running?`);
  }
  try {
    return JSON.parse(text) as { valid?: boolean; message?: string; signature?: string; tier?: string };
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 120)}`);
  }
}

export async function verifyLicense(licenseKey: string, email?: string): Promise<{ valid: boolean; message?: string }> {
  const key = licenseKey.trim();
  if (!key) return { valid: false, message: "empty key" };
  const urls = [VERIFY_URL, ...FALLBACK_URLS.filter((u) => u !== VERIFY_URL)];
  let lastErr: unknown = null;
  for (const url of urls) {
    try {
      const data = await fetchLicense(url, key, email);
      const valid = !!data.valid;
      const db = getRaw();
      const now = nowIso();
      const expires = new Date(Date.now() + GRACE_DAYS * 24 * 3600 * 1000).toISOString();
      db.prepare("INSERT OR REPLACE INTO license_cache (id, license_key, email, valid, verified_at, expires_at, payload) VALUES (?,?,?,?,?,?,?)")
        .run("singleton", key, email ?? null, valid ? 1 : 0, now, expires, JSON.stringify(data));
      if (!valid) return { valid, message: data.message ?? `Invalid license at ${url}` };
      return { valid, message: data.message };
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error).message ?? e);
      if (msg.includes("non-JSON") || msg.includes("404") || msg.includes("ECONNREFUSED") || msg.includes("Failed to fetch")) continue;
      break;
    }
  }
  const cached = getRaw().prepare("SELECT * FROM license_cache WHERE id=?").get("singleton") as Record<string, unknown> | undefined;
  if (cached && Number(cached.valid) === 1) {
    const exp = String(cached.expires_at ?? "");
    if (exp && new Date(exp).getTime() > Date.now()) return { valid: true, message: "offline grace" };
  }
  return { valid: false, message: String((lastErr as Error)?.message ?? lastErr ?? "License server unreachable — set LICENSE_VERIFY_URL=http://localhost:3005/api/license/verify for local dev") };
}

export function isLicensed(): boolean {
  if (isDevBypass()) return true;
  const row = getRaw().prepare("SELECT * FROM license_cache WHERE id=?").get("singleton") as Record<string, unknown> | undefined;
  if (!row || Number(row.valid) !== 1) return false;
  const exp = String(row.expires_at ?? "");
  if (exp && new Date(exp).getTime() < Date.now()) return false;
  return true;
}

export function getLicense() {
  return getRaw().prepare("SELECT * FROM license_cache WHERE id=?").get("singleton") as Record<string, unknown> | undefined;
}
