import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { userDataRoot } from "./userData.js";
const require = createRequire(import.meta.url);

function getAppUserData(): string | null {
  try { return userDataRoot(); } catch { return null; }
}
export function getDbPath(): string {
  const envPath = process.env.USER_DATA_PATH;
  if (envPath) { fs.mkdirSync(envPath, { recursive: true }); return path.join(envPath, "clipzard.db"); }
  const appPath = getAppUserData();
  const base = appPath ?? path.join(process.cwd(), ".data");
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, "clipzard.db");
}
export function getDbPathExport(): string { return getDbPath(); }
export function nowIso(): string { return new Date().toISOString(); }
