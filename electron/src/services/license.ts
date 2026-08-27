import { getRaw, nowIso } from "./db.js";
import crypto from "node:crypto";
import os from "node:os";

const VERIFY_URL = process.env.LICENSE_VERIFY_URL ?? "https://clipforge.com/api/license/verify";
const GRACE_DAYS = 30;

function deviceHash(): string {
  const raw = `${os.hostname()}:${os.platform()}:${os.arch()}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export async function verifyLicense(licenseKey: string, email?: string): Promise<{ valid: boolean; message?: string }> {
  const key = licenseKey.trim();
  if (!key) return { valid: false, message: "empty key" };
  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey: key, email: email ?? undefined, deviceHash: deviceHash() }),
    });
    const data = await res.json() as { valid?: boolean; message?: string; signature?: string; tier?: string };
    const valid = !!data.valid;
    const db = getRaw();
    const now = nowIso();
    const expires = new Date(Date.now() + GRACE_DAYS * 24 * 3600 * 1000).toISOString();
    db.prepare("INSERT OR REPLACE INTO license_cache (id, license_key, email, valid, verified_at, expires_at, payload) VALUES (?,?,?,?,?,?,?)")
      .run("singleton", key, email ?? null, valid ? 1 : 0, now, expires, JSON.stringify(data));
    return { valid, message: data.message };
  } catch (e) {
    const cached = getRaw().prepare("SELECT * FROM license_cache WHERE id=?").get("singleton") as Record<string, unknown> | undefined;
    if (cached && Number(cached.valid) === 1) {
      const exp = String(cached.expires_at ?? "");
      if (exp && new Date(exp).getTime() > Date.now()) return { valid: true, message: "offline grace" };
    }
    return { valid: false, message: String((e as Error).message ?? e) };
  }
}

export function isLicensed(): boolean {
  const row = getRaw().prepare("SELECT * FROM license_cache WHERE id=?").get("singleton") as Record<string, unknown> | undefined;
  if (!row || Number(row.valid) !== 1) return false;
  const exp = String(row.expires_at ?? "");
  if (exp && new Date(exp).getTime() < Date.now()) return false;
  return true;
}

export function getLicense() {
  return getRaw().prepare("SELECT * FROM license_cache WHERE id=?").get("singleton") as Record<string, unknown> | undefined;
}
