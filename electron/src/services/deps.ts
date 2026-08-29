import fs from "node:fs";
import path from "node:path";
import { whisperModelForTier, llmModelForTier, ramTier } from "./system.js";
import { whisperStatus } from "./models.js";
import { ffmpegPath, ffprobePath, whisperPath, ytdlpPath } from "./bin.js";

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

  // LLM model (7b default)
  try {
    const llmPath = path.join(
      (() => {
        try {
          const { app } = require("electron") as { app: { getPath: (n: string) => string } };
          return app.getPath("userData");
        } catch { return process.cwd(); }
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

  // GPU check (optional, not required but nice)
  let gpu = false;
  try {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const r = spawnSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { timeout: 2000 });
    gpu = r.status === 0 && String(r.stdout ?? "").trim().length > 0;
  } catch {}
  out.push({
    key: "gpu",
    label: "NVIDIA GPU",
    installed: gpu,
    path: null,
    description: gpu ? "Detected — will use CUDA if ggml-cuda.dll present" : "Not detected — will use CPU",
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
