"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function AccountPage() {
  const [me, setMe] = useState<{ email: string; name: string | null } | null>(null);
  const [license, setLicense] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ user: { email: string; name: string | null } }>("/auth/me")
      .then((r) => setMe(r.user))
      .catch(() => setMe(null));
    api.get<{ license_key?: string; valid?: boolean }>("/billing/status")
      .then((r: unknown) => {
        const v = r as { license_key?: string; licenseKey?: string };
        if (v.license_key) setLicense(v.license_key);
        else if (v.licenseKey) setLicense(v.licenseKey as string);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
      <p className="mt-2 text-sm text-ink-tertiary">Manage your ClipForge Desktop license and downloads.</p>
      {me ? <p className="mt-4 text-sm">Signed in as <span className="font-medium">{me.email}</span></p> : <p className="mt-4 text-sm text-ink-tertiary">Not signed in — <Link href="/app/login" className="underline">Sign in</Link> or <Link href="/app/register" className="underline">Register</Link></p>}
      <div className="mt-8 rounded-xl border border-line bg-surface-1 p-6">
        <h2 className="text-sm font-semibold">License key</h2>
        {license ? (
          <div className="mt-2 flex items-center gap-3">
            <code className="rounded bg-surface-2 px-3 py-1.5 text-sm">{license}</code>
            <button onClick={() => navigator.clipboard.writeText(license)} className="text-xs underline">Copy</button>
          </div>
        ) : (
          <p className="mt-2 text-sm text-ink-tertiary">No license yet — buy a one-time purchase below or check your email after payment.</p>
        )}
      </div>
      <div className="mt-8 flex flex-col gap-3">
        <Link href="/" className="text-sm underline">Back to marketing</Link>
        <a href="https://github.com/clipforge/releases" className="text-sm text-ink-tertiary">Download ClipForge Desktop — Windows (.exe) / Linux (.AppImage)</a>
      </div>
    </div>
  );
}
