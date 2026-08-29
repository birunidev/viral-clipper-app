import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { getRaw, nowIso } from "./db.js";
import { download, getInfo } from "./youtube.js";
import { transcribeWithWords } from "./transcriber.js";
import { analyze } from "./analyzer.js";
import { cutClip } from "./cutter.js";
import { buildAss, cropDimensions } from "./captions.js";
import { sourcePath, clipsDir, thumbsDir, ensureProjectDirs } from "./storage.js";

function ffmpegBin(): string {
  try { const p = require("ffmpeg-static"); if (p) return p; } catch {}
  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

function thumbnail(src: string, at: number, dest: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(ffmpegBin(), ["-y", "-hide_banner", "-loglevel", "error", "-ss", at.toFixed(2), "-i", src, "-frames:v", "1", "-q:v", "3", dest], { stdio: "pipe" });
    p.on("close", (c) => resolve(c === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0));
    p.on("error", () => resolve(false));
  });
}

async function thumbnailOffsets(src: string, start: number, end: number, dest: string): Promise<boolean> {
  const dur = Math.max(end - start, 0.1);
  const candidates = [start + dur / 2, start + Math.min(1, dur / 4), Math.max(start, end - 1)];
  for (let i = 0; i < candidates.length; i++) {
    const attempt = i === 0 ? dest : `${dest}.${i}`;
    if (await thumbnail(src, candidates[i], attempt)) {
      if (i > 0) fs.renameSync(attempt, dest);
      return true;
    }
    try { fs.unlinkSync(attempt); } catch {}
  }
  return false;
}

function probeDuration(p: string): number {
  return 0;
}

function probeDimensions(p: string): [number, number] | null {
  return null;
}

