import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ytdlpPath } from "./bin.js";

const require = createRequire(import.meta.url);

export class DownloadError extends Error {}

function bin(): string { return ytdlpPath(); }

export async function getInfo(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const p = spawn(bin(), ["--dump-json", "--no-playlist", "--skip-download", url], { stdio: "pipe" });
    let out = "", err = "";
    const t = setTimeout(() => {
      if (!resolved) {
        try { p.kill("SIGTERM"); } catch {}
        reject(new DownloadError("getInfo timed out after 30s"));
      }
    }, 30000);
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      clearTimeout(t);
      if (resolved) return;
      resolved = true;
      if (code === 0) {
        try { resolve(JSON.parse(out)); } catch { resolve({}); }
      } else reject(new DownloadError(err.slice(0, 800) || "getInfo failed"));
    });
    p.on("error", (e) => {
      clearTimeout(t);
      if (resolved) return;
      resolved = true;
      const msg = String(e);
      if (msg.includes("ENOENT")) reject(new DownloadError(`yt-dlp not found at ${bin()} — install or bundle`));
      else reject(new DownloadError(msg));
    });
  });
}

export function download(url: string, outDir: string, onProgress?: (f: number) => void): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true });
  const tmpl = path.join(outDir, "%(id)s.%(ext)s");
  const args = ["-f", "bv*[height<=1080]+ba/b[height<=1080]/b", "--merge-output-format", "mp4", "-o", tmpl, "--newline", "--no-warnings", url];
  const binPath = bin();
  try {
    if (!fs.existsSync(binPath) && binPath !== "yt-dlp" && binPath !== "yt-dlp.exe") {
      // try yt-dlp-exec fallback
      try {
        const exec = require("yt-dlp-exec");
        if (exec) return (exec as unknown as { exec: (u:string, o:Record<string,unknown>)=>Promise<unknown> }).exec(url, { output: tmpl } as Record<string, unknown>).then(() => {
          const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".mp4"));
          if (files.length) return path.join(outDir, files.sort().at(-1)!);
          throw new DownloadError("no output file");
        }) as unknown as Promise<string>;
      } catch {}
    }
  } catch {}
  return new Promise((resolve, reject) => {
    let resolved = false;
    const p = spawn(binPath, args, { stdio: "pipe" });
    let err = "";
    let lastProgress = 0;
    const timeout = setTimeout(() => {
      if (!resolved) {
        try { p.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 5000);
        reject(new DownloadError("download timed out after 10 minutes — check network/youtube bot guard"));
      }
    }, 10 * 60 * 1000);
    const onData = (s: string) => {
      err += s;
      if (onProgress) {
        const m = s.match(/(\d+\.\d+)%/) || s.match(/(\d+)%/);
        if (m) {
          const v = parseFloat(m[1]) / 100;
          if (v > lastProgress) {
            lastProgress = v;
            onProgress(v);
          }
        }
      }
      if (s.includes("Sign in to confirm") || s.includes("bot") || s.includes("confirm you're not a bot")) {
        err += " (YouTube bot guard — try with cookies or try again later)";
      }
    };
    p.stderr.on("data", (d) => onData(d.toString()));
    p.stdout.on("data", (d) => onData(d.toString()));
    p.on("close", (code) => {
      clearTimeout(timeout);
      if (resolved) return;
      resolved = true;
      if (code === 0) {
        try {
          const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".mp4"));
          if (files.length) resolve(path.join(outDir, files.sort().at(-1)!));
          else reject(new DownloadError("no output file — yt-dlp finished but no mp4 found. Raw: " + err.slice(0, 500)));
        } catch (e) { reject(new DownloadError(String(e))); }
      } else {
        const hint = err.includes("bot") || err.includes("Sign in") ? " (YouTube bot guard — yt-dlp blocked, try cookies or use Upload)" : "";
        reject(new DownloadError((err.slice(0, 800) || "download failed") + hint));
      }
    });
    p.on("error", (e) => {
      clearTimeout(timeout);
      if (resolved) return;
      resolved = true;
      const msg = String(e);
      if (msg.includes("ENOENT")) {
        reject(new DownloadError(`yt-dlp not found at ${binPath} — install yt-dlp or bundle it in resources/bin/${process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux"}-${process.arch}/`));
      } else reject(new DownloadError(msg));
    });
  });
}

export function isUrl(v: string): boolean {
  return /^https?:\/\//i.test(v.trim());
}
