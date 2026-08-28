#!/usr/bin/env node
// run-youtube.mjs — E2E with a real YouTube URL (real yt-dlp download, mock or real AI)
// Usage: node electron/scripts/run-youtube.mjs "https://www.youtube.com/watch?v=..."
//        USER_DATA_PATH=/tmp/cf-yt node electron/scripts/run-youtube.mjs "https://..."
//        node electron/scripts/run-youtube.mjs "https://..." --keep
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const url = process.argv[2];
const keep = process.argv.includes("--keep");
if (!url || !/^https?:\/\//.test(url)) {
  console.error(`Usage: node electron/scripts/run-youtube.mjs "https://www.youtube.com/watch?v=..." [--keep]`);
  console.error(`       USER_DATA_PATH=/tmp/cf-yt node electron/scripts/run-youtube.mjs "..."`);
  process.exit(1);
}
const tmp = process.env.USER_DATA_PATH ?? fs.mkdtempSync(path.join(os.tmpdir(), "cf-yt-"));
if (!process.env.USER_DATA_PATH) process.env.USER_DATA_PATH = tmp;
const root = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), ".."));

console.log(`[yt] url=${url}`);
console.log(`[yt] USER_DATA_PATH=${process.env.USER_DATA_PATH} tmp=${tmp} keep=${keep}`);
console.log(`[yt] root=${root} node=${process.version}`);

const { getRaw, nowIso } = await import(path.join(root, "dist/services/db.js"));
const { runAnalyze, runRender } = await import(path.join(root, "dist/services/pipeline.js"));
const db = getRaw();

const projectId = `yt_${Date.now()}`;
const now = nowIso();
db.prepare("INSERT INTO projects (id, title, source, source_type, source_key, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
  .run(projectId, "YT E2E Test", url, "youtube", null, "idle", now, now);
console.log(`[yt] project ${projectId} inserted`);

const jobId = `job_${Date.now()}`;
db.prepare("INSERT INTO jobs (id, project_id, type, status, stage, progress, options, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run(jobId, projectId, "analyze", "queued", "queued", 0, JSON.stringify({ max_clips: 3 }), now, now);
console.log(`[yt] job ${jobId} queued — downloading via yt-dlp (bv*[height<=1080]+ba) — this can take 30s-2min...`);

const t0 = Date.now();
await runAnalyze(jobId, (stage, prog) => {
  const pct = String(prog).padStart(3);
  process.stdout.write(`\r[yt] ${stage} ${pct}%`);
});
console.log(`\n[yt] analyze done ${(Date.now()-t0)/1000}s`);

const job = db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
console.log(`[yt] job status=${job.status} stage=${job.stage} progress=${job.progress} error=${job.error ?? ""}`);
if (job.status !== "completed") {
  console.error(`[yt] analyze failed — ${job.error}`);
  console.log(`[yt] hint: if 403/bot, try UPLOAD instead or retry. Check yt-dlp: node -e "console.log(require('electron/src/services/bin.ts'))"`);
  process.exit(1);
}

const clips = db.prepare("SELECT * FROM clips WHERE project_id=? ORDER BY start_time").all(projectId);
const words = db.prepare("SELECT * FROM timeline_words WHERE project_id=?").all(projectId);
const proj = db.prepare("SELECT * FROM projects WHERE id=?").get(projectId);
console.log(`[yt] clips=${clips.length} words=${words.length} source_key=${proj.source_key} bytes=${proj.source_key && fs.existsSync(proj.source_key) ? fs.statSync(proj.source_key).size : "?"}`);
for (const c of clips) console.log(`  - ${c.title} [${c.start_time.toFixed(1)}-${c.end_time.toFixed(1)}] hook="${c.hook ?? ""}" thumb=${c.thumbnail_url ? "yes":"no"}`);

if (!clips.length) {
  console.error("[yt] no clips — mock LLM may have returned 0 if transcript empty");
  process.exit(1);
}

// Render first clip
const clip = clips[0];
const renderId = `render_${Date.now()}`;
db.prepare("INSERT INTO jobs (id, project_id, type, clip_id, status, stage, progress, options, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run(renderId, projectId, "render", clip.id, "queued", "queued", 0, JSON.stringify({ orientation: "portrait" }), nowIso(), nowIso());
console.log(`[yt] render ${clip.id} -> job ${renderId}`);
await runRender(renderId, (s,p)=>process.stdout.write(`\r[yt] render ${s} ${p}%`));
console.log("");
const rjob = db.prepare("SELECT * FROM jobs WHERE id=?").get(renderId);
console.log(`[yt] render status=${rjob.status} error=${rjob.error ?? ""}`);
const updated = db.prepare("SELECT * FROM clips WHERE id=?").get(clip.id);
const out = String(updated.video_url ?? "");
console.log(`[yt] output ${out} ${out && fs.existsSync(out) ? `${(fs.statSync(out).size/1024).toFixed(1)} KB` : "MISSING"}`);
console.log(`[yt] source media:// media://${proj.source_key}`);
console.log(`[yt] done ok tmp=${tmp} project=${projectId}${keep ? " (kept)" : " — add --keep to retain"}`);
console.log(`[yt] Electron preview: USER_DATA_PATH=${tmp} npm --prefix electron run dev → open project ${projectId}`);
if (!keep) console.log(`[yt] tip: re-run with --keep or USER_DATA_PATH=/tmp/cf-yt to keep files`);
