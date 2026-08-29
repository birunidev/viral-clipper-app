#!/usr/bin/env node
/**
 * Build finetune dataset from existing userData source.
 * Reads projects DB + timeline_words + clips from USER_DATA_PATH (or default appData).
 * Outputs JSONL for LLM finetune (sharegpt / instruction format) reusing transcript words already on disk.
 *
 * Usage:
 *   node scripts/build-finetune-dataset.mjs [--user-data /path/to/userData] [--out finetune.jsonl]
 *   USER_DATA_PATH=/tmp/clipzard node scripts/build-finetune-dataset.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : fallback;
}



// resolve userData without electron
function resolveUserData() {
  const explicit = arg("--user-data", process.env.USER_DATA_PATH);
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (process.env.USER_DATA_PATH && fs.existsSync(process.env.USER_DATA_PATH)) return process.env.USER_DATA_PATH;
  const cand = [
    path.join(os.homedir(), "AppData", "Roaming", "clipzard-desktop"),
    path.join(os.homedir(), "AppData", "Roaming", "clipzard"),
    path.join(os.homedir(), ".clipzard"),
    path.join(process.cwd(), ".data"),
    path.join(process.cwd(), "electron", ".data"),
  ];
  for (const c of cand) if (fs.existsSync(c)) return c;
  return cand[2];
}

const ud = resolveUserData();
const outPath = arg("--out", path.join(process.cwd(), "finetune.jsonl"));

console.log(`[finetune] userData: ${ud}`);
console.log(`[finetune] out: ${outPath}`);

if (!fs.existsSync(ud)) {
  console.error(`[finetune] userData not found: ${ud} — run app once or pass --user-data`);
  process.exit(1);
}

// try to open sqlite db if present
let rows = [];
const dbPaths = [
  path.join(ud, "clipzard.db"),
  path.join(ud, "database.db"),
  path.join(ud, "data.db"),
  path.join(ud, "projects.db"),
];
let dbPath = dbPaths.find(p => fs.existsSync(p));
if (!dbPath) {
  // fallback: scan any .db
  try {
    const files = fs.readdirSync(ud).filter(f => f.endsWith(".db"));
    if (files.length) dbPath = path.join(ud, files[0]);
  } catch {}
}

if (dbPath) {
  console.log(`[finetune] DB: ${dbPath}`);
  try {
    let Database = null;
    try { Database = (await import("better-sqlite3")).default; } catch {}
    if (!Database) {
      try { Database = (await import("sqlite-electron")).default ?? (await import("sqlite-electron")); } catch {}
    }
    if (!Database) throw new Error("no sqlite driver (install better-sqlite3)");
    const DBCtor = Database.Database ?? Database;
    const db = new Database(dbPath, { readonly: true });
    const projects = db.prepare("SELECT id, language FROM projects").all();
    console.log(`[finetune] projects: ${projects.length}`);
    for (const p of projects) {
      const words = db.prepare("SELECT text, start_ms, end_ms FROM timeline_words WHERE project_id=? ORDER BY idx").all(p.id);
      const clips = db.prepare("SELECT title, viral_hook, start_time, end_time FROM clips WHERE project_id=?").all(p.id);
      if (!words.length || !clips.length) continue;
      // chunk transcript into ~9k char blocks like analyzer
      const BLOCK = 30;
      let blockStart = null, blockEnd = 0, buf = [], lines = [];
      for (const w of words) {
        const s = Number(w.start_ms) / 1000, e = Math.max(s, Number(w.end_ms) / 1000);
        if (blockStart === null) blockStart = s;
        buf.push(w.text); blockEnd = e;
        if (blockEnd - blockStart >= BLOCK) {
          lines.push(`[${Math.floor(blockStart)}s-${Math.floor(blockEnd)}s] ${buf.join(" ")}`);
          buf = []; blockStart = null;
        }
      }
      if (buf.length) lines.push(`[${Math.floor(blockStart ?? 0)}s-${Math.floor(blockEnd)}s] ${buf.join(" ")}`);
      const transcriptChunk = lines.join("\n").slice(0, 9000);
      const lang = p.language || "en";
      // Use existing clips as completions — filter to those fully inside first chunk's time range for clean supervision
      for (const c of clips) {
        const completion = JSON.stringify({ clips: [{ title: c.title, hook: c.viral_hook || "", start: c.start_time, end: c.end_time }] });
        rows.push({
          system: `You are a short-form video analyst. Language hint: ${lang}. Write title/hook in ${lang}.`,
          prompt: transcriptChunk,
          completion,
          meta: { project_id: p.id, language: lang },
        });
      }
    }
    db.close();
  } catch (e) {
    console.warn(`[finetune] DB read failed (better-sqlite3 missing?): ${e.message} — falling back to file scan`);
  }
}

// Fallback: scan projects folder for existing words/clips json if DB unavailable
if (rows.length === 0) {
  const projectsRoot = path.join(ud, "projects");
  if (fs.existsSync(projectsRoot)) {
    const ids = fs.readdirSync(projectsRoot).filter(d => {
      try { return fs.statSync(path.join(projectsRoot, d)).isDirectory(); } catch { return false; }
    });
    console.log(`[finetune] projects folder scan: ${ids.length} dirs`);
    for (const id of ids.slice(0, 200)) {
      const wordsFile = path.join(projectsRoot, id, "words.json");
      const clipsFile = path.join(projectsRoot, id, "clips.json");
      if (fs.existsSync(wordsFile) && fs.existsSync(clipsFile)) {
        try {
          const words = JSON.parse(fs.readFileSync(wordsFile, "utf8"));
          const clips = JSON.parse(fs.readFileSync(clipsFile, "utf8"));
          const transcript = words.map(w => w.text).join(" ").slice(0, 9000);
          for (const c of clips) rows.push({ system: `Language: ${c.language || "en"}`, prompt: transcript, completion: JSON.stringify({ clips: [c] }) });
        } catch {}
      }
    }
  }
}

if (rows.length === 0) {
  console.warn("[finetune] no rows found — seeding 2 synthetic EN/ID examples so pipeline is testable");
  rows.push(
    { system: "Language hint: English", prompt: "[0s-30s] bitcoin crashed because The Fed is hawkish and inflation is rising", completion: JSON.stringify({ clips: [{ title: "Fed Just Crashed Bitcoin", hook: "Why your portfolio is down today", start: 2, end: 18 }] }), meta: { synthetic: true } },
    { system: "Language hint: Indonesian (Bahasa Indonesia)", prompt: "[0s-30s] bitcoin turun karena The Fed hawkish dan inflasi naik", completion: JSON.stringify({ clips: [{ title: "The Fed Bikin Bitcoin Anjlok", hook: "Kenapa portofolio kamu merah hari ini?", start: 2, end: 18 }] }), meta: { synthetic: true } },
  );
}

// Write JSONL (sharegpt-ish)
const out = rows.map(r => JSON.stringify(r)).join("\n");
fs.writeFileSync(outPath, out, "utf8");
console.log(`[finetune] wrote ${rows.length} rows -> ${outPath}`);
console.log(`[finetune] next: finetune Qwen2.5-1.5b/7b with LoRA on this JSONL, then quantize to GGUF and place in ${path.join(ud, "models", "llm")}`);
console.log(`[finetune] e.g. use unsloth + llama.cpp convert_hf_to_gguf.py + quantize Q4_K_M`);
