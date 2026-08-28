import { getRaw, nowIso, dbFetchOne, dbExecute } from "./db.js";
import crypto from "node:crypto";
import os from "node:os";
let _isPackaged: boolean | null = null;
function isDevBypass(): boolean {
  if (process.env.LICENSE_ENFORCE === "1") return false;
  if (process.env.LICENSE_VERIFY_URL?.includes("clipzard.web.id")) return false;
  if (_isPackaged !== null) return !_isPackaged;
  try { const { app } = require("electron") as { app: { isPackaged: boolean } }; _isPackaged = app.isPackaged; return !_isPackaged; } catch { return process.env.NODE_ENV === "development"; }
}
const VERIFY_URL = process.env.LICENSE_VERIFY_URL ?? "https://clipzard.web.id/api/license/verify";
const GRACE_DAYS = 30;
function deviceHash(): string { const raw = `${os.hostname()}:${os.platform()}:${os.arch()}`; return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16); }
const FALLBACK_URLS = ["http://localhost:3005/api/license/verify", "http://localhost:8000/api/v1/license/verify"];
async function fetchLicense(url: string, key: string, email?: string): Promise<{ valid?: boolean; message?: string; signature?: string; tier?: string }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ licenseKey: key, email: email ?? undefined, deviceHash: deviceHash() }) });
  const ct = res.headers.get("content-type") ?? ""; const text = await res.text(); if (!ct.includes("application/json")) throw new Error(`License server returned non-JSON (${res.status}): ${text.slice(0, 120)} — is ${url} running?`);
  try { return JSON.parse(text) as { valid?: boolean; message?: string; signature?: string; tier?: string }; } catch { throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 120)}`); }
}
async function dbGetLicenseRow(): Promise<Record<string, unknown> | undefined> {
  try { if ((process as any).versions?.electron) return await dbFetchOne<Record<string, unknown>>("SELECT * FROM license_cache WHERE id=?", ["singleton"]); } catch {}
  return getRaw().prepare("SELECT * FROM license_cache WHERE id=?").get("singleton") as Record<string, unknown> | undefined;
}
async function dbPutLicense(key: string, email: string | undefined, valid: boolean, payload: unknown): Promise<void> {
  const now = nowIso(); const expires = new Date(Date.now() + GRACE_DAYS * 24 * 3600 * 1000).toISOString();
  try { if ((process as any).versions?.electron) { await dbExecute("INSERT OR REPLACE INTO license_cache (id, license_key, email, valid, verified_at, expires_at, payload) VALUES (?,?,?,?,?,?,?)", ["singleton", key, email ?? null, valid?1:0, now, expires, JSON.stringify(payload)]); return; } } catch {}
  getRaw().prepare("INSERT OR REPLACE INTO license_cache (id, license_key, email, valid, verified_at, expires_at, payload) VALUES (?,?,?,?,?,?,?)").run("singleton", key, email ?? null, valid?1:0, now, expires, JSON.stringify(payload));
}
export async function verifyLicense(licenseKey: string, email?: string): Promise<{ valid: boolean; message?: string }> {
  const key = licenseKey.trim(); if (!key) return { valid: false, message: "empty key" };
  const urls = [VERIFY_URL, ...FALLBACK_URLS.filter((u) => u !== VERIFY_URL)]; let lastErr: unknown = null;
  for (const url of urls) {
    try {
      const data = await fetchLicense(url, key, email); const valid = !!data.valid;
      await dbPutLicense(key, email, valid, data);
      if (!valid) return { valid, message: data.message ?? `Invalid license at ${url}` };
      return { valid, message: data.message };
    } catch (e) { lastErr = e; const msg = String((e as Error).message ?? e); if (msg.includes("non-JSON") || msg.includes("404") || msg.includes("ECONNREFUSED") || msg.includes("Failed to fetch")) continue; break; }
  }
  const cached = await dbGetLicenseRow();
  if (cached && Number(cached.valid) === 1) { const exp = String(cached.expires_at ?? ""); if (exp && new Date(exp).getTime() > Date.now()) return { valid: true, message: "offline grace" }; }
  return { valid: false, message: String((lastErr as Error)?.message ?? lastErr ?? "License server unreachable — set LICENSE_VERIFY_URL=http://localhost:3005/api/license/verify for local dev") };
}
export async function isLicensed(): Promise<boolean> {
  if (isDevBypass()) return true;
  const row = await dbGetLicenseRow(); if (!row || Number(row.valid) !== 1) return false; const exp = String(row.expires_at ?? ""); if (exp && new Date(exp).getTime() < Date.now()) return false; return true;
}
export function isLicensedSync(): boolean {
  if (isDevBypass()) return true;
  try { const row = getRaw().prepare("SELECT * FROM license_cache WHERE id=?").get("singleton") as Record<string, unknown> | undefined; if (!row || Number(row.valid) !== 1) return false; const exp = String(row.expires_at ?? ""); if (exp && new Date(exp).getTime() < Date.now()) return false; return true; } catch { return false; }
}
export async function getLicense(): Promise<Record<string, unknown> | undefined> { return await dbGetLicenseRow(); }
export function getLicenseSync() { return getRaw().prepare("SELECT * FROM license_cache WHERE id=?").get("singleton") as Record<string, unknown> | undefined; }
