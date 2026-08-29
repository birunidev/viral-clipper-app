#!/usr/bin/env node
// verify-pipeline.mjs — end-to-end pure Node pipeline (no Electron window needed)
// Creates a project from a synthetic video, runs analyze + render, checks DB/files.
// Run: node electron/scripts/verify-pipeline.mjs
//      USER_DATA_PATH=/tmp/cf-pipe node electron/scripts/verify-pipeline.mjs
//      node electron/scripts/verify-pipeline.mjs --keep   (keep tmp dir)
// Env: WHISPER_MODEL, LLM_* respected (mocks used if missing — still passes)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const keep = process.argv.includes("--keep");
const tmp = process.env.USER_DATA_PATH ?? fs.mkdtempSync(path.join(os.tmpdir(), "cf-pipe-"));
if (!process.env.USER_DATA_PATH) process.env.USER_DATA_PATH = tmp;
// Quick CI check runs the MOCK pipeline (no whisper binary / models needed).
// The app itself refuses to mock unless CLIPZARD_ALLOW_MOCK=1 — opt in here only.
process.env.CLIPZARD_ALLOW_MOCK = "1";
// Force the mock ANALYZER too — otherwise analyze() downloads a multi-GB LLM
// GGUF before falling back to mock, which hangs the quick check on fresh machines.
process.env.CLIPZARD_FORCE_MOCK = "1";
console.log(`[pipe] root=${root}`);
console.log(`[pipe] USER_DATA_PATH=${process.env.USER_DATA_PATH} tmp=${tmp} keep=${keep}`);
console.log(`[pipe] node ${process.version}`);

let ok = 0, fail = 0;
const step = async (label, fn) => {
  process.stdout.write(`  → ${label} ... `);
  try { await fn(); console.log("✓"); ok++; }
  catch (e) { console.log("✗"); console.error(`    ${e.message}`); if (e.stack) console.error(e.stack.slice(0, 800)); fail++; throw e; }
};

const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// Ensure built
for (const p of ["dist/main.js", "dist/services/db.js", "dist/services/pipeline.js", "dist/services/cutter.js"]) {
  must(fs.existsSync(path.join(root, p)), `missing ${p} — run: npx tsc`);
}

const { getRaw, getDbPathExport, nowIso } = await import(pathToFileURL(path.join(root, "dist/services/db.js")).href);
const { runAnalyze, runRender } = await import(pathToFileURL(path.join(root, "dist/services/pipeline.js")).href);
const db = getRaw();
console.log(`[pipe] db=${getDbPathExport()}`);

// 1. Create synthetic source video (2s black + silence) via ffmpeg-static
let ffmpeg;
try { ffmpeg = require("ffmpeg-static"); } catch { ffmpeg = "ffmpeg"; }
if (!ffmpeg || !fs.existsSync(ffmpeg)) {
  const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  must(r.status === 0, "ffmpeg not found — npm install (ffmpeg-static)");
  ffmpeg = "ffmpeg";
}
const synthSrc = path.join(tmp, "synth_source.mp4");
await step(`generate synthetic 2s source ${synthSrc}`, async () => {
  if (fs.existsSync(synthSrc)) return;
  const r = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=black:s=640x360:d=2:r=30", "-f", "lavfi", "-i", "anullsrc", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", synthSrc], { stdio: "pipe" });
  if (r.status !== 0) throw new Error(`ffmpeg gen failed: ${r.stderr?.toString().slice(0,500)}`);
  must(fs.statSync(synthSrc).size > 1000, "synth file empty");
  console.log(`(${ (fs.statSync(synthSrc).size/1024).toFixed(1)} KB)`);
});

