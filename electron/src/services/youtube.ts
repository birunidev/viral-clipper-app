import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export class DownloadError extends Error {}

function bin(): string {
  const base = path.join(process.resourcesPath ?? process.cwd(), "bin");
  const name = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const p = path.join(base, name);
  return fs.existsSync(p) ? p : "yt-dlp";
}

export async function getInfo(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin(), ["--dump-json", "--no-playlist", "--skip-download", url], { stdio: "pipe" });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (code === 0) {
        try { resolve(JSON.parse(out)); } catch { resolve({}); }
      } else reject(new DownloadError(err || "getInfo failed"));
    });
    p.on("error", (e) => reject(new DownloadError(String(e))));
  });
}

export function download(url: string, outDir: string, onProgress?: (f: number) => void): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true });
  const tmpl = path.join(outDir, "%(id)s.%(ext)s");
  const args = ["-f", "bv*[height<=1080]+ba/b[height<=1080]/b", "--merge-output-format", "mp4", "-o", tmpl, "--newline", url];
  return new Promise((resolve, reject) => {
    const p = spawn(bin(), args, { stdio: "pipe" });
    let err = "";
    p.stderr.on("data", (d) => {
      const s = d.toString();
      err += s;
      if (onProgress) {
        const m = s.match(/(\d+\.\d+)%/);
        if (m) onProgress(parseFloat(m[1]) / 100);
      }
    });
    p.stdout.on("data", (d) => {
      const s = d.toString();
      if (onProgress) {
        const m = s.match(/(\d+\.\d+)%/);
        if (m) onProgress(parseFloat(m[1]) / 100);
      }
    });
    p.on("close", (code) => {
      if (code === 0) {
        const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".mp4"));
        if (files.length) resolve(path.join(outDir, files.sort().at(-1)!));
        else reject(new DownloadError("no output file"));
      } else reject(new DownloadError(err || "download failed"));
    });
    p.on("error", (e) => reject(new DownloadError(String(e))));
  });
}

export function isUrl(v: string): boolean {
  return /^https?:\/\//i.test(v.trim());
}