export async function runAnalyze(jobId: string, onProgress?: (stage: string, progress: number) => void) {
  const db = getRaw();
  const job = db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId) as Record<string, unknown> | undefined;
  if (!job) return;
  const projectId = String(job.project_id);
  const project = db.prepare("SELECT * FROM projects WHERE id=?").get(projectId) as Record<string, unknown> | undefined;
  if (!project) throw new Error(`Project ${projectId} not found`);
  const opts = JSON.parse(String(job.options ?? "{}"));
  const maxClips = Number(opts.max_clips ?? 10);
  const minClipSeconds = Number(opts.min_clip_seconds ?? 15);
  const maxClipSeconds = Number(opts.max_clip_seconds ?? 90);
  const source = String(project.source);
  const sourceType = String(project.source_type ?? "youtube");

  db.prepare("UPDATE jobs SET status='running', stage='downloading', progress=2 WHERE id=?").run(jobId);
  db.prepare("UPDATE projects SET status='running' WHERE id=?").run(projectId);

  ensureProjectDirs(projectId);
  let localVideo: string | null = null;
  function norm(c?: string | null): string | null { if (!c) return null; return c.toLowerCase().split(/[-_]/)[0] ?? null; }
  let sourceLanguage: string | null = norm(String((project as Record<string, unknown>).language as string | null ?? null));

  try {
    onProgress?.("downloading", 2);
    if (sourceType === "youtube") {
      try {
        const info = await getInfo(source);
        sourceLanguage = norm(String((info as Record<string, unknown>).language ?? (info as Record<string, unknown>).original_language ?? "") || null) ?? sourceLanguage;
        if (sourceLanguage) db.prepare("UPDATE projects SET language=? WHERE id=?").run(sourceLanguage, projectId);
      } catch {}
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipzard_dl_"));
      localVideo = await download(source, tmpDir, (f) => {
        const p = Math.round(2 + 23 * f);
        db.prepare("UPDATE jobs SET progress=? WHERE id=?").run(p, jobId);
        onProgress?.("downloading", p);
      });
      const ext = path.extname(localVideo) || ".mp4";
      const dest = sourcePath(projectId, ext);
      fs.copyFileSync(localVideo, dest);
      db.prepare("UPDATE projects SET source_key=? WHERE id=?").run(dest, projectId);
      localVideo = dest;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    } else {
      const srcKey = String(project.source_key ?? project.source);
      if (!fs.existsSync(srcKey)) throw new Error("source not found");
      const ext = path.extname(srcKey) || ".mp4";
      const dest = sourcePath(projectId, ext);
      if (srcKey !== dest) fs.copyFileSync(srcKey, dest);
      db.prepare("UPDATE projects SET source_key=? WHERE id=?").run(dest, projectId);
      localVideo = dest;
    }

    db.prepare("UPDATE jobs SET stage='transcribing', progress=28 WHERE id=?").run(jobId);
    onProgress?.("transcribing", 28);

    const cached = db.prepare("SELECT * FROM timeline_words WHERE project_id=? ORDER BY idx").all(projectId) as Record<string, unknown>[];
    let words: { text: string; start_ms: number; end_ms: number }[];
    let transcriptText: string;
    let detectedLanguage: string | null = sourceLanguage;
    if (cached.length) {
      words = cached.map((r) => ({ text: String(r.text), start_ms: Number(r.start_ms), end_ms: Number(r.end_ms) }));
      transcriptText = words.map((w) => w.text).join(" ");
      detectedLanguage = norm(String(project.language ?? "") || null) ?? sourceLanguage;
    } else {
      const res = await transcribeWithWords(localVideo!, (f) => {
        const p = Math.round(28 + 42 * f);
        db.prepare("UPDATE jobs SET progress=? WHERE id=?").run(p, jobId);
        onProgress?.("transcribing", p);
      }, sourceLanguage ?? undefined);
      words = res.words;
      transcriptText = res.text;
      detectedLanguage = norm(res.language) ?? sourceLanguage;
      if (detectedLanguage) db.prepare("UPDATE projects SET language=? WHERE id=?").run(detectedLanguage, projectId);
      const insert = db.prepare("INSERT INTO timeline_words (id, project_id, idx, text, start_ms, end_ms) VALUES (?,?,?,?,?,?)");
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM timeline_words WHERE project_id=?").run(projectId);
        for (let i = 0; i < words.length; i++) insert.run(`${projectId}_${i}`, projectId, i, words[i].text, words[i].start_ms, words[i].end_ms);
      });
      tx();
    }

    db.prepare("UPDATE jobs SET stage='analyzing', progress=72 WHERE id=?").run(jobId);
    onProgress?.("analyzing", 72);
    const clips = await analyze(transcriptText, words, {
      language: detectedLanguage ?? undefined,
      minDuration: minClipSeconds,
      maxDuration: maxClipSeconds,
      onProgress: (f) => {
        const p = Math.round(72 + 18 * f);
        db.prepare("UPDATE jobs SET progress=? WHERE id=?").run(p, jobId);
        onProgress?.("analyzing", p);
      },
    });
    const sliced = clips.slice(0, maxClips);
    if (!sliced.length) throw new Error("model returned no clips");

    const total = Math.max(sliced.length, 1);
    for (let i = 0; i < sliced.length; i++) {
      const c = sliced[i];
      const thumbName = `thumb_${String(i + 1).padStart(2, "0")}.jpg`;
      const thumbDest = path.join(thumbsDir(projectId), thumbName);
      let thumbUrl: string | null = null;
      if (await thumbnailOffsets(localVideo!, c.start, c.end, thumbDest)) thumbUrl = thumbDest;

      const startMs = Math.round(c.start * 1000), endMs = Math.round(c.end * 1000);
      const clipWords = words.filter((w) => w.start_ms >= startMs && w.end_ms <= endMs).map((w) => ({ text: w.text, start_ms: w.start_ms - startMs, end_ms: w.end_ms - startMs }));
      const captionJson = clipWords.length ? JSON.stringify(clipWords) : null;

      const clipId = `${jobId}_${i}`;
      db.prepare("INSERT INTO clips (id, project_id, job_id, title, viral_hook, start_time, end_time, thumbnail_url, caption_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(clipId, projectId, jobId, c.title, c.hook ?? null, c.start, c.end, thumbUrl, captionJson, nowIso());
      const p = Math.round(90 + 9 * ((i + 1) / total));
      db.prepare("UPDATE jobs SET progress=? WHERE id=?").run(p, jobId);
      onProgress?.("analyzing", p);
    }

    db.prepare("UPDATE jobs SET status='completed', stage=NULL, progress=100 WHERE id=?").run(jobId);
    db.prepare("UPDATE projects SET status='completed' WHERE id=?").run(projectId);
    onProgress?.("completed", 100);
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 500);
    db.prepare("UPDATE jobs SET status='failed', error=? WHERE id=?").run(msg, jobId);
    db.prepare("UPDATE projects SET status='failed' WHERE id=?").run(projectId);
    throw e;
  }
}

