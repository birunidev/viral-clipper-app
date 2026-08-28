"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const STORAGE_KEY = "clipzard_cookie_consent";
const YT_KEY = "clipzard_youtube_cookie_consent";

type Consent = {
  necessary: true;
  analytics: boolean;
  youtube: boolean;
  decidedAt: string;
};

function readConsent(): Consent | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Consent;
  } catch {
    return null;
  }
}

export function CookieConsent() {
  const [visible, setVisible] = useState(false);
  const [youtube, setYoutube] = useState(false);
  const [analytics, setAnalytics] = useState(false);

  useEffect(() => {
    const existing = readConsent();
    if (!existing) setVisible(true);
    else {
      setYoutube(existing.youtube);
      setAnalytics(existing.analytics);
      // respect YouTube opt-in for later per-project upload
      try {
        localStorage.setItem(YT_KEY, existing.youtube ? "1" : "0");
      } catch {}
    }
  }, []);

  async function save(c: Consent) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
      localStorage.setItem(YT_KEY, c.youtube ? "1" : "0");
      // also set a plain cookie for SSR / backend reading if needed
      document.cookie = `cookie_consent=${c.youtube ? "youtube" : c.analytics ? "analytics" : "necessary"}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    } catch {}
    setVisible(false);
    // Client-side script: after YouTube opt-in, try to auto-capture session cookies
    // (requires extension with chrome.cookies + host_permissions per SO 75426272).
    // Falls back to manual cookies.txt upload in dashboard if extension not present.
    if (c.youtube) {
      try {
        const { getClientYoutubeCookies } = await import("@/lib/youtube-cookies");
        const txt = await getClientYoutubeCookies();
        if (txt) {
          try {
            sessionStorage.setItem("clipzard_youtube_cookies", txt);
          } catch {}
        }
      } catch {}
    } else {
      try {
        sessionStorage.removeItem("clipzard_youtube_cookies");
      } catch {}
    }
    // Notify dashboard to re-check consent without reload
    try {
      window.dispatchEvent(new Event("storage"));
    } catch {}
  }

  if (!visible) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 p-4 sm:p-6">
      <div className="mx-auto max-w-3xl rounded-2xl border border-line bg-surface-1 p-5 shadow-2xl">
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-sm font-semibold text-ink">We use cookies</p>
            <p className="mt-1 text-sm leading-relaxed text-ink-tertiary">
              ClipZard uses necessary cookies to keep you signed in. With your consent, we can also use your YouTube session cookies — sent from your browser only when you create a YouTube project — to download videos on your behalf and bypass YouTube’s bot check. Your YouTube cookies are never stored; they’re used once per download and discarded.
              <span className="mt-2 block text-xs text-ink-muted">
                Learn more in <Link href="/privacy" className="underline underline-offset-4 hover:text-ink">Privacy</Link> and <Link href="/terms" className="underline underline-offset-4 hover:text-ink">Terms</Link>.
              </span>
            </p>
          </div>

          <div className="flex flex-col gap-2 rounded-xl border border-line-soft bg-canvas p-3">
            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="text-ink">
                Necessary <span className="text-ink-muted">(always on)</span>
              </span>
              <input type="checkbox" checked disabled className="h-4 w-4 accent-accent" />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="text-ink">Analytics</span>
              <input
                type="checkbox"
                checked={analytics}
                onChange={(e) => setAnalytics(e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span className="text-ink">
                YouTube session for downloads
                <span className="ml-2 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-ink-tertiary">opt-in</span>
              </span>
              <input
                type="checkbox"
                checked={youtube}
                onChange={(e) => setYoutube(e.target.checked)}
                className="h-4 w-4 accent-accent"
              />
            </label>
            {youtube && (
              <p className="text-xs leading-relaxed text-ink-muted">
                When enabled, you’ll see an optional “Upload cookies.txt” when creating a YouTube project. Export it via the “Get cookies.txt LOCALLY” extension (check HttpOnly) and upload — we use it once then delete.
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() =>
                save({ necessary: true, analytics: false, youtube: false, decidedAt: new Date().toISOString() })
              }
              className="h-9 rounded-full border border-line bg-surface-2 px-4 text-sm font-medium text-ink hover:bg-surface-1"
            >
              Decline
            </button>
            <button
              type="button"
              onClick={() => save({ necessary: true, analytics, youtube, decidedAt: new Date().toISOString() })}
              className="h-9 rounded-full bg-accent px-5 text-sm font-medium text-accent-ink hover:bg-accent-strong"
            >
              Save preferences
            </button>
            <button
              type="button"
              onClick={() =>
                save({ necessary: true, analytics: true, youtube: true, decidedAt: new Date().toISOString() })
              }
              className="h-9 rounded-full bg-ink px-5 text-sm font-medium text-white hover:bg-ink/90"
            >
              Accept all
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function hasYoutubeConsent(): boolean {
  try {
    return localStorage.getItem(YT_KEY) === "1";
  } catch {
    return false;
  }
}
