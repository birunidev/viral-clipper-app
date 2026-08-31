import path from "node:path";
import fs from "node:fs";
import { userDataRoot } from "./userData.js";

export function projectsRoot(): string {
  const r = path.join(userDataRoot(), "projects");
  fs.mkdirSync(r, { recursive: true });
  return r;
}

export function projectDir(projectId: string): string {
  const d = path.join(projectsRoot(), projectId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function sourcePath(projectId: string, ext = ".mp4"): string {
  return path.join(projectDir(projectId), `source${ext}`);
}

export function clipsDir(projectId: string): string {
  const d = path.join(projectDir(projectId), "clips");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function thumbsDir(projectId: string): string {
  const d = path.join(projectDir(projectId), "thumbs");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function clipPath(projectId: string, filename: string): string {
  return path.join(clipsDir(projectId), filename);
}

export function thumbPath(projectId: string, filename: string): string {
  return path.join(thumbsDir(projectId), filename);
}

export function youtubeCacheDir(): string {
  const d = path.join(userDataRoot(), "youtube-cache");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function cachedVideoPath(videoId: string, ext = ".mp4"): string {
  return path.join(youtubeCacheDir(), `${videoId}${ext}`);
}

export function cachedVideoMeta(videoId: string): { path: string; size: number } | null {
  const p = cachedVideoPath(videoId);
  try {
    const st = fs.statSync(p);
    if (st.isFile() && st.size > 2000) return { path: p, size: st.size };
  } catch {}
  for (const ext of [".mp4", ".webm", ".mkv", ".m4v"] as const) {
    const alt = cachedVideoPath(videoId, ext);
    if (alt === p) continue;
    try {
      const st = fs.statSync(alt);
      if (st.isFile() && st.size > 2000) return { path: alt, size: st.size };
    } catch {}
  }
  return null;
}

export function ensureProjectDirs(projectId: string) {
  projectDir(projectId);
  clipsDir(projectId);
  thumbsDir(projectId);
}

export function transcriptCacheDir(): string {
  const d = path.join(userDataRoot(), "transcript-cache");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function cachedTranscriptPath(videoId: string): string {
  return path.join(transcriptCacheDir(), `${videoId}.json`);
}

// File-based transcript cache helpers (complements DB transcript_cache table for quick touch/LRU)
export function cachedTranscriptMetaFile(videoId: string): { path: string; size: number } | null {
  const p = cachedTranscriptPath(videoId);
  try {
    const st = fs.statSync(p);
    if (st.isFile() && st.size > 100) return { path: p, size: st.size };
  } catch {}
  return null;
}
