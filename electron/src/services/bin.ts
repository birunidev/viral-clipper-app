import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";

export function getResourceBase(): string {
  if (process.env.RESOURCES_PATH) return process.env.RESOURCES_PATH;
  return (process as unknown as { resourcesPath?: string }).resourcesPath ?? (process.resourcesPath as unknown as string) ?? process.cwd();
}

export function archSuffix(): string {
  const a = process.arch;
  if (a === "arm64") return "arm64";
  if (a === "x64") return "x64";
  return a;
}

export function platformDir(): string {
  if (process.platform === "win32") return "win";
  if (process.platform === "darwin") return "mac";
  return "linux";
}

export function resolveBin(name: string): string | null {
  const base = getResourceBase();
  const plat = platformDir();
  const arch = archSuffix();
  const candidates = [
    path.join(base, "bin", `${plat}-${arch}`, name),
    path.join(base, "bin", plat, name),
    path.join(base, "bin", name),
    path.join(base, "resources", "bin", `${plat}-${arch}`, name),
    path.join(base, "resources", "bin", plat, name),
    path.join(process.cwd(), "resources", "bin", `${plat}-${arch}`, name),
    path.join(process.cwd(), "resources", "bin", plat, name),
    path.join(process.cwd(), "resources", "bin", name),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try { if (process.platform !== "win32") fs.chmodSync(p, 0o755); } catch {}
      return p;
    }
  }
  return null;
}

export function ffmpegPath(): string {
  const fromResources = resolveBin(process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  if (fromResources) return fromResources;
  try {
    const require = createRequire(import.meta.url);
    const p = require("ffmpeg-static");
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

export function ffprobePath(): string {
  const fromResources = resolveBin(process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  if (fromResources) return fromResources;
  try {
    const require = createRequire(import.meta.url);
    const p = require("ffprobe-static");
    if (p && typeof p === "string" && fs.existsSync(p)) return p;
    if (p && p.path && fs.existsSync(p.path)) return p.path;
  } catch {}
  return process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
}

export function ytdlpPath(): string {
  const exe = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const r = resolveBin(exe);
  if (r) return r;
  const alt = resolveBin("yt-dlp");
  if (alt) return alt;
  try {
    const require = createRequire(import.meta.url);
    const execPath = require.resolve("yt-dlp-exec/bin/yt-dlp");
    if (execPath && fs.existsSync(execPath)) {
      try { if (process.platform !== "win32") fs.chmodSync(execPath, 0o755); } catch {}
      return execPath;
    }
  } catch {}
  try {
    const p = path.join(process.cwd(), "node_modules", "yt-dlp-exec", "bin", exe);
    if (fs.existsSync(p)) return p;
  } catch {}
  return process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

export function whisperPath(): string {
  const exe = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  const r = resolveBin(exe);
  if (r) return r;
  const alt = resolveBin("whisper-cli");
  if (alt) return alt;
  return process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
}
