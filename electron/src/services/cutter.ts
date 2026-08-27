import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const PORTRAIT = "portrait";
export const LANDSCAPE = "landscape";
export const ORIGINAL = "original";

const PORTRAIT_FILTER = "crop=min(iw\\,ih*9/16):ih:(iw-min(iw\\,ih*9/16))/2:0";
const LANDSCAPE_FILTER = "crop=iw:min(ih\\,iw*9/16):0:(ih-min(ih\\,iw*9/16))/2";

export class CutterError extends Error {}

export function cropFilterFor(o: string): string | null {
  if (!o || o === PORTRAIT) return PORTRAIT_FILTER;
  if (o === LANDSCAPE) return LANDSCAPE_FILTER;
  if (o === ORIGINAL) return null;
  throw new CutterError(`Unknown orientation: ${o}`);
}

function ffmpegPath(): string {
  try {
    const p = require("ffmpeg-static");
    if (p) return p;
  } catch {}
  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function subtitlesFilterFor(assPath: string, fontsDir?: string): string {
  const e = escapeFilterPath(assPath);
  return fontsDir ? `subtitles=${e}:fontsdir=${escapeFilterPath(fontsDir)}` : `subtitles=${e}`;
}

function scaleFilter(maxRes?: number | null): string | null {
  if (!maxRes) return null;
  return `scale=min(iw\\,${maxRes}):min(ih\\,${maxRes}):force_original_aspect_ratio=decrease`;
}

export function slugify(title: string): string {
  return title.trim().replace(/[^A-Za-z0-9]+/g, "-").toLowerCase().replace(/^-|-$/g, "") || "clip";
}

export function buildCommand(src: string, start: number, end: number, title: string, outDir: string, index: number, orientation = PORTRAIT, subtitlesPath?: string | null, fontsDir?: string | null, maxResolution?: number | null): string[] {
  const duration = Math.max(end - start, 0.1);
  const outPath = path.join(outDir, `${slugify(title)}_${String(index).padStart(2, "0")}.mp4`);
  const cmd: string[] = [ffmpegPath(), "-y", "-hide_banner", "-loglevel", "error", "-ss", start.toFixed(2), "-i", src, "-t", duration.toFixed(2)];
  const filters: string[] = [];
  const crop = cropFilterFor(orientation);
  if (crop) filters.push(crop);
  const scale = scaleFilter(maxResolution);
  if (scale) filters.push(scale);
  if (subtitlesPath) filters.push(subtitlesFilterFor(subtitlesPath, fontsDir ?? undefined));
  if (filters.length) cmd.push("-vf", filters.join(","));
  cmd.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outPath);
  return cmd;
}

export function cutClip(src: string, start: number, end: number, title: string, outDir: string, index: number, orientation = PORTRAIT, subtitlesPath?: string | null, fontsDir?: string | null, maxResolution?: number | null): Promise<string> {
  if (!fs.existsSync(src)) return Promise.reject(new CutterError(`Source not found: ${src}`));
  fs.mkdirSync(outDir, { recursive: true });
  const cmd = buildCommand(src, start, end, title, outDir, index, orientation, subtitlesPath, fontsDir, maxResolution);
  const outPath = cmd[cmd.length - 1];
  return new Promise((resolve, reject) => {
    const [bin, ...args] = cmd;
    const p = spawn(bin, args, { stdio: "pipe" });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) => reject(new CutterError(String(e))));
    p.on("close", (code) => {
      if (code === 0 && fs.existsSync(outPath)) resolve(outPath);
      else reject(new CutterError(`FFmpeg failed for ${title}: ${stderr.split("\n").pop() ?? "unknown"}`));
    });
  });
}