// 2. Insert project (upload type)
const projectId = `test_${Date.now()}`;
const now = nowIso();
await step(`insert project ${projectId}`, async () => {
  db.prepare("INSERT INTO projects (id, title, source, source_type, source_key, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(projectId, "Pipeline Test", synthSrc, "upload", synthSrc, "idle", now, now);
  const p = db.prepare("SELECT * FROM projects WHERE id=?").get(projectId);
  must(p && p.id === projectId, "project not inserted");
});

// 3. Insert analyze job and run it
const jobId = `job_analyze_${Date.now()}`;
await step(`insert analyze job ${jobId}`, async () => {
  db.prepare("INSERT INTO jobs (id, project_id, type, status, stage, progress, options, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(jobId, projectId, "analyze", "queued", "queued", 0, JSON.stringify({ max_clips: 3, min_clip_seconds: 5, max_clip_seconds: 30 }), now, now);
});

await step(`runAnalyze ${jobId} (mock transcribe + mock LLM)`, async () => {
  const t0 = Date.now();
  await runAnalyze(jobId, (stage, prog) => {
    if (prog % 25 < 2) process.stdout.write(`\n    [${stage} ${prog}%]`);
  });
  console.log(`\n    done ${(Date.now()-t0)/1000}s`);
  const j = db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
  must(j.status === "completed", `job status=${j.status} err=${j.error}`);
  const clips = db.prepare("SELECT * FROM clips WHERE project_id=?").all(projectId);
  must(clips.length > 0, "no clips created");
  must(clips.length <= 3, "max_clips violated");
  const words = db.prepare("SELECT * FROM timeline_words WHERE project_id=?").all(projectId);
  must(words.length > 0, "no timeline_words");
  console.log(`    clips=${clips.length} words=${words.length}`);
  // store for render step
  global.__clips = clips;
});

const clips = global.__clips ?? db.prepare("SELECT * FROM clips WHERE project_id=?").all(projectId);
const firstClip = clips[0];
must(firstClip, "no first clip");

// 4. Thumbnails exist (may be missing if ffmpeg thumb failed — warn not fail)
await step(`thumbnails`, async () => {
  let hits = 0;
  for (const c of clips) if (c.thumbnail_url && fs.existsSync(c.thumbnail_url)) hits++;
  console.log(`thumbs ${hits}/${clips.length}`);
  if (hits === 0) console.warn("    warn: no thumbnails (ffmpeg thumb may have failed, pipeline still ok)");
});

// 5. Render first clip
const renderJobId = `job_render_${Date.now()}`;
await step(`insert render job ${renderJobId} for clip ${firstClip.id}`, async () => {
  db.prepare("INSERT INTO jobs (id, project_id, type, clip_id, status, stage, progress, options, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(renderJobId, projectId, "render", firstClip.id, "queued", "queued", 0, JSON.stringify({ orientation: "portrait" }), now, now);
});
await step(`runRender ${renderJobId}`, async () => {
  await runRender(renderJobId, (stage, prog) => process.stdout.write(` [${stage} ${prog}%]`));
  console.log("");
  const j = db.prepare("SELECT * FROM jobs WHERE id=?").get(renderJobId);
  must(j.status === "completed", `render status=${j.status} err=${j.error}`);
  const updated = db.prepare("SELECT * FROM clips WHERE id=?").get(firstClip.id);
  must(updated.video_url && fs.existsSync(updated.video_url), `render output missing: ${updated.video_url}`);
  console.log(`    output ${updated.video_url} ${(fs.statSync(updated.video_url).size/1024).toFixed(1)} KB`);
});

// 6. media:// sanity (project source_key + clip outputs under userData/projects or tmp)
await step(`media:// paths under USER_DATA_PATH`, async () => {
  const p = db.prepare("SELECT * FROM projects WHERE id=?").get(projectId);
  must(p.source_key && fs.existsSync(p.source_key), "source_key missing");
  must(p.source_key.startsWith(tmp) || p.source_key.includes("projects"), `source_key not under tmp/projects: ${p.source_key}`);
});

console.log(`\n[pipe] done ok=${ok} fail=${fail} tmp=${tmp}`);
console.log(`[pipe] clips: ${clips.map(c=>`${c.title} [${c.start_time}-${c.end_time}]`).join(" | ")}`);
if (!keep) {
  console.log(`[pipe] cleaning tmp (use --keep to retain)`);
  // don't delete USER_DATA_PATH if user supplied it explicitly via env — only if we created it and not --keep
  if (!process.argv.includes("--keep") && tmp.includes("cf-pipe-")) {
    try { fs.rmSync(projectId ? path.join(tmp, "projects", projectId) : tmp, { recursive: true, force: true }); } catch {}
  }
} else {
  console.log(`[pipe] kept ${tmp} — inspect projects/${projectId}/`);
}
if (fail) process.exitCode = 1;
else console.log(`[pipe] next: npm run dev  or  USER_DATA_PATH=${tmp} npm run dev`);
