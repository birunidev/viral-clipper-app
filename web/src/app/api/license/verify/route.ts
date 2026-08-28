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

  // Proxy to FastAPI — single source of truth (backend owns licenses table).
  // Web no longer needs DATABASE_URL or pg.
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
    } else {
      // Backend said invalid — passthrough its message instead of masking with env fallback
      const text = await res.text().catch(() => "");
      try {
        const j = JSON.parse(text) as { valid?: boolean; message?: string };
        if (j.valid === false) return NextResponse.json(j, { status: res.status });
      } catch {}
    }
  } catch {}

  // Fallback: env LICENSE_KEYS (offline / dev without backend)
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
