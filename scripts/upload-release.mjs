#!/usr/bin/env node
/**
 * Upload a built ClipZard binary to the update server.
 *
 * Usage:
 *   node scripts/upload-release.mjs \
 *     --file=electron/release/ClipZard\ Setup\ 0.2.0.exe \
 *     --version=0.2.0 \
 *     --platform=win32 \
 *     --arch=x64 \
 *     --channel=stable \
 *     --notes="## 0.2.0
       - Fixed X
       - Added Y" \
 *     --api=https://api.clipzard.web.id \
 *     --token=$CLIPZARD_ADMIN_TOKEN
 *
 * Required env if not passed via flags:
 *   CLIPZARD_ADMIN_TOKEN
 */

import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { createReadStream } from "node:fs";

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    out[m[1]] = m[2] ?? true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const file = args.file || process.env.CLIPZARD_FILE;
  const version = args.version || process.env.CLIPZARD_VERSION;
  const platform = args.platform || process.env.CLIPZARD_PLATFORM;
  const arch = args.arch || process.env.CLIPZARD_ARCH;
  const channel = (args.channel || process.env.CLIPZARD_CHANNEL || "stable").toLowerCase();
  const notes = args.notes ?? process.env.CLIPZARD_NOTES ?? "";
  const api = (args.api || process.env.CLIPZARD_API || "https://api.clipzard.web.id").replace(/\/$/, "");
  const token = args.token || process.env.CLIPZARD_ADMIN_TOKEN;

  if (!file) throw new Error("--file <path> is required (or CLIPZARD_FILE)");
  if (!version) throw new Error("--version <semver> is required (or CLIPZARD_VERSION)");
  if (!["win32", "darwin", "linux"].includes(platform)) throw new Error("--platform must be win32/darwin/linux");
  if (!["ia32", "x64", "arm64"].includes(arch)) throw new Error("--arch must be ia32/x64/arm64");
  if (!["stable", "beta"].includes(channel)) throw new Error("--channel must be stable/beta");
  if (!token) throw new Error("admin token required (--token or CLIPZARD_ADMIN_TOKEN)");

  const fileStat = await stat(file);
  console.log(`[upload] ${basename(file)} (${(fileStat.size / 1e6).toFixed(1)} MB) -> ${api}/api/v1/update/upload`);
  console.log(`[upload] version=${version} platform=${platform} arch=${arch} channel=${channel}`);

  // Use Node's native FormData + fetch (Node 20+). Stream the file via a
  // Blob backed by a stream-friendly path.
  const form = new FormData();
  form.append("file", new Blob([await readFile(file)]), basename(file));
  form.append("version", version);
  form.append("platform", platform);
  form.append("arch", arch);
  form.append("release_notes", notes);
  form.append("is_beta", channel === "beta" ? "true" : "false");

  const t0 = Date.now();
  const resp = await fetch(`${api}/api/v1/update/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`upload failed: HTTP ${resp.status} ${resp.statusText}\n${txt.slice(0, 800)}`);
  }
  const json = await resp.json();
  console.log(`[upload] ok in ${dt}s`);
  console.log(JSON.stringify(json, null, 2));
  console.log(`[upload] verify: curl '${api}/api/v1/update/check?version=0.0.0&platform=${platform}&arch=${arch}&channel=${channel}'`);
}

main().catch((e) => {
  console.error("[upload] error:", e.message);
  process.exit(1);
});
