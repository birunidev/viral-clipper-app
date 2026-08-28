/**
 * ClipZard job runner for Electron utilityProcess (NOT worker_threads).
 * Runs in a separate Node Utility Process forked via utilityProcess.fork.
 * - Isolated memory/V8, crash does not kill main.
 * - Communicates via process.parentPort (MessagePort).
 * - Does pure pipeline work (no SQLite writes). Main owns the DB.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const process: any;

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";

// Utility process entry — wait for start message from main
// process.parentPort is set by Electron's utilityProcess
const parentPort: { on: (e: string, cb: (msg: unknown) => void) => void; postMessage: (m: unknown) => void } | null =
  (process as unknown as { parentPort?: { on: (e: string, cb: (msg: unknown) => void) => void; postMessage: (m: unknown) => void } }).parentPort ?? null;

if (!parentPort) {
  console.error("[jobRunner] no parentPort — not running as utilityProcess");
  // Don't hard exit in typecheck; keep for runtime safety
  // process.exit(1);
}

type StartAnalyzeMsg = {
  type: "start";
  jobId: string;
  projectId: string;
  jobType: "analyze";
  project: { id: string; title: string; source: string; source_type: string; source_key: string | null; language: string | null };
  opts: { max_clips?: number; min_clip_seconds?: number; max_clip_seconds?: number };
  cachedWords?: { text: string; start_ms: number; end_ms: number }[];
};

type StartRenderMsg = {
  type: "start";
  jobId: string;
  projectId: string;
  clipId: string;
  jobType: "render";
  project: { id: string; source_key: string | null };
  clip: { id: string; title: string; start_time: number; end_time: number; caption_json: string | null; thumbnail_url: string | null };
  opts: { orientation?: string; caption_style_id?: string | null; caption_config?: Record<string, unknown> | null };
};

function ffmpegBin(): string {
  try {
    const p = require("ffmpeg-static");
    if (p) return p;
  } catch {}
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

function postProgress(stage: string, progress: number) {
  parentPort?.postMessage({ type: "progress", stage, progress });
}

function postDone(payload: unknown) {
  parentPort?.postMessage({ type: "done", payload });
}

function postError(error: string) {
  parentPort?.postMessage({ type: "error", error });
}

(parentPort as NonNullable<typeof parentPort>).on("message", async (msg: unknown) => {
  const m = msg as { type: string; [k: string]: unknown };
  if (!m || m.type !== "start") return;
  const jobId = String((m as Record<string, unknown>).jobId ?? "");
  const projectId = String((m as Record<string, unknown>).projectId ?? "");
  const jobType = String((m as Record<string, unknown>).jobType ?? "analyze");
  console.log(`[jobRunner] start ${jobType} jobId=${jobId} projectId=${projectId}`);
  try {
    if (jobType === "render") {
      await handleRender(m as unknown as StartRenderMsg);
    } else {
      await handleAnalyze(m as unknown as StartAnalyzeMsg);
    }
  } catch (e) {
    console.error("[jobRunner] failed", e);
    postError(String((e as Error).message ?? e).slice(0, 800));
  }
});

async function handleAnalyze(msg: StartAnalyzeMsg) {
  // Lazy imports so startup stays fast
  const { download, getInfo } = await import("../services/youtube.js");
  const { transcribeWithWords } = await import("../services/transcriber.js");
  const { analyze } = await import("../services/analyzer.js");
  const { sourcePath, thumbsDir, ensureProjectDirs } = await import("../services/storage.js");

  const { project, opts, jobId, projectId, cachedWords } = msg;
  const maxClips = Number(opts.max_clips ?? 10);
  const minClipSeconds = Number(opts.min_clip_seconds ?? 15);
  const maxClipSeconds = Number(opts.max_clip_seconds ?? 90);
  const source = String(project.source);
  const sourceType = String(project.source_type ?? "youtube");

  ensureProjectDirs(projectId);
  let localVideo: string | null = null;
  let sourceLanguage: string | null = project.language ?? null;

  const isUpload = sourceType === "upload";
  if (!isUpload) postProgress("downloading", 2);

  if (sourceType === "youtube") {
    console.log(`[jobRunner] getInfo ${source}`);
    try {
      const info = await getInfo(source);
      sourceLanguage = String((info as Record<string, unknown>).language ?? (info as Record<string, unknown>).original_language ?? "") || null;
      if (sourceLanguage) parentPort?.postMessage({ type: "meta", language: sourceLanguage });
      console.log(`[jobRunner] getInfo ok lang=${sourceLanguage} title=${String((info as any).title ?? "").slice(0,60)}`);
    } catch (e) {
      console.warn(`[jobRunner] getInfo failed ${(e as Error).message?.slice(0,300)}`);
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipzard_dl_"));
    console.log(`[jobRunner] download start tmp=${tmpDir}`);
    try {
      const { ytdlpPath } = await import("../services/bin.js");
      const bin = ytdlpPath();
      console.log(`[jobRunner] ytdlp bin=${bin} exists=${fs.existsSync(bin)}`);
      const { cookiesArgs } = await import("../services/youtube.js").then(() => ({ cookiesArgs: null })).catch(() => ({ cookiesArgs: null }));
      // log cookies candidates via direct check
      const candidates = [
        process.env.YTDLP_COOKIEFILE,
        process.env.USER_DATA_PATH ? `${process.env.USER_DATA_PATH}/cookies.txt` : null,
        `${os.homedir()}/.config/clipzard-desktop/cookies.txt`,
        "/tmp/cookies.txt",
      ].filter(Boolean) as string[];
      console.log(`[jobRunner] cookies candidates ${candidates.map(c => `${c}:${fs.existsSync(c as string)}`).join(", ")}`);
    } catch {}
    localVideo = await download(source, tmpDir, (f: number) => {
      const p = Math.round(2 + 23 * f);
      console.log(`[jobRunner] download progress ${Math.round(f*100)}% -> ${p}%`);
      postProgress("downloading", p);
    });
    console.log(`[jobRunner] download done ${localVideo}`);
    const ext = path.extname(localVideo) || ".mp4";
    const dest = sourcePath(projectId, ext);
    fs.copyFileSync(localVideo, dest);
    localVideo = dest;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    parentPort?.postMessage({ type: "sourceReady", sourceKey: dest, language: sourceLanguage });
  } else {
    // upload: copy is instant, go straight to transcribing — no downloading stage
    postProgress("transcribing", 5);
    const srcKey = String(project.source_key ?? project.source);
    if (!srcKey || !fs.existsSync(srcKey)) throw new Error("source not found");
    const ext = path.extname(srcKey) || ".mp4";
    const dest = sourcePath(projectId, ext);
    if (srcKey !== dest) fs.copyFileSync(srcKey, dest);
    localVideo = dest;
    parentPort?.postMessage({ type: "sourceReady", sourceKey: dest, language: sourceLanguage });
  }

  postProgress("transcribing", 28);

  let words: { text: string; start_ms: number; end_ms: number }[];
  let transcriptText: string;
  let detectedLanguage: string | null = sourceLanguage;

  if (cachedWords && cachedWords.length) {
    words = cachedWords;
    transcriptText = words.map((w) => w.text).join(" ");
    detectedLanguage = project.language ?? null;
  } else {
    const res = await transcribeWithWords(localVideo!, (f: number) => {
      const p = Math.round(28 + 42 * f);
      postProgress("transcribing", p);
    }, sourceLanguage ?? undefined);
    words = res.words;
    transcriptText = res.text;
    detectedLanguage = res.language ?? sourceLanguage;
    if (detectedLanguage) parentPort?.postMessage({ type: "meta", language: detectedLanguage });
  }

  // Send words to main for persistence (optional but useful for resume)
  parentPort?.postMessage({ type: "words", words, language: detectedLanguage });

  postProgress("analyzing", 72);
  const clips = await analyze(transcriptText, words, {
    language: detectedLanguage ?? undefined,
    minDuration: minClipSeconds,
    maxDuration: maxClipSeconds,
    onProgress: (f: number) => {
      const p = Math.round(72 + 18 * f);
      postProgress("analyzing", p);
    },
  });

  const sliced = clips.slice(0, maxClips);
  if (!sliced.length) throw new Error("model returned no clips");

  const resultClips: { title: string; hook?: string; start: number; end: number; thumbPath: string | null; captionJson: string | null }[] = [];
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

    resultClips.push({ title: c.title, hook: c.hook ?? undefined, start: c.start, end: c.end, thumbPath: thumbUrl, captionJson });
    const p = Math.round(90 + 9 * ((i + 1) / total));
    postProgress("analyzing", p);
  }

  postDone({ projectId, jobId, clips: resultClips, words, language: detectedLanguage, localVideo });
  // Let main handle exit; keep event loop clean
  setTimeout(() => process.exit(0), 200);
}

async function handleRender(msg: StartRenderMsg) {
  const { cutClip } = await import("../services/cutter.js");
  const { buildAss, cropDimensions } = await import("../services/captions.js");
  const { clipsDir, thumbsDir } = await import("../services/storage.js");

  const { project, clip, opts, jobId, projectId } = msg;
  const sourceKey = String(project.source_key ?? "");
  if (!sourceKey || !fs.existsSync(sourceKey)) throw new Error("no source video");
  const orientation: string = opts.orientation ?? "portrait";
  const captionConfig = opts.caption_config ?? null;

  parentPort?.postMessage({ type: "progress", stage: "cutting", progress: 2 });

  let assPath: string | null = null;
  if (captionConfig && clip.caption_json) {
    const words = JSON.parse(String(clip.caption_json ?? "[]")) as { text: string; start_ms: number; end_ms: number }[];
    if (words.length) {
      const dims: [number, number] = [1280, 720];
      const [outW, outH] = cropDimensions(dims[0], dims[1], orientation);
      const ass = buildAss(words, captionConfig as Record<string, unknown>, outW, outH);
      const tmpDir = path.join(os.tmpdir(), `clipzard_render_${jobId}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      assPath = path.join(tmpDir, "captions.ass");
      fs.writeFileSync(assPath, ass, "utf-8");
    }
  }

  const outDir = clipsDir(projectId);
  const out = await cutClip(sourceKey, Number(clip.start_time), Number(clip.end_time), String(clip.title), outDir, 1, orientation, assPath, null, null);

  // Ensure thumbnail if missing
  let thumbPath = clip.thumbnail_url;
  if (!thumbPath) {
    const thumbDest = path.join(thumbsDir(projectId), `${clip.id}.jpg`);
    if (await thumbnailOffsets(sourceKey, Number(clip.start_time), Number(clip.end_time), thumbDest)) {
      thumbPath = thumbDest;
    }
  }

  if (assPath) { try { fs.unlinkSync(assPath); } catch {} }

  postDone({ projectId, jobId, clipId: clip.id, videoUrl: out, thumbPath });
  setTimeout(() => process.exit(0), 200);
}
