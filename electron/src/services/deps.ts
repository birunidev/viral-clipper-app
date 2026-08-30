import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { whisperModelForTier, llmModelForTier, ramTier } from "./system.js";
import { whisperStatus } from "./models.js";
import { ffmpegPath, ffprobePath, whisperPath, ytdlpPath } from "./bin.js";

const require = createRequire(import.meta.url);

export type DepStatus = {
  key: string;
  label: string;
  installed: boolean;
  path: string | null;
  bytesOnDisk?: number;
  sizeMb?: number;
  description: string;
  required: boolean;
};

export function getDepsStatus(): DepStatus[] {
  const tier = ramTier();
  const whisper = whisperStatus();
  const llm = llmModelForTier(tier);

  const out: DepStatus[] = [];

  // Whisper model (large-v3 for high tier)
  out.push({
    key: "whisper-model",
    label: `Whisper ${whisper.model}`,
    installed: whisper.installed,
    path: whisper.path,
    bytesOnDisk: whisper.bytesOnDisk,
    sizeMb: whisper.model === "large-v3" ? 3095 : whisper.model === "medium" ? 1534 : 488,
    description: whisper.installed ? "Ready" : `Will download ${whisper.model} (~${whisper.model === "large-v3" ? "3.0 GB" : whisper.model === "medium" ? "1.5 GB" : "0.5 GB"})`,
    required: true,
  });

  // LLM model (7b default) — use same userDataRoot logic as models.ts (handles ESM + USER_DATA_PATH)
  try {
    const llmPath = path.join(
      (() => {
        if (process.env.USER_DATA_PATH) return process.env.USER_DATA_PATH;
        try {
          const { app } = require("electron") as { app: { getPath: (n: string) => string } };
          return app.getPath("userData");
        } catch { return path.join(process.cwd(), ".data"); }
      })(),
      "models",
      "llm",
      llm.file
    );
    let bytes = 0;
    try { if (fs.existsSync(llmPath)) bytes = fs.statSync(llmPath).size; } catch {}
    const expectedMb = llm.file.includes("7b") ? 4700 : llm.file.includes("1.5b") ? 950 : 380;
    out.push({
      key: "llm-model",
      label: `LLM ${llm.file}`,
      installed: bytes > 1024 * 1024,
      path: llmPath,
      bytesOnDisk: bytes,
      sizeMb: expectedMb,
      description: bytes > 1024 * 1024 ? "Ready" : `Will download ${expectedMb} MB`,
      required: true,
    });
  } catch {}

  // Whisper binary
  const wBin = whisperPath();
  out.push({
    key: "whisper-binary",
    label: "Whisper CLI",
    installed: fs.existsSync(wBin),
    path: wBin,
    description: fs.existsSync(wBin) ? "Ready (prebuilt)" : "Missing — run setup:whisper",
    required: true,
  });

  // FFmpeg
  const fbin = ffmpegPath();
  out.push({
    key: "ffmpeg",
    label: "FFmpeg",
    installed: fs.existsSync(fbin),
    path: fbin,
    description: fs.existsSync(fbin) ? "Ready" : "Missing — bundled via ffmpeg-static",
    required: true,
  });

  const fpbin = ffprobePath();
  out.push({
    key: "ffprobe",
    label: "FFprobe",
    installed: fs.existsSync(fpbin),
    path: fpbin,
    description: fs.existsSync(fpbin) ? "Ready" : "Missing",
    required: true,
  });

  // yt-dlp
  const ybin = ytdlpPath();
  out.push({
    key: "ytdlp",
    label: "yt-dlp",
    installed: fs.existsSync(ybin),
    path: ybin,
    description: fs.existsSync(ybin) ? "Ready" : "Missing — bundled via yt-dlp-exec",
    required: true,
  });

  // GPU check (optional, not required but nice) — robust for Windows ESM + packaged app
  let gpu = false;
  let gpuName = "";
  const trySmi = (cmd: string, args: string[], opts: Record<string, unknown> = {}) => {
    try {
      const r = spawnSync(cmd, args, { timeout: 2000, ...opts } as never);
      const out = String((r.stdout as unknown as string) ?? "").trim();
      if (r.status === 0 && out.length > 0) {
        gpu = true;
        gpuName = out.split("\n")[0].trim();
        return true;
      }
    } catch {}
    return false;
  };
  // Try nvidia-smi in PATH (with and without .exe, with and without shell)
  if (!gpu) trySmi("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]);
  if (!gpu) trySmi("nvidia-smi.exe", ["--query-gpu=name", "--format=csv,noheader"]);
  if (!gpu) trySmi("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { shell: true });
  if (!gpu) trySmi("nvidia-smi.exe", ["--query-gpu=name", "--format=csv,noheader"], { shell: true });
  // Explicit System32 path (always present on Windows, but may not be in Electron's PATH when launched from shortcut)
  if (!gpu && process.platform === "win32") {
    trySmi("C:\\Windows\\System32\\nvidia-smi.exe", ["--query-gpu=name", "--format=csv,noheader"]);
  }
  // Fallback: PowerShell WMI (works even if nvidia-smi not in PATH, catches NVIDIA in VideoController name)
  if (!gpu && process.platform === "win32") {
    try {
      const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"], { timeout: 3000, shell: true } as never);
      const out = String((r.stdout as unknown as string) ?? "");
      if (out.toLowerCase().includes("nvidia")) {
        gpu = true;
        const match = out.split("\n").find((l) => l.toLowerCase().includes("nvidia"));
        if (match) gpuName = match.trim();
        else gpuName = "NVIDIA GPU (via WMI)";
      }
    } catch {}
  }
  out.push({
    key: "gpu",
    label: gpuName ? `NVIDIA GPU — ${gpuName}` : "NVIDIA GPU",
    installed: gpu,
    path: gpuName ? gpuName : null,
    description: gpu ? `Detected — will use CUDA if ggml-cuda.dll present${gpuName ? ` (${gpuName})` : ""}` : "Not detected — will use CPU (nvidia-smi not found in PATH)",
    required: false,
  });

  return out;
}

export function isAllDepsReady(): boolean {
  return getDepsStatus().filter((d) => d.required).every((d) => d.installed);
}

export function missingDeps(): DepStatus[] {
  return getDepsStatus().filter((d) => d.required && !d.installed);
}