export async function runRender(jobId: string, onProgress?: (stage: string, progress: number) => void) {
  const db = getRaw();
  const job = db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId) as Record<string, unknown> | undefined;
  if (!job) return;
  const clipId = String(job.clip_id ?? "");
  if (!clipId) throw new Error("missing clip_id");
  const clip = db.prepare("SELECT * FROM clips WHERE id=?").get(clipId) as Record<string, unknown> | undefined;
  if (!clip) throw new Error(`Clip ${clipId} not found`);
  const projectId = String(job.project_id);
  const project = db.prepare("SELECT * FROM projects WHERE id=?").get(projectId) as Record<string, unknown> | undefined;
  if (!project) throw new Error(`Project ${projectId} not found`);
  const sourceKey = String(project.source_key ?? "");
  if (!sourceKey || !fs.existsSync(sourceKey)) throw new Error("no source video");
  const opts = JSON.parse(String(job.options ?? "{}"));
  const orientation: string = opts.orientation ?? "portrait";
  const captionStyleId: string | null = opts.caption_style_id ?? null;

  db.prepare("UPDATE jobs SET status='running', stage='cutting', progress=2 WHERE id=?").run(jobId);
  onProgress?.("cutting", 2);

  let assPath: string | null = null;
  if (captionStyleId) {
    const style = db.prepare("SELECT * FROM caption_styles WHERE id=?").get(captionStyleId) as Record<string, unknown> | undefined;
    if (!style) throw new Error(`style ${captionStyleId} not found`);
    const config = JSON.parse(String(style.config));
    const words = JSON.parse(String(clip.caption_json ?? "[]"));
    if (words.length) {
      const dims: [number, number] = [1280, 720];
      const [outW, outH] = cropDimensions(dims[0], dims[1], orientation);
      const ass = buildAss(words, config, outW, outH);
      const tmpDir = path.join(os.tmpdir(), `clipzard_render_${jobId}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      assPath = path.join(tmpDir, "captions.ass");
      fs.writeFileSync(assPath, ass, "utf-8");
    }
  }

  const outDir = clipsDir(projectId);
  const out = await cutClip(sourceKey, Number(clip.start_time), Number(clip.end_time), String(clip.title), outDir, 1, orientation, assPath, null, null);
  db.prepare("UPDATE clips SET video_url=? WHERE id=?").run(out, clipId);

  if (!clip.thumbnail_url) {
    const thumbDest = path.join(thumbsDir(projectId), `${clipId}.jpg`);
    if (await thumbnailOffsets(sourceKey, Number(clip.start_time), Number(clip.end_time), thumbDest)) {
      db.prepare("UPDATE clips SET thumbnail_url=? WHERE id=?").run(thumbDest, clipId);
    }
  }

  db.prepare("UPDATE jobs SET status='completed', stage=NULL, progress=100 WHERE id=?").run(jobId);
  onProgress?.("completed", 100);
  if (assPath) { try { fs.unlinkSync(assPath); } catch {} }
}
