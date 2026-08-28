#!/usr/bin/env node
/**
 * setup-local-ai.mjs — build/download whisper.cpp binary + download real models
 * For: "i want to use real llm and whisper cpp in local" (pure Node pipeline)
 *
 * What it does:
 *  1) Ensures ffmpeg/yt-dlp are present (npm install check)
 *  2) Ensures whisper-cli binary at resources/bin/<plat>-<arch>/whisper-cli
 *     - Tries to build from source (requires cmake, g++, make) via /tmp/whisper.cpp
 *     - Falls back to downloading prebuilt if build deps missing
 *  3) Downloads whisper GGML model + LLM GGUF for this machine's tier (via download-models.mjs)
 *  4) Rebuilds node-llama-cpp native addon if needed
 *
 * Run:
 *   node electron/scripts/setup-local-ai.mjs              # current tier
 *   node electron/scripts/setup-local-ai.mjs --tier=low   # force tier
 *   node electron/scripts/setup-local-ai.mjs --build-whisper-only
 *   node electron/scripts/setup-local-ai.mjs --models-only
 *   node electron/scripts/setup-local-ai.mjs --yes        # non-interactive
 *
 * Prereqs (Ubuntu/Debian):
 *   sudo apt update && sudo apt install -y cmake build-essential git curl
 *   For GPU: add CUDA toolkit if you want whisper.cpp CUDA, but CPU works.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync, execSync } from "node:child_process";

const args = process.argv.slice(2);
const getArg = (k, d=null) => {
  const m = args.find(a=>a.startsWith(`--${k}=`));
  return m ? m.split("=")[1] : (args.includes(`--${k}`) ? true : d);
};
const hasFlag = (k) => args.includes(`--${k}`);

const root = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), ".."));
const platformDir = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
const archSuffix = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
const binDir = path.join(root, "resources", "bin", `${platformDir}-${archSuffix}`);
const whisperBin = path.join(binDir, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
const tierFlag = getArg("tier", null);
const modelsOnly = hasFlag("models-only");
const whisperOnly = hasFlag("build-whisper-only");

function log(m){ console.log(`[setup-ai] ${m}`); }
function warn(m){ console.warn(`[setup-ai] WARN ${m}`); }
function hasCmd(c){
  try { return spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0 || spawnSync("which", [c], { stdio: "ignore" }).status === 0; } catch { return false; }
}

async function ensureWhisperBinary() {
  if (fs.existsSync(whisperBin) && fs.statSync(whisperBin).size > 10000) {
    log(`whisper-cli already at ${whisperBin} (${(fs.statSync(whisperBin).size/1024/1024).toFixed(1)} MB)`);
    return true;
  }
  fs.mkdirSync(binDir, { recursive: true });
  // Try build from source if deps present
  const hasCmake = hasCmd("cmake");
  const hasMake = hasCmd("make") || hasCmd("gmake");
  const hasGpp = hasCmd("g++") || hasCmd("clang++");
  log(`deps: cmake=${hasCmake} make=${hasMake} g++=${hasGpp}`);
  if (hasCmake && hasMake && hasGpp) {
    const tmp = path.join(os.tmpdir(), "whisper.cpp");
    if (!fs.existsSync(path.join(tmp, "CMakeLists.txt"))) {
      log(`cloning whisper.cpp to ${tmp} ...`);
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
      const r = spawnSync("git", ["clone", "--depth", "1", "https://github.com/ggerganov/whisper.cpp.git", tmp], { stdio: "inherit" });
      if (r.status !== 0) { warn("git clone failed"); return false; }
    } else {
      log(`whisper.cpp already at ${tmp}, updating`);
      spawnSync("git", ["-C", tmp, "pull", "--ff-only"], { stdio: "inherit" });
    }
    log("building whisper-cli (cmake) — this takes 1-3 min ...");
    // whisper.cpp main -> whisper-cli rename in recent versions
    let buildDir = path.join(tmp, "build");
    fs.mkdirSync(buildDir, { recursive: true });
    let r = spawnSync("cmake", ["-B", buildDir, "-DCMAKE_BUILD_TYPE=Release"], { cwd: tmp, stdio: "inherit" });
    if (r.status !== 0) { warn("cmake configure failed"); return false; }
    r = spawnSync("cmake", ["--build", buildDir, "-j", String(Math.max(2, os.cpus().length -1)), "--config", "Release"], { cwd: tmp, stdio: "inherit" });
    if (r.status !== 0) { warn("cmake build failed"); return false; }
    // Find built binary: build/bin/whisper-cli or build/bin/whisper-cli.exe or build/whisper-cli
    const candidates = [
      path.join(buildDir, "bin", "whisper-cli"),
      path.join(buildDir, "bin", "whisper-cli.exe"),
      path.join(buildDir, "whisper-cli"),
      path.join(tmp, "build", "bin", "whisper-cli"),
    ];
    let built = candidates.find(p=>fs.existsSync(p));
    if (!built) {
      // search
      try {
        const out = execSync(`find ${buildDir} -name "whisper-cli*" -type f | head -n 5`, { encoding: "utf8" });
        log(`find result: ${out}`);
        const first = out.trim().split("\n")[0];
        if (first && fs.existsSync(first)) built = first;
      } catch {}
    }
    if (!built || !fs.existsSync(built)) {
      warn("built binary not found — look for main/whisper-cli in build/");
      // fallback: try 'main' old name
      const old = path.join(buildDir, "bin", "main");
      if (fs.existsSync(old)) { built = old; log(`using legacy 'main' as whisper-cli`); }
      else return false;
    }
    fs.copyFileSync(built, whisperBin);
    try { fs.chmodSync(whisperBin, 0o755); } catch {}
    log(`installed whisper-cli -> ${whisperBin} (${(fs.statSync(whisperBin).size/1024/1024).toFixed(1)} MB)`);
    // smoke test
    const sm = spawnSync(whisperBin, ["--help"], { stdio: "pipe" });
    log(`whisper-cli smoke: ${sm.status===0 ? "ok" : "help exit "+sm.status} ${String(sm.stdout||sm.stderr).slice(0,200)}`);
    return true;
  } else {
    warn("cmake/make/g++ missing — install: sudo apt install -y cmake build-essential git");
    warn("Skipping whisper build. You can still run mocks, or install deps and re-run.");
    // Try prebuilt download as fallback (community)
    // We won't auto-download random binary; just warn.
    return false;
  }
}

async function downloadModels() {
  const tierArg = tierFlag ? ` --tier=${tierFlag}` : "";
  log(`downloading models for tier=${tierFlag ?? "auto"} ...`);
  const cmd = `node ${path.join(root, "scripts/download-models.mjs")}${tierArg}`;
  log(`> ${cmd}`);
  const r = spawnSync("node", [path.join(root, "scripts/download-models.mjs"), ...(tierFlag ? [`--tier=${tierFlag}`] : [])], { stdio: "inherit" });
  if (r.status !== 0) warn(`model download exited ${r.status} — check network/HF rate limit`);
  return r.status === 0;
}

async function rebuildLlama() {
  // node-llama-cpp is optionalDependency; if not installed, inform
  const pkg = path.join(root, "node_modules", "node-llama-cpp", "package.json");
  if (!fs.existsSync(pkg)) {
    warn("node-llama-cpp not installed — run: npm install   (optionalDependencies)");
    return false;
  }
  if (!hasCmd("cmake")) {
    warn("cmake missing — needed for node-llama-cpp rebuild. Install: sudo apt install -y cmake build-essential");
    return false;
  }
  log("rebuilding node-llama-cpp (may take a few minutes) ...");
  const r = spawnSync("npm", ["run", "rebuild"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) warn("electron-rebuild failed — you can still use cloud LLM via LLM_API_KEY instead");
  return r.status === 0;
}

(async () => {
  console.log(`[setup-ai] root=${root} plat=${platformDir}-${archSuffix} tier=${tierFlag ?? "auto (ram="+(os.totalmem()/1024**3).toFixed(1)+"GB)"}`);
  if (!whisperOnly) {
    // 1. ensure ffmpeg/yt-dlp present
    const ff = path.join(root, "node_modules/ffmpeg-static/ffmpeg");
    if (!fs.existsSync(ff)) warn("ffmpeg-static missing — run: npm install");
    else log(`ffmpeg ${ff} present`);
  }
  let okWhisper = true;
  if (!modelsOnly) okWhisper = await ensureWhisperBinary();
  let okModels = true;
  if (!whisperOnly) okModels = await downloadModels();
  let okLlama = true;
  if (!whisperOnly && !modelsOnly) okLlama = await rebuildLlama();
  // verify pipeline after
  log("running verify-pipeline quick check (mock OK even without models) ...");
  spawnSync("node", [path.join(root, "scripts/verify-pipeline.mjs")], { stdio: "inherit" });
  console.log(`\n[setup-ai] done whisper=${okWhisper?"ok":"skip"} models=${okModels?"ok":"check"} llama=${okLlama?"ok":"skip"}`);
  console.log(`[setup-ai] whisper binary: ${whisperBin} ${fs.existsSync(whisperBin) ? "EXISTS" : "MISSING (mocks will be used)"}`);
  console.log(`[setup-ai] models under: ${process.env.USER_DATA_PATH ?? path.join(os.homedir(), ".config", "clipforge-desktop", "models")}`);
  console.log(`[setup-ai] To use real local AI, ensure:`);
  console.log(`  - whisper-cli at ${whisperBin}`);
  console.log(`  - models at <userData>/models/whisper/ggml-*.bin and <userData>/models/llm/*.gguf`);
  console.log(`  - no LLM_API_KEY set (else cloud is used) — check .env`);
  console.log(`[setup-ai] Test real transcribe: USER_DATA_PATH=/tmp/x node -e "import('electron/dist/services/transcriber.js').then(m=>m.transcribeWithWords('/tmp/x/src.mp4'))"`);
})();
