import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Unified user data root.
 * - If USER_DATA_PATH env is set → use it (CI/tests)
 * - On Windows → %USERPROFILE%\.clipzard  (C:\Users\<user>\.clipzard)
 * - Else (Linux/mac) → ~/.config/clipzard-desktop
 *
 * Previously the app used app.getPath("userData") which is
 * %APPDATA%\clipzard-desktop on Win and ~/Library/Application Support/… on mac.
 * We now normalize so devs never need to set USER_DATA_PATH.
 * Migration: if unified dir is empty but old dir has data, we will copy once.
 */
export function userDataRoot(): string {
  if (process.env.USER_DATA_PATH) return process.env.USER_DATA_PATH;
  if (process.platform === "win32") return path.join(os.homedir(), ".clipzard");
  return path.join(os.homedir(), ".config", "clipzard-desktop");
}

function oldUserDataRoot(): string | null {
  // Legacy location from app.getPath("userData") — keep for one-time migration.
  try {
    const { app } = require("electron") as { app: { getPath: (n: string) => string } };
    return app.getPath("userData");
  } catch {
    return null;
  }
}

export function ensureUserDataMigrated(): void {
  const next = userDataRoot();
  const old = oldUserDataRoot();
  if (!old || old === next) return;
  try {
    if (!fs.existsSync(next) || fs.readdirSync(next).length === 0) {
      if (fs.existsSync(old) && fs.readdirSync(old).length > 0) {
        console.log(`[userData] migrating from legacy ${old} → ${next}`);
        fs.mkdirSync(next, { recursive: true });
        // copy top-level models/projects/*.db json etc. Shallow copy of known subdirs.
        for (const sub of ["models", "projects", "youtube-cache", "transcript-cache"]) {
          const src = path.join(old, sub);
          const dest = path.join(next, sub);
          if (fs.existsSync(src) && !fs.existsSync(dest)) {
            try {
              fs.cpSync(src, dest, { recursive: true });
            } catch {}
          }
        }
        for (const f of ["clipzard.db", "clipzard.json", "device.id", "entitlement_cache.json", "session.json"]) {
          const src = path.join(old, f);
          const dest = path.join(next, f);
          if (fs.existsSync(src) && !fs.existsSync(dest)) {
            try {
              fs.copyFileSync(src, dest);
            } catch {}
          }
        }
      }
    }
  } catch {}
}

export function resolveUserData(sub?: string): string {
  const base = userDataRoot();
  fs.mkdirSync(base, { recursive: true });
  ensureUserDataMigrated();
  if (sub) {
    const p = path.join(base, sub);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    return p;
  }
  return base;
}
