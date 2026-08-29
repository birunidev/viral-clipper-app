#!/usr/bin/env node
// verify-dev.mjs — pure Node pipeline sanity check for ClipForge Desktop
// Run: node electron/scripts/verify-dev.mjs
// or: USER_DATA_PATH=/tmp/cf-test node electron/scripts/verify-dev.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const tmp = process.env.USER_DATA_PATH ?? fs.mkdtempSync(path.join(os.tmpdir(), "cf-verify-"));
if (!process.env.USER_DATA_PATH) process.env.USER_DATA_PATH = tmp;
// This script intentionally exercises the MOCK pipeline (no whisper binary needed).
// The app itself refuses to mock unless CLIPZARD_ALLOW_MOCK=1 — opt in here only.
process.env.CLIPZARD_ALLOW_MOCK = "1";

console.log(`[verify] root=${root}`);
console.log(`[verify] USER_DATA_PATH=${process.env.USER_DATA_PATH} (tmp=${tmp})`);
console.log(`[verify] node ${process.version}`);

let ok = 0, fail = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ✓ ${label}`); ok++; }
  catch (e) { console.error(`  ✗ ${label}: ${e.message}`); fail++; }
};
const asyncCheck = async (label, fn) => {
  try { await fn(); console.log(`  ✓ ${label}`); ok++; }
  catch (e) { console.error(`  ✗ ${label}: ${e?.message ?? e}`); if (e?.stack) console.error(e.stack.slice(0, 600)); fail++; }
};

// 1. build artifacts
check("dist/main.js exists (run: npx tsc)", () => {
  if (!fs.existsSync(path.join(root, "dist/main.js"))) throw new Error("missing dist/main.js — run: npx tsc");
});
check("dist/preload.cjs exists (run: npx esbuild src/preload.ts ...)", () => {
  if (!fs.existsSync(path.join(root, "dist/preload.cjs"))) throw new Error("missing dist/preload.cjs");
});
check("renderer/dist/index.html exists (run: npm --prefix renderer run build)", () => {
  if (!fs.existsSync(path.join(root, "renderer/dist/index.html"))) throw new Error("missing renderer/dist/index.html — run: npm --prefix renderer run build");
});
check("ffmpeg-static binary", () => {
  try {
    const p = require("ffmpeg-static");
    if (p && fs.existsSync(p)) return;
  } catch {}
  const p2 = path.join(root, "node_modules/ffmpeg-static/ffmpeg");
  if (fs.existsSync(p2)) return;
  throw new Error("ffmpeg not found — run: npm install");
});
check("ffprobe-static binary", () => {
  const pp = require("ffprobe-static");
  const cand = typeof pp === "string" ? pp : pp?.path;
  if (cand && fs.existsSync(cand)) return;
  throw new Error("ffprobe not found — run: npm install");
});
check("yt-dlp binary (yt-dlp-exec)", () => {
  const p = path.join(root, "node_modules/yt-dlp-exec/bin/yt-dlp");
  if (!fs.existsSync(p)) throw new Error(`missing ${p} — run: PATH=/tmp:$PATH npm install (needs python -> python3 symlink)`);
});

// 2. DB — handles both node:sqlite (null-prototype row, [Object: null prototype] {c:0}) and JSON fallback (no count(*) support)
await asyncCheck("DB (node:sqlite or JSON fallback)", async () => {
  const { getRaw, getDbPathExport } = await import(pathToFileURL(path.join(root, "dist/services/db.js")).href);
  const db = getRaw();
  // Prefer count(*), fall back to SELECT * length for JSON fallback
  let counted = null;
  try {
    const row = db.prepare("SELECT count(*) as c FROM projects").get();
    // row may be null-prototype; coerce safely
    if (row && typeof row.c === "number") counted = row.c;
    else if (row && typeof row["c"] === "number") counted = row["c"];
    else if (row) {
      const v = Object.values(row)[0];
      if (typeof v === "number") counted = v;
    }
  } catch {}
  if (counted === null) {
    const rows = db.prepare("SELECT * FROM projects").all();
    counted = Array.isArray(rows) ? rows.length : 0;
  }
  if (typeof counted !== "number") throw new Error(`bad row count (db=${getDbPathExport()})`);
});

// 3. pipeline mocks (no binaries needed)
await asyncCheck("analyzer mock (no LLM binary)", async () => {
  const { analyze } = await import(pathToFileURL(path.join(root, "dist/services/analyzer.js")).href);
  const words = [{ text: "halo", start_ms: 0, end_ms: 200 }, { text: "bitcoin", start_ms: 200, end_ms: 400 }];
  const clips = await analyze("halo bitcoin market turun karena the fed hawkish", words, { language: "id", minDuration: 10, maxDuration: 60 });
  if (!clips.length) throw new Error("no clips from mock analyze");
});

await asyncCheck("transcriber mock (no whisper-cli)", async () => {
  const { transcribeWithWords } = await import(pathToFileURL(path.join(root, "dist/services/transcriber.js")).href);
  const dummy = path.join(tmp, "dummy.mp4");
  fs.writeFileSync(dummy, Buffer.alloc(100));
  const t = await transcribeWithWords(dummy);
  if (!t.words.length) throw new Error("empty mock transcript");
  try { fs.unlinkSync(dummy); } catch {}
});

await asyncCheck("cutter buildCommand + ffmpeg cut (1s blank clip)", async () => {
  let ffmpeg;
  try { ffmpeg = require("ffmpeg-static"); } catch { ffmpeg = "ffmpeg"; }
  if (!ffmpeg || !fs.existsSync(ffmpeg)) {
    const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    if (r.status !== 0) { console.log("    (skip ffmpeg cut — no ffmpeg, mocks still OK)"); return; }
    ffmpeg = "ffmpeg";
  }
  const src = path.join(tmp, "src.mp4");
  const outDir = path.join(tmp, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const gen = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2:r=30", "-f", "lavfi", "-i", "anullsrc", "-t", "2", "-c:v", "libx264", "-c:a", "aac", "-shortest", src], { stdio: "pipe" });
  if (gen.status !== 0) throw new Error("ffmpeg gen failed: " + gen.stderr?.toString().slice(0,400));
  const { cutClip } = await import(pathToFileURL(path.join(root, "dist/services/cutter.js")).href);
  const out = await cutClip(src, 0, 1, "Test Clip", outDir, 1, "portrait", null, null, null);
  if (!fs.existsSync(out)) throw new Error("cut output missing");
});

console.log(`\n[verify] done ok=${ok} fail=${fail} tmp=${tmp}`);
console.log(`[verify] next: npm run dev  (concurrently: tsc watch + preload + vite + electron)`);
console.log(`[verify] models: npm run models:download  (or --all, or --out=resources/models)`);
if (fail) process.exitCode = 1;
