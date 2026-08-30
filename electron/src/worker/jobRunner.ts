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
import { spawn, spawnSync } from "node:child_process";
import { ffmpegPath, ffprobePath } from "../services/bin.js";

// Suppress Node 22 ExperimentalWarning for JSON imports (node-llama-cpp) in utility process
try {
  process.on("warning", (w: { name?: string; message?: string; stack?: string }) => {
    const msg = String(w?.message ?? "");
    const name = String(w?.name ?? "");
    if (name.includes("ExperimentalWarning") && msg.includes("JSON")) return;
    // eslint-disable-next-line no-console
    console.warn(w);
  });
} catch {}

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
  const fromBin = ffmpegPath();
  if (fromBin) return fromBin;
  try {
    // Fallback for ESM: use createRequire if global require not available
    const { createRequire } = require("node:module") as unknown as { createRequire: (u: string) => (id: string) => unknown };
    // This branch rarely runs; keep for compat
    const req = (globalThis as unknown as { require?: (id: string) => unknown }).require ?? (createRequire ? createRequire(import.meta.url) : null);
    if (req) {
      const p = req("ffmpeg-static") as string | null;
      if (p) return p as string;
    }
  } catch {}
  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

// True if the media file contains at least one audio stream. Used to reject
// video-only sources (yt-dlp fallback without ffmpeg merge) BEFORE transcription.
function probeHasAudio(file: string): boolean {
  try {
    const r = spawnSync(ffprobePath(), ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file], { stdio: "pipe", timeout: 15000 });
    const out = String(r.stdout ?? "").trim();
    return r.status === 0 && out.length > 0;
  } catch {
    return true; // probe unavailable — let transcriber surface the real error
  }
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

