import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { whisperModelForTier, llmModelForTier, ramTier } from "./system.js";
import { whisperStatus } from "./models.js";
import { ffmpegPath, ffprobePath, whisperPath, ytdlpPath } from "./bin.js";
import { userDataRoot } from "./userData.js";

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

  // LLM model (7b default) — check selected variant first, fallback to any installed variant so "downloaded 7B but selected still balanced" doesn't block
  try {
    const baseDir = userDataRoot();
    const llmPath = path.join(baseDir, "models", "llm", llm.file);
    let bytes = 0;
    try { if (fs.existsSync(llmPath)) bytes = fs.statSync(llmPath).size; } catch {}
    const expectedMb = llm.file.includes("7b") ? 4700 : llm.file.includes("1.5b") ? 950 : llm.file.includes("3b") ? 2000 : 380;
    if (bytes > 1024 * 1024) {
      out.push({
        key: "llm-model",
        label: `LLM ${llm.file}`,
        installed: true,
        path: llmPath,
        bytesOnDisk: bytes,
        sizeMb: expectedMb,
        description: "Ready",
        required: true,
      });
    } else {
      // Fallback: check other variants — if any LLM is installed, don't block (user can switch via "Use")
      let altBytes = 0;
      let altPath: string | null = null;
      let altFile: string | null = null;
      for (const alt of ["qwen2.5-7b-q4_k_m.gguf", "qwen2.5-1.5b-q4_k_m.gguf", "qwen2.5-0.5b-q4_k_m.gguf", "qwen2.5-3b-q4_k_m.gguf"]) {
        if (alt === llm.file) continue;
        const p = path.join(baseDir, "models", "llm", alt);
        try {
          if (fs.existsSync(p) && fs.statSync(p).size > 1024 * 1024) {
            altBytes = fs.statSync(p).size;
            altPath = p;
            altFile = alt;
            break;
          }
        } catch {}
      }
      if (altBytes > 0 && altPath && altFile) {
        const altMb = altFile.includes("7b") ? 4700 : altFile.includes("1.5b") ? 950 : altFile.includes("3b") ? 2000 : 380;
        out.push({
          key: "llm-model",
          label: `LLM ${altFile} (installed)`,
          installed: true,
          path: altPath,
          bytesOnDisk: altBytes,
          sizeMb: altMb,
          description: `Ready — using ${altFile} (selected ${llm.file} not found, click "Use" on installed variant to make it default)`,
          required: true,
        });
      } else {
        out.push({
          key: "llm-model",
          label: `LLM ${llm.file}`,
          installed: false,
          path: llmPath,
          bytesOnDisk: bytes,
          sizeMb: expectedMb,
          description: `Will download ${expectedMb} MB`,
          required: true,
        });
      }
    }
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

// Binaries are hard-required at project creation; models (whisper/llm) are
// lazily downloaded on-demand in the installed app (transcriber ensureModel
// + analyzer ensureLlmModel + Settings → Download). When built with SKIP_LLM,
// the lean installer ships without LLM and fetches it on first analyze.
const MODEL_KEYS = new Set(["whisper-model", "llm-model"]);
export function isBinariesReady(): boolean {
  return getDepsStatus().filter((d) => d.required && !MODEL_KEYS.has(d.key)).every((d) => d.installed);
}
export function missingBinaries(): DepStatus[] {
  return getDepsStatus().filter((d) => d.required && !MODEL_KEYS.has(d.key) && !d.installed);
}
export function missingModels(): DepStatus[] {
  return getDepsStatus().filter((d) => d.required && MODEL_KEYS.has(d.key) && !d.installed);
}
