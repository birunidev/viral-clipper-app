#!/usr/bin/env node
/**
 * Prepare all deps for the installer build — ensures every binary/model from
 * getDepsStatus() is present in the packaged app.
 * - Copies ffmpeg, ffprobe, yt-dlp, whisper binaries to resources/bin if missing
 * - Optionally pre-downloads whisper + LLM models to resources/models for fully offline installer
 *   (pass --with-models or set WITH_MODELS=1, otherwise models stay lazy-downloaded to userData)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(path.join(__dirname, ".."));
const resourcesBin = path.join(electronRoot, "resources", "bin");
const resourcesModels = path.join(electronRoot, "resources", "models");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) return false;
  ensureDir(path.dirname(dest));
  // Skip if dest exists and is same size
  try {
    if (fs.existsSync(dest) && fs.statSync(src).size === fs.statSync(dest).size) {
      console.log(`[prepare-build] skip ${path.basename(src)} — already at ${dest}`);
      return true;
    }
  } catch {}
  fs.copyFileSync(src, dest);
  try { fs.chmodSync(dest, 0o755); } catch {}
  console.log(`[prepare-build] copied ${src} -> ${dest}`);
  return true;
}

function findAndCopyBinaries() {
  console.log("[prepare-build] ensuring binaries in resources/bin...");
  ensureDir(resourcesBin);

  // ffmpeg-static: node_modules/ffmpeg-static/ffmpeg.exe (win) or ffmpeg
  const ffmpegSrc = path.join(electronRoot, "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const ffmpegAlt = path.join(electronRoot, "node_modules", "ffmpeg-static", "ffmpeg");
  if (fs.existsSync(ffmpegSrc)) copyIfExists(ffmpegSrc, path.join(resourcesBin, path.basename(ffmpegSrc)));
  else if (fs.existsSync(ffmpegAlt)) copyIfExists(ffmpegAlt, path.join(resourcesBin, path.basename(ffmpegAlt)));
  else console.warn("[prepare-build] ffmpeg not found in node_modules/ffmpeg-static, will rely on asarUnpack");

  // ffprobe-static: bin/win32/x64/ffprobe.exe etc.
  const ffprobeCandidates = [
    path.join(electronRoot, "node_modules", "ffprobe-static", "bin", "win32", "x64", "ffprobe.exe"),
    path.join(electronRoot, "node_modules", "ffprobe-static", "bin", "win32", "ffprobe.exe"),
    path.join(electronRoot, "node_modules", "ffprobe-static", "bin", "linux", "x64", "ffprobe"),
    path.join(electronRoot, "node_modules", "ffprobe-static", "bin", "darwin", "x64", "ffprobe"),
  ];
  let ffprobeFound = false;
  for (const src of ffprobeCandidates) {
    if (fs.existsSync(src)) {
      // Copy to resources/bin/ffprobe.exe (win) or bin/ffprobe (linux/mac) for resolveBin to find
      const destName = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
      if (copyIfExists(src, path.join(resourcesBin, destName))) ffprobeFound = true;
      // Also keep original structure for fallback
      if (src.includes("win32/x64")) {
        copyIfExists(src, path.join(resourcesBin, "win32", "x64", "ffprobe.exe"));
      }
      break;
    }
  }
  if (!ffprobeFound) console.warn("[prepare-build] ffprobe not found, will rely on asarUnpack + ffprobe-static require");

  // yt-dlp-exec: bin/yt-dlp.exe
  const ytdlpCandidates = [
    path.join(electronRoot, "node_modules", "yt-dlp-exec", "bin", "yt-dlp.exe"),
    path.join(electronRoot, "node_modules", "yt-dlp-exec", "bin", "yt-dlp"),
    path.join(electronRoot, "..", "node_modules", "yt-dlp-exec", "bin", "yt-dlp.exe"),
  ];
  let ytdlpFound = false;
  for (const src of ytdlpCandidates) {
    if (fs.existsSync(src)) {
      copyIfExists(src, path.join(resourcesBin, path.basename(src)));
      // Ensure both with and without .exe are available for cross-platform
      if (src.endsWith(".exe")) {
        const noExt = path.join(resourcesBin, "yt-dlp");
        if (!fs.existsSync(noExt)) copyIfExists(src, noExt);
      }
      ytdlpFound = true;
      break;
    }
  }
  if (!ytdlpFound) console.warn("[prepare-build] yt-dlp not found in node_modules/yt-dlp-exec, will rely on asarUnpack");

  // whisper is already in resources/bin/win-x64/whisper-cli.exe (prebuilt) — verify
  const whisperBin = path.join(resourcesBin, "win-x64", "whisper-cli.exe");
  if (fs.existsSync(whisperBin)) console.log(`[prepare-build] whisper-cli.exe exists ${whisperBin}`);
  else console.warn("[prepare-build] whisper-cli.exe missing from resources/bin/win-x64/ — run npm run setup:whisper");

  // Verify ffmpeg/ffprobe/yt-dlp are now in resources/bin
  for (const name of ["ffmpeg.exe", "ffprobe.exe", "yt-dlp.exe"]) {
    const p = path.join(resourcesBin, name);
    if (fs.existsSync(p)) console.log(`[prepare-build] OK ${name} at ${p} (${(fs.statSync(p).size/1024/1024).toFixed(1)} MB)`);
    else console.warn(`[prepare-build] MISSING ${name} at ${p} — will be unpacked from node_modules via asarUnpack`);
  }
}

async function maybeDownloadModels() {
  const withModels = process.argv.includes("--with-models") || process.env.WITH_MODELS === "1" || process.env.WITH_MODELS === "true";
  if (!withModels) {
    console.log("[prepare-build] skipping models bundling (pass --with-models to pre-download whisper+LLM to resources/models for offline installer)");
    console.log("[prepare-build] models will be lazy-downloaded to %APPDATA%/clipzard-desktop/models/ on first run");
    return;
  }
  console.log("[prepare-build] --with-models detected — pre-downloading whisper + LLM to resources/models...");
  const { spawn } = await import("node:child_process");
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, "download-models.mjs"), "--out", resourcesModels], { stdio: "inherit" });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`download-models failed code ${code}`))));
    p.on("error", reject);
  });
  // Verify
  const whisperModel = path.join(resourcesModels, "whisper", "ggml-large-v3.bin");
  const llmModel7b = path.join(resourcesModels, "llm", "qwen2.5-7b-q4_k_m.gguf");
  for (const p of [whisperModel, llmModel7b]) {
    if (fs.existsSync(p)) console.log(`[prepare-build] model ready ${p} (${(fs.statSync(p).size/1024/1024/1024).toFixed(2)} GB)`);
    else console.warn(`[prepare-build] model missing ${p}`);
  }
}

async function main() {
  console.log("[prepare-build] starting — ensuring every dep from getDepsStatus() is bundled");
  findAndCopyBinaries();
  await maybeDownloadModels();
  console.log("[prepare-build] done. All required binaries will be in dist + resources/bin (unpacked from asar).");
  console.log("[prepare-build] Final check — run with USER_DATA_PATH set to verify getDepsStatus():");
  console.log("  USER_DATA_PATH=%APPDATA%\\clipzard-desktop node -e \"import('./dist/services/deps.js').then(m=>console.log(m.getDepsStatus()))\"");
}

main().catch((e) => {
  console.error("[prepare-build] failed", e);
  process.exit(1);
});
