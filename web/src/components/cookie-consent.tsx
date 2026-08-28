"use client";

// Cookie consent is now auth-only (necessary httpOnly session cookie).
// No banner is shown — only the session cookie set by the backend is used.
// Keep the module as a no-op for backwards compatibility with any legacy
// imports; youtube/ analytics opt-ins have been removed.

export function CookieConsent() {
  return null;
}

export function hasYoutubeConsent(): boolean {
  // Auth-only mode: always allow downstream helpers to proceed if the user
  // provides a file/session explicitly. No stored consent gate.
  return true;
}
