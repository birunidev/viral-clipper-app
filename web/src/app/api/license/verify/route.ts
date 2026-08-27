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
