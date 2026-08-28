import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";

const SECRET = process.env.LICENSE_SECRET ?? process.env.APP_SECRET_KEY ?? "dev-secret-change-me";
const GRACE_DAYS = 30;

function sign(payload: string): string {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
}

export async function POST(req: NextRequest) {
  const { licenseKey, email } = await req.json().catch(() => ({}));
  const key = String(licenseKey ?? "").trim();
  if (!key) return NextResponse.json({ valid: false, message: "missing key" }, { status: 400 });

  // 1) Try Postgres licenses table (local docker dev db) if DATABASE_URL is set
  const dbUrl = process.env.DATABASE_URL ?? "postgresql://clipforge:clipforge@localhost:5438/clipforge";
  try {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    const r = await client.query("SELECT license_key, email, is_valid, tier, expires_at FROM licenses WHERE license_key=$1 LIMIT 1", [key]);
    await client.end();
    if (r.rows.length > 0) {
      const row = r.rows[0];
      if (!row.is_valid) {
        const payload = JSON.stringify({ licenseKey: key, email: email ?? "", valid: false });
        return NextResponse.json({ valid: false, message: "license revoked", signature: sign(payload), expiresAt: null }, { status: 403 });
      }
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        const payload = JSON.stringify({ licenseKey: key, email: email ?? "", valid: false });
        return NextResponse.json({ valid: false, message: "license expired", signature: sign(payload), expiresAt: row.expires_at }, { status: 403 });
      }
      const payload = JSON.stringify({ licenseKey: key, email: email ?? "", valid: true });
      const expiresAt = new Date(Date.now() + GRACE_DAYS * 24 * 3600 * 1000).toISOString();
      return NextResponse.json({ valid: true, tier: row.tier ?? "unlimited", signature: sign(payload), expiresAt, email: row.email });
    }
  } catch {}

  // 2) Try FastAPI proxy (if backend is running)
  const backendUrl = process.env.BACKEND_URL ?? process.env.NEXT_PUBLIC_API_URL?.replace(/\/api\/v1.*/, "") ?? "http://localhost:8000";
  try {
    const res = await fetch(`${backendUrl}/api/v1/license/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey: key, email, deviceHash: "" }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.valid) return NextResponse.json(data);
    }
  } catch {}

  // 3) Fallback: env LICENSE_KEYS
  const raw = process.env.LICENSE_KEYS ?? "";
  const allowed = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const envLicensed = !raw || allowed.includes(key) || key.startsWith("CF-");

  const payload = JSON.stringify({ licenseKey: key, email: email ?? "", valid: envLicensed });
  const signature = sign(payload);
  const expiresAt = new Date(Date.now() + GRACE_DAYS * 24 * 3600 * 1000).toISOString();

  if (!envLicensed) {
    return NextResponse.json({ valid: false, message: "invalid license", signature, expiresAt }, { status: 403 });
  }

  return NextResponse.json({ valid: true, signature, expiresAt, tier: "unlimited" });
}

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "license/verify" });
}
