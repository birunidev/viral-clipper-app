/**
 * Auth + session management for the Electron desktop.
 *
 * The desktop logs in as a real user via the same `/auth/login` endpoint
 * the web app uses, and the server returns an httpOnly session cookie.
 * We store the session token in a separate "session" file in userData
 * (NOT in the same cache as the license blob), and re-attach it to
 * every subsequent request via a `Cookie` header. The backend's
 * `current_user` dep accepts the cookie regardless of origin (the
 * Electron null-origin passthrough middleware in `app/main.py` makes
 * this work).
 *
 * No license keys live in this app any more. The entitlement check
 * is in `entitlement.ts`.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import { userDataRoot } from "./userData.js";

const API_URL = (() => {
  // Production by default. Dev override via env or `app.isPackaged`.
  if (process.env.CLIPZARD_API_URL) return process.env.CLIPZARD_API_URL.replace(/\/+$/, "");
  if (!app.isPackaged) return "http://127.0.0.1:8000/api/v1";
  return "https://clipzard.web.id/api/v1";
})();

function sessionFile(): string {
  return path.join(userDataRoot(), "session.json");
}

export type Session = {
  token: string;
  user_id: string;
  email: string;
  name: string | null;
  saved_at: string;
};

let _session: Session | null = null;

function load(): Session | null {
  try {
    const raw = fs.readFileSync(sessionFile(), "utf-8");
    const s = JSON.parse(raw) as Session;
    if (!s?.token || !s?.user_id) return null;
    return s;
  } catch {
    return null;
  }
}

function save(s: Session | null): void {
  try {
    if (s === null) {
      if (fs.existsSync(sessionFile())) fs.unlinkSync(sessionFile());
    } else {
      fs.mkdirSync(path.dirname(sessionFile()), { recursive: true });
      fs.writeFileSync(sessionFile(), JSON.stringify(s), "utf-8");
    }
  } catch (e) {
    console.warn("[auth] session save failed", e);
  }
}

export function currentSession(): Session | null {
  if (_session) return _session;
  _session = load();
  return _session;
}

export function authCookieHeader(): string {
  const s = currentSession();
  if (!s) return "";
  return `clipzard_session=${s.token}`;
}

export type MeUser = {
  id: string;
  email: string;
  name: string | null;
  terms_accepted_at: string | null;
  has_license: boolean;
  license_tier: string | null;
  credits: number;
  current_device_count: number;
  max_devices: number;
};

export type LoginResult =
  | { ok: true; user: MeUser }
  | { ok: false; reason: "bad_credentials" | "network" | "server_error"; message: string };

export async function login(email: string, password: string): Promise<LoginResult> {
  const url = `${API_URL}/auth/login`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    });
  } catch (e) {
    return { ok: false, reason: "network", message: String((e as Error)?.message ?? e) };
  }
  if (res.status === 401) {
    return { ok: false, reason: "bad_credentials", message: "Invalid email or password." };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, reason: "server_error", message: `Login failed (${res.status}): ${text.slice(0, 200)}` };
  }
  // Pull the session cookie from the response — backend sets it
  // as `clipzard_session=...; HttpOnly; ...`
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/clipzard_session=([^;]+)/);
  if (!m) {
    return { ok: false, reason: "server_error", message: "Server did not return a session cookie." };
  }
  const token = m[1];
  const user = (await res.json()) as MeUser;
  const session: Session = {
    token,
    user_id: user.id,
    email: user.email,
    name: user.name,
    saved_at: new Date().toISOString(),
  };
  _session = session;
  save(session);
  return { ok: true, user };
}

export async function logout(): Promise<void> {
  const s = currentSession();
  _session = null;
  save(null);
  if (!s) return;
  try {
    await fetch(`${API_URL}/auth/logout`, {
      method: "POST",
      headers: { Cookie: `clipzard_session=${s.token}` },
    });
  } catch (e) {
    console.warn("[auth] server logout failed (ignoring)", e);
  }
}

export async function me(): Promise<MeUser | null> {
  const s = currentSession();
  if (!s) return null;
  try {
    const res = await fetch(`${API_URL}/auth/me`, {
      headers: { Cookie: `clipzard_session=${s.token}` },
    });
    if (res.status === 401) {
      _session = null;
      save(null);
      return null;
    }
    if (!res.ok) return null;
    return (await res.json()) as MeUser;
  } catch {
    return null;
  }
}

export type ForgotResult = { ok: true } | { ok: false; message: string };

export async function requestPasswordReset(email: string): Promise<ForgotResult> {
  try {
    const res = await fetch(`${API_URL}/auth/password/reset-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim().toLowerCase() }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, message: `Server returned ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String((e as Error)?.message ?? e) };
  }
}
