#!/usr/bin/env node
/**
 * Prepare all deps for the installer build — ensures every binary/model from
 * getDepsStatus() is present in the packaged app.
 * - Copies ffmpeg, ffprobe, yt-dlp, whisper binaries to resources/bin if missing
 * - Auto-provisions whisper binary (spawn setup-local-ai.mjs --build-whisper-only) if missing
 * - Auto-provisions models to unified userData (~/.config/clipzard-desktop or ~/.clipzard on win) by default
 *   (pass --skip-models or SKIP_MODELS=1 to skip heavy downloads; --skip-llm or SKIP_LLM=1 to skip ONLY the multi-GB LLM — whisper still downloaded — for lean installer; LLM is fetched on-demand in installed app via analyzer.ts; --with-models also populates resources/models for offline installer)
 * - Verifies and fails (exit 1) if any required dep is still missing — matches getDepsStatus() required check (SKIP_LLM filters llm-model from required check)
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(path.join(__dirname, ".."));
const resourcesBin = path.join(electronRoot, "resources", "bin");
const resourcesModels = path.join(electronRoot, "resources", "models");

function userDataRoot() {
  if (process.env.USER_DATA_PATH) return process.env.USER_DATA_PATH;
  if (process.platform === "win32") return path.join(os.homedir(), ".clipzard");
  return path.join(os.homedir(), ".config", "clipzard-desktop");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) return false;
  ensureDir(path.dirname(dest));
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

function platformDir() {
  if (process.platform === "win32") return "win";
  if (process.platform === "darwin") return "mac";
  return "linux";
}
function archSuffix() {
  const a = process.arch;
  if (a === "arm64") return "arm64";
  if (a === "x64") return "x64";
  return a;
}

function findAndCopyBinaries() {
  console.log("[prepare-build] ensuring binaries in resources/bin...");
  ensureDir(resourcesBin);
  ensureDir(resourcesModels);
  const plat = process.platform;

  // ffmpeg-static
  const ffmpegSrc = path.join(electronRoot, "node_modules", "ffmpeg-static", plat === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const ffmpegAlt = path.join(electronRoot, "node_modules", "ffmpeg-static", "ffmpeg");
  let ffmpegFound = false;
  if (fs.existsSync(ffmpegSrc)) {
    const destName = plat === "win32" ? "ffmpeg.exe" : "ffmpeg";
    if (copyIfExists(ffmpegSrc, path.join(resourcesBin, destName))) ffmpegFound = true;
    // also place in platform-arch subdir for resolveBin parity
    copyIfExists(ffmpegSrc, path.join(resourcesBin, `${platformDir()}-${archSuffix()}`, destName));
    if (plat === "win32") copyIfExists(ffmpegSrc, path.join(resourcesBin, "win-x64", "ffmpeg.exe"));
  } else if (fs.existsSync(ffmpegAlt) && plat !== "win32") {
    if (copyIfExists(ffmpegAlt, path.join(resourcesBin, "ffmpeg"))) ffmpegFound = true;
    copyIfExists(ffmpegAlt, path.join(resourcesBin, `${platformDir()}-${archSuffix()}`, "ffmpeg"));
  }
  if (!ffmpegFound) console.warn("[prepare-build] ffmpeg not found in node_modules/ffmpeg-static, will rely on asarUnpack (run npm ci)");

  // ffprobe-static
  const ffprobeCandidates = plat === "win32"
    ? [
        path.join(electronRoot, "node_modules", "ffprobe-static", "bin", "win32", "x64", "ffprobe.exe"),
        path.join(electronRoot, "node_modules", "ffprobe-static", "bin", "win32", "ffprobe.exe"),
      ]
    : plat === "darwin"
    ? [
        path.join(electronRoot, "node_modules", "ffprobe-static", "bin", "darwin", "x64", "ffprobe"),
        path.join(electronRoot, "node_modules", "ffprobe-static", "bin", "darwin", "arm64", "ffprobe"),
      ]
    : [
        path.join(electronRoot, "node_modules", "ffprobe-static", "bin", "linux", "x64", "ffprobe"),
        path.join(electronRoot, "node_modules", "ffprobe-static", "bin", "linux", "arm64", "ffprobe"),
      ];
  let ffprobeFound = false;
  for (const src of ffprobeCandidates) {
    if (fs.existsSync(src)) {
      const destName = plat === "win32" ? "ffprobe.exe" : "ffprobe";
      if (copyIfExists(src, path.join(resourcesBin, destName))) ffprobeFound = true;
      copyIfExists(src, path.join(resourcesBin, `${platformDir()}-${archSuffix()}`, destName));
      if (src.includes("win32/x64")) copyIfExists(src, path.join(resourcesBin, "win32", "x64", "ffprobe.exe"));
      break;
    }
  }
  if (!ffprobeFound) console.warn("[prepare-build] ffprobe not found, will rely on asarUnpack + ffprobe-static require (run npm ci)");

  // yt-dlp-exec
  const ytdlpCandidates = plat === "win32"
    ? [
        path.join(electronRoot, "node_modules", "yt-dlp-exec", "bin", "yt-dlp.exe"),
        path.join(electronRoot, "..", "node_modules", "yt-dlp-exec", "bin", "yt-dlp.exe"),
      ]
    : [
        path.join(electronRoot, "node_modules", "yt-dlp-exec", "bin", "yt-dlp"),
        path.join(electronRoot, "..", "node_modules", "yt-dlp-exec", "bin", "yt-dlp"),
      ];
  let ytdlpFound = false;
  for (const src of ytdlpCandidates) {
    if (fs.existsSync(src)) {
      const destName = plat === "win32" ? "yt-dlp.exe" : "yt-dlp";
      if (copyIfExists(src, path.join(resourcesBin, destName))) ytdlpFound = true;
      copyIfExists(src, path.join(resourcesBin, `${platformDir()}-${archSuffix()}`, destName));
      break;
    }
  }
  if (!ytdlpFound) console.warn("[prepare-build] yt-dlp not found in node_modules/yt-dlp-exec, will rely on asarUnpack (run npm ci)");
}

async function ensureWhisperBinary() {
  const plat = platformDir();
  const arch = archSuffix();
  const exe = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  const binDir = path.join(resourcesBin, `${plat}-${arch}`);
  const whisperBin = path.join(binDir, exe);
  // Also check legacy win-x64 path on win
  const altWinBin = path.join(resourcesBin, "win-x64", "whisper-cli.exe");
  const checkPaths = process.platform === "win32" ? [whisperBin, altWinBin] : [whisperBin];
  const exists = checkPaths.some((p) => fs.existsSync(p) && fs.statSync(p).size > 10000);
  if (exists) {
    const found = checkPaths.find((p) => fs.existsSync(p));
    console.log(`[prepare-build] whisper binary exists ${found} (${(fs.statSync(found).size/1024/1024).toFixed(1)} MB)`);
    return true;
  }
  console.warn(`[prepare-build] whisper binary missing at ${whisperBin} — auto-provisioning via setup-local-ai.mjs --build-whisper-only ...`);
  const { spawn } = await import("node:child_process");
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, "setup-local-ai.mjs"), "--build-whisper-only"], { stdio: "inherit" });
    p.on("close", resolve);
    p.on("error", () => resolve(1));
  });
  // Re-check
  const after = checkPaths.some((p) => fs.existsSync(p) && fs.statSync(p).size > 10000);
  if (after) {
    const found = checkPaths.find((p) => fs.existsSync(p));
    console.log(`[prepare-build] whisper binary ready ${found} (${(fs.statSync(found).size/1024/1024).toFixed(1)} MB)`);
    return true;
  }
  console.error(`[prepare-build] whisper binary still missing after auto-provision (setup-local-ai exit ${r}) — will fail verification`);
  return false;
}

async function ensureModels() {
  const skipModels = process.argv.includes("--skip-models") || process.env.SKIP_MODELS === "1" || process.env.SKIP_MODELS === "true";
  if (skipModels) {
    console.log("[prepare-build] SKIP_MODELS set — skipping model auto-provision (whisper + LLM)");
    return;
  }
  const skipLlm = process.argv.includes("--skip-llm") || process.env.SKIP_LLM === "1" || process.env.SKIP_LLM === "true";
  if (skipLlm) {
    console.log("[prepare-build] SKIP_LLM set — skipping LLM download (whisper will still be provisioned, LLM will be fetched on-demand in installed app)");
  }
  // Always ensure models to unified userData (auto-provision by default)
  console.log(`[prepare-build] ensuring models to ${userDataRoot()}/models (auto-provision) ${skipLlm ? "[whisper-only]" : ""} ...`);
  const { spawn } = await import("node:child_process");
  const dlArgs = skipLlm ? ["--skip-llm"] : [];
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, "download-models.mjs"), ...dlArgs], { stdio: "inherit" });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`download-models failed code ${code}`))));
    p.on("error", reject);
  }).catch((e) => {
    console.warn(`[prepare-build] model auto-provision failed: ${e.message} — will fail verification if required`);
    throw e;
  });

  // If --with-models also populate resources/models for offline installer (respect SKIP_LLM)
  const withModels = process.argv.includes("--with-models") || process.env.WITH_MODELS === "1" || process.env.WITH_MODELS === "true";
  if (withModels) {
    console.log(`[prepare-build] --with-models also populating resources/models for offline installer ${skipLlm ? "[whisper-only]" : ""} ...`);
    await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [path.join(__dirname, "download-models.mjs"), "--out", resourcesModels, ...dlArgs], { stdio: "inherit" });
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`download-models --out failed code ${code}`))));
      p.on("error", reject);
    });
  }
}

function verifyBinariesFailClosed() {
  const plat = process.platform;
  const exe = plat === "win32";
  const expected = exe ? ["ffmpeg.exe", "ffprobe.exe", "yt-dlp.exe"] : ["ffmpeg", "ffprobe", "yt-dlp"];
  const failures = [];
  for (const name of expected) {
    const top = path.join(resourcesBin, name);
    const sub = path.join(resourcesBin, `${platformDir()}-${archSuffix()}`, name);
    const ok = fs.existsSync(top) || fs.existsSync(sub);
    if (ok) {
      const p = fs.existsSync(top) ? top : sub;
      console.log(`[prepare-build] OK ${name} at ${p} (${(fs.statSync(p).size/1024/1024).toFixed(1)} MB)`);
    } else {
      console.error(`[prepare-build] MISSING ${name} at ${top} and ${sub}`);
      failures.push(name);
    }
  }
  // whisper
  const whisperExe = plat === "win32" ? "whisper-cli.exe" : "whisper-cli";
  const whisperPaths = [path.join(resourcesBin, `${platformDir()}-${archSuffix()}`, whisperExe), path.join(resourcesBin, "win-x64", "whisper-cli.exe"), path.join(resourcesBin, whisperExe)];
  const whisperOk = whisperPaths.some((p) => fs.existsSync(p) && fs.statSync(p).size > 10000);
  if (whisperOk) {
    const found = whisperPaths.find((p) => fs.existsSync(p));
    console.log(`[prepare-build] OK ${whisperExe} at ${found} (${(fs.statSync(found).size/1024/1024).toFixed(1)} MB)`);
  } else {
    console.error(`[prepare-build] MISSING ${whisperExe} at ${whisperPaths.join(", ")}`);
    failures.push(whisperExe);
  }
  if (failures.length) {
    console.error(`[prepare-build] FAIL — missing required binaries: ${failures.join(", ")} — build will fail`);
    // Also note npm ci hint for ffmpeg family
    if (failures.some((n) => n.includes("ffmpeg") || n.includes("ffprobe") || n.includes("yt-dlp"))) {
      console.error("[prepare-build] hint: run npm ci in electron/ to install ffmpeg-static/ffprobe-static/yt-dlp-exec");
    }
    process.exit(1);
  }
}

async function verifyDepsStatus() {
  // Try to import dist/services/deps.js if built, and check isAllDepsReady
  const distDeps = path.join(electronRoot, "dist", "services", "deps.js");
  if (!fs.existsSync(distDeps)) {
    console.log("[prepare-build] dist/services/deps.js not yet built — skipping getDepsStatus() check (run tsc first)");
    return;
  }
  try {
    const mod = await import(distDeps);
    const getDepsStatus = mod.getDepsStatus;
    const isAllDepsReady = mod.isAllDepsReady;
    const missingDeps = mod.missingDeps;
    if (typeof getDepsStatus === "function") {
      const deps = getDepsStatus();
      console.log("[prepare-build] getDepsStatus():");
      for (const d of deps) {
        const status = d.installed ? "OK" : d.required ? "MISSING*" : "optional-missing";
        console.log(`  - ${d.key} (${d.label}): ${status} — ${d.description} ${d.path ? `at ${d.path}` : ""}`);
      }
      const missing = typeof missingDeps === "function" ? missingDeps() : deps.filter((d) => d.required && !d.installed);
      const skipModels = process.argv.includes("--skip-models") || process.env.SKIP_MODELS === "1" || process.env.SKIP_MODELS === "true";
      const skipLlm = process.argv.includes("--skip-llm") || process.env.SKIP_LLM === "1" || process.env.SKIP_LLM === "true";
      let relevantMissing = missing;
      if (skipModels) relevantMissing = missing.filter((d) => !d.key.includes("model"));
      else if (skipLlm) relevantMissing = missing.filter((d) => d.key !== "llm-model");
      if (relevantMissing.length) {
        console.error(`[prepare-build] FAIL — getDepsStatus() still reports missing required deps: ${relevantMissing.map((d) => d.key).join(", ")}`);
        process.exit(1);
      }
      console.log("[prepare-build] getDepsStatus() all required deps OK");
    }
  } catch (e) {
    console.warn("[prepare-build] getDepsStatus() check failed (non-fatal):", String(e).slice(0,500));
  }
}

async function main() {
  console.log("[prepare-build] starting — ensuring every dep from getDepsStatus() is bundled (auto-provision default)");
  console.log(`[prepare-build] unified userData: ${userDataRoot()}  (override with USER_DATA_PATH)`);
  findAndCopyBinaries();
  const whisperOk = await ensureWhisperBinary();
  if (!whisperOk) {
    console.error("[prepare-build] whisper binary auto-provision failed — exiting 1");
    process.exit(1);
  }
  const skipModels = process.argv.includes("--skip-models") || process.env.SKIP_MODELS === "1" || process.env.SKIP_MODELS === "true";
  const skipLlm = process.argv.includes("--skip-llm") || process.env.SKIP_LLM === "1" || process.env.SKIP_LLM === "true";
  if (skipLlm && !skipModels) console.log("[prepare-build] SKIP_LLM active — LLM will be downloaded on-demand in installed app (analyzer.ts ensureLlmModel / Settings → Download)");
  if (!skipModels) {
    try {
      await ensureModels();
    } catch (e) {
      console.error("[prepare-build] model ensure failed:", e.message);
      process.exit(1);
    }
  } else {
    console.log("[prepare-build] SKIP_MODELS active — all models will be downloaded on-demand in installed app");
  }
  verifyBinariesFailClosed();
  await verifyDepsStatus();
  console.log("[prepare-build] done.");
  console.log("[prepare-build] Verify: node -e \"import('./dist/services/deps.js').then(m=>console.log(m.getDepsStatus()))\"  (unified userData: " + userDataRoot() + ")");
  if (process.platform === "win32") console.log("  PowerShell: $env:USER_DATA_PATH=\"$HOME\\.clipzard\"; node -e \"...\"");
}

main().catch((e) => {
  console.error("[prepare-build] failed", e);
  process.exit(1);
});