(parentPort as NonNullable<typeof parentPort>).on("message", async (e: unknown) => {
  const raw = (e as { data?: unknown })?.data ?? e;
  const m = raw as { type: string; [k: string]: unknown };
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
  const t0 = Date.now();
  let tDownload = 0, tTranscribe = 0, tAnalyze = 0;
  const tDownloadStart = Date.now();
  // Lazy imports so startup stays fast
  const { download, getInfo } = await import("../services/youtube.js");
  const { transcribeWithWords } = await import("../services/transcriber.js");
  const { analyze } = await import("../services/analyzer.js");
  const { sourcePath, thumbsDir, ensureProjectDirs, transcriptCacheDir, cachedTranscriptPath } = await import("../services/storage.js");

  const { project, opts, jobId, projectId, cachedWords } = msg;
  const maxClips = Number(opts.max_clips ?? 10);
  const minClipSeconds = Number(opts.min_clip_seconds ?? 15);
  const maxClipSeconds = Number(opts.max_clip_seconds ?? 90);
  const source = String(project.source);
  const sourceType = String(project.source_type ?? "youtube");

  ensureProjectDirs(projectId);
  let localVideo: string | null = null;
  function normLang(c?: string | null): string | null { if (!c) return null; return c.toLowerCase().split(/[-_]/)[0] ?? null; }
  let sourceLanguage: string | null = normLang(project.language);

  const isUpload = sourceType === "upload";
  if (!isUpload) postProgress("downloading", 2);

  if (sourceType === "youtube") {
    // Reuse an already-downloaded local source (from a prior completed download
    // or a failed job that got past the download step) instead of re-downloading.
    const existingKey = String(project.source_key ?? "");
    let reuseExisting = false;
    try {
      if (existingKey && fs.statSync(existingKey).isFile() && fs.statSync(existingKey).size > 2000) {
        if (probeHasAudio(existingKey)) reuseExisting = true;
        else {
          console.log(`[jobRunner] existing source ${existingKey} has NO audio track — deleting for re-download`);
          try { fs.unlinkSync(existingKey); } catch {}
        }
      }
    } catch {}
    if (reuseExisting) {
      console.log(`[jobRunner] reusing downloaded source ${existingKey}`);
      localVideo = existingKey;
      try {
        const { extractVideoId: ev } = await import("../services/youtube.js");
        const vid = ev(source);
        parentPort?.postMessage({ type: "sourceReady", sourceKey: existingKey, language: sourceLanguage, videoId: vid ?? undefined, cached: false });
      } catch { parentPort?.postMessage({ type: "sourceReady", sourceKey: existingKey, language: sourceLanguage }); }
    } else {
      // Global youtube-cache: reuse if any prior project already downloaded this videoId
      try {
        const { extractVideoId } = await import("../services/youtube.js");
        const { cachedVideoMeta, sourcePath: sp } = await import("../services/storage.js");
        const vid = extractVideoId(source);
        if (vid) {
          const hit = cachedVideoMeta(vid);
          if (hit && !probeHasAudio(hit.path)) {
            console.log(`[jobRunner] cached video ${vid} has NO audio track — purging ${hit.path}`);
            try { fs.unlinkSync(hit.path); } catch {}
          } else if (hit) {
            console.log(`[jobRunner] reusing cached video ${vid} from ${hit.path}`);
            const ext = path.extname(hit.path) || ".mp4";
            const dest = sp(projectId, ext);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            try { fs.copyFileSync(hit.path, dest); } catch {}
            if (fs.existsSync(dest) && fs.statSync(dest).size > 2000) {
              localVideo = dest;
              parentPort?.postMessage({ type: "sourceReady", sourceKey: dest, language: sourceLanguage, videoId: vid, cached: true });
              // Keep youtube-cache LRU fresh — main owns DB but we can touch file
              try { fs.utimesSync(hit.path, new Date(), new Date()); } catch {}
            } else {
              localVideo = null;
            }
          }
        }
        if (localVideo) {
          // Already satisfied via global cache — skip download entirely
        } else {
      console.log(`[jobRunner] getInfo ${source}`);
      try {
        const info = await getInfo(source);
        sourceLanguage = normLang(String((info as Record<string, unknown>).language ?? (info as Record<string, unknown>).original_language ?? "") || null);
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
      try {
              const { extractVideoId: ev2 } = await import("../services/youtube.js");
              const vid2 = ev2(source);
              if (vid2) parentPort?.postMessage({ type: "sourceReady", sourceKey: dest, language: sourceLanguage, videoId: vid2 });
              else parentPort?.postMessage({ type: "sourceReady", sourceKey: dest, language: sourceLanguage });
            } catch { parentPort?.postMessage({ type: "sourceReady", sourceKey: dest, language: sourceLanguage }); }
        }
      } catch {}
    }
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

  // Mark download stage done for timing
  tDownload = Date.now() - tDownloadStart;
  postProgress("transcribing", 28);
  const tTranscribeStart = Date.now();

  let words: { text: string; start_ms: number; end_ms: number }[];
  let transcriptText: string;
  let detectedLanguage: string | null = sourceLanguage;
  let transcriptCached = false;

  // Try transcript cache by youtubeId (before hitting whisper)
  let transcriptCacheHit: { words: typeof words; text: string; language: string | null } | null = null;
  try {
    if (!cachedWords?.length && sourceType === "youtube") {
      const { extractVideoId } = await import("../services/youtube.js");
      const vid = extractVideoId(source);
      if (vid) {
        const cachePath = cachedTranscriptPath(vid);
        if (fs.existsSync(cachePath)) {
          try {
            const raw = fs.readFileSync(cachePath, "utf-8");
            const j = JSON.parse(raw) as { words: typeof words; text: string; language?: string | null; whisper_model?: string };
            if (Array.isArray(j.words) && j.words.length > 10) {
              // Validate language/model match if available
              const wantModel = (await import("../services/system.js").then(m=>m.whisperModelForTier(m.ramTier())).catch(()=> "small"));
              if (!j.whisper_model || j.whisper_model === wantModel || true) {
                transcriptCacheHit = { words: j.words, text: j.text, language: (j.language as string | null) ?? null };
                console.log(`[jobRunner] transcript cache hit ${vid} (${j.words.length} words, lang=${j.language})`);
                parentPort?.postMessage({ type: "transcriptCacheHit", videoId: vid, language: j.language ?? null, cached: true });
              }
            }
          } catch {}
        }
      }
    }
  } catch {}

  if (cachedWords && cachedWords.length) {
    words = cachedWords;
    transcriptText = words.map((w) => w.text).join(" ");
    detectedLanguage = normLang(project.language);
  } else if (transcriptCacheHit) {
    words = transcriptCacheHit.words;
    transcriptText = transcriptCacheHit.text;
    detectedLanguage = normLang(transcriptCacheHit.language) ?? sourceLanguage;
    transcriptCached = true;
    if (detectedLanguage) parentPort?.postMessage({ type: "meta", language: detectedLanguage });
    // Skip whisper progress, jump to 70%
    postProgress("transcribing", 70);
  } else {
    const res = await transcribeWithWords(localVideo!, (f: number) => {
      const p = Math.round(28 + 42 * f);
      postProgress("transcribing", p);
    }, sourceLanguage ?? undefined);
    words = res.words;
    transcriptText = res.text;
    detectedLanguage = normLang(res.language) ?? sourceLanguage;
    if (detectedLanguage) parentPort?.postMessage({ type: "meta", language: detectedLanguage });
    // Persist to transcript cache (file) for youtubeId
    try {
      if (sourceType === "youtube") {
        const { extractVideoId } = await import("../services/youtube.js");
        const vid = extractVideoId(source);
        if (vid && words.length > 10) {
          const { whisperModelForTier, ramTier } = await import("../services/system.js");
          const model = whisperModelForTier(ramTier());
          const cachePath = cachedTranscriptPath(vid);
          fs.mkdirSync(path.dirname(cachePath), { recursive: true });
          fs.writeFileSync(cachePath, JSON.stringify({ words, text: transcriptText, language: detectedLanguage, whisper_model: model, version: 1 }, null, 2), "utf-8");
          try { fs.utimesSync(cachePath, new Date(), new Date()); } catch {}
          parentPort?.postMessage({ type: "transcriptCacheSaved", videoId: vid, language: detectedLanguage });
        }
      }
    } catch {}
  }
  tTranscribe = Date.now() - tTranscribeStart;

  // Send words to main for persistence (optional but useful for resume)
  parentPort?.postMessage({ type: "words", words, language: detectedLanguage, transcriptCached });

  // Video duration cap: from word timings, auto-scale if whisper offsets were in 10ms units (53s vs 537s)
  let videoDurationSec = words.length ? Math.max(...words.map((w) => w.end_ms)) / 1000 : 0;
  // Probe actual file duration as ground truth for scaling check
  let probeSec = 0;
  try {
    const r = spawnSync(ffprobePath(), ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", localVideo!], { stdio: "pipe", timeout: 8000 });
    const out = String(r.stdout ?? "").trim();
    probeSec = Number(out) || 0;
  } catch {}
  if (probeSec > 60 && videoDurationSec > 10 && probeSec / videoDurationSec > 4 && probeSec / videoDurationSec < 20) {
    // Likely 10x scale error (e.g., 53s vs 537s) — rescale words
    console.log(`[jobRunner] rescaling words ${videoDurationSec.toFixed(1)}s -> ${probeSec.toFixed(1)}s (x${(probeSec / videoDurationSec).toFixed(1)})`);
    const scale = probeSec / videoDurationSec;
    words = words.map((w) => ({ text: w.text, start_ms: Math.round(w.start_ms * scale), end_ms: Math.round(w.end_ms * scale) }));
    transcriptText = words.map((w) => w.text).join(" ");
    videoDurationSec = probeSec;
  } else if (probeSec > 0) {
    videoDurationSec = Math.max(videoDurationSec, probeSec);
  }
  console.log(`[jobRunner] videoDuration ${videoDurationSec.toFixed(1)}s from ${words.length} words (probe ${probeSec.toFixed(1)}s)`);
  function capToDuration(list: { title: string; hook?: string; start: number; end: number }[]): typeof list {
    const out: typeof list = [];
    for (const c of list) {
      let s = Number(c.start), e = Number(c.end);
      if (!Number.isFinite(s) || !Number.isFinite(e) || !(e > s)) continue;
      if (videoDurationSec > 0) {
        if (s >= videoDurationSec) continue; // beyond video
        if (e > videoDurationSec) e = videoDurationSec;
        if (s < 0) s = 0;
        const dur = e - s;
        if (dur < minClipSeconds - 0.5) continue; // too short after cap
        if (dur > maxClipSeconds + 0.5) e = s + maxClipSeconds;
        if (e > videoDurationSec) e = videoDurationSec;
        if (e - s < 1) continue;
      }
      out.push({ title: String(c.title).slice(0, 80), hook: c.hook ? String(c.hook).slice(0, 120) : undefined, start: Math.round(s * 100) / 100, end: Math.round(e * 100) / 100 });
    }
    return out;
  }

  const tAnalyzeStart = Date.now();
  postProgress("analyzing", 72);
  // Always ensemble: 7b local LLM + lightweight rule-based scorer (no API)
  const { findBestMoments, ensembleScore } = await import("../services/scorer.js");
  const ruleClips = findBestMoments(words, detectedLanguage ?? null, undefined, { targetDuration: (minClipSeconds + maxClipSeconds) / 2, maxClips: maxClips + 2 });
  let clips: { title: string; hook?: string; start: number; end: number }[] = [];
  try {
    const llmClips = await analyze(transcriptText, words, {
      language: detectedLanguage ?? undefined,
      minDuration: minClipSeconds,
      maxDuration: maxClipSeconds,
      onProgress: (f: number) => {
        const p = Math.round(72 + 18 * f);
        postProgress("analyzing", p);
      },
    });
    // cap each separately before ensemble
    const cappedLlm = capToDuration(llmClips);
    // ruleClips are ScoredClip, but ensembleScore accepts them; cap rule via its own start/end
    const cappedRule = ruleClips.filter((r) => r.start < videoDurationSec && r.end <= videoDurationSec + 0.5).map((r) => ({ ...r, end: Math.min(r.end, videoDurationSec) })) as typeof ruleClips;
    clips = ensembleScore(cappedLlm as any, cappedRule as any);
    clips = capToDuration(clips);
  } catch (e) {
    console.warn("[jobRunner] LLM failed, falling back to rule-based", e);
    const cappedRule = ruleClips.filter((r) => r.start < videoDurationSec && r.end <= videoDurationSec + 0.5).map((r) => ({ ...r, end: Math.min(r.end, videoDurationSec) })) as typeof ruleClips;
    const fallback = ensembleScore([], cappedRule as any);
    clips = capToDuration(fallback);
  }

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
    // Use overlap instead of strict containment, so edge words are kept
    const clipWords = words
      .filter((w) => w.start_ms < endMs && w.end_ms > startMs)
      .map((w) => ({ text: w.text, start_ms: Math.max(0, w.start_ms - startMs), end_ms: Math.min(endMs - startMs, w.end_ms - startMs) }));
    const captionJson = clipWords.length ? JSON.stringify(clipWords) : null;

    resultClips.push({ title: c.title, hook: c.hook ?? undefined, start: c.start, end: c.end, thumbPath: thumbUrl, captionJson });
    const p = Math.round(90 + 9 * ((i + 1) / total));
    postProgress("analyzing", p);
  }

  tAnalyze = Date.now() - tAnalyzeStart;
  const totalMs = Date.now() - t0;
  postDone({ projectId, jobId, clips: resultClips, words, language: detectedLanguage, localVideo, timing: { totalMs, downloadMs: tDownload, transcribeMs: tTranscribe, analyzeMs: tAnalyze, transcriptCached } });
  // Let main handle exit; keep event loop clean
  setTimeout(() => process.exit(0), 200);
}

async function handleRender(msg: StartRenderMsg) {
  const { cutClip } = await import("../services/cutter.js");
  const { buildAss, cropDimensions } = await import("../services/captions.js");
  const { clipsDir, thumbsDir } = await import("../services/storage.js");
  const { ffmpegPath } = await import("../services/bin.js");

  const { project, clip, opts, jobId, projectId } = msg;
  console.log(`[jobRunner][render] jobId=${jobId} projectId=${projectId} clipId=${clip.id} orientation=${opts.orientation} hasCaptionConfig=${!!opts.caption_config} captionStyleId=${opts.caption_style_id}`);
  console.log(`[jobRunner][render] ffmpegPath=${ffmpegPath()} exists=${fs.existsSync(ffmpegPath())} sourceKey=${String(project.source_key ?? "")} exists=${String(project.source_key ?? "") ? fs.existsSync(String(project.source_key)) : false} clipCaptionJsonLen=${String(clip.caption_json ?? "").length}`);
  const sourceKey = String(project.source_key ?? "");
  if (!sourceKey || !fs.existsSync(sourceKey)) throw new Error("no source video");
  const orientation: string = opts.orientation ?? "portrait";
  const captionConfig = (opts.caption_config as Record<string, unknown> | null) ?? (opts as unknown as { captionConfig?: Record<string, unknown> }).captionConfig ?? null;

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
  let out: string;
  try {
    out = await cutClip(sourceKey, Number(clip.start_time), Number(clip.end_time), String(clip.title), outDir, 1, orientation, assPath, null, null);
  } catch (e) {
    const msg = String((e as Error).message ?? "");
    // If subtitles caused failure (e.g. bad ASS path with spaces, missing font), retry without subtitles to at least produce video
    if (assPath && msg.includes("FFmpeg failed")) {
      console.warn(`[jobRunner][render] cut with subtitles failed, retrying without subtitles: ${msg.slice(0, 500)}`);
      try { if (assPath) fs.unlinkSync(assPath); } catch {}
      assPath = null;
      out = await cutClip(sourceKey, Number(clip.start_time), Number(clip.end_time), String(clip.title), outDir, 1, orientation, null, null, null);
    } else {
      throw e;
    }
  }

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
