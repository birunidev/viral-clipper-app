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
import { fileURLToPath } from "node:url";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const getArg = (k, d=null) => {
  const m = args.find(a=>a.startsWith(`--${k}=`));
  return m ? m.split("=")[1] : (args.includes(`--${k}`) ? true : d);
};
const hasFlag = (k) => args.includes(`--${k}`);

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const platformDir = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
const archSuffix = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
const binDir = path.join(root, "resources", "bin", `${platformDir}-${archSuffix}`);
const whisperBin = path.join(binDir, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
const tierFlag = getArg("tier", null);
const modelsOnly = hasFlag("models-only");
const whisperOnly = hasFlag("build-whisper-only");
const skipLlm = hasFlag("skip-llm") || process.env.SKIP_LLM === "1" || process.env.SKIP_LLM === "true";
const whisperOnlyFlag = hasFlag("whisper-only");

function log(m){ console.log(`[setup-ai] ${m}`); }
function warn(m){ console.warn(`[setup-ai] WARN ${m}`); }
function hasCmd(c){
  try {
    if (process.platform === "win32") return spawnSync("where", [c], { stdio: "ignore" }).status === 0 || spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0;
    return spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0 || spawnSync("which", [c], { stdio: "ignore" }).status === 0;
  } catch { return false; }
}

async function ensureWhisperBinary() {
  const runsOk = () => {
    if (!fs.existsSync(whisperBin) || fs.statSync(whisperBin).size <= 10000) return false;
    // Verify it actually loads (a copied binary missing libwhisper.so.1 fails
    // here but "exists" on disk — never trust size alone).
    const sm = spawnSync(whisperBin, ["--help"], { stdio: "pipe", env: { ...process.env, LD_LIBRARY_PATH: path.dirname(whisperBin) } });
    return sm.status === 0;
  };
  if (runsOk()) {
    log(`whisper-cli already ok at ${whisperBin} (${(fs.statSync(whisperBin).size/1024/1024).toFixed(1)} MB)`);
    return true;
  }
  if (fs.existsSync(whisperBin)) {
    warn(`existing whisper-cli at ${whisperBin} fails to load (size ${fs.statSync(whisperBin).size}) — rebuilding`);
    fs.rmSync(whisperBin, { force: true });
  }
  fs.mkdirSync(binDir, { recursive: true });
  // Try build from source if deps present. Recent whisper.cpp links whisper-cli
  // against libwhisper.so.1/libggml.so.0 by default; we must build a
  // SELF-CONTAINED binary (no shared-lib deps) or copy the .so files alongside
  // it and point rpath at them — otherwise whisper-cli fails at runtime with
  // "cannot open shared object file".
  const hasCmake = hasCmd("cmake");
  const hasMake = hasCmd("make") || hasCmd("gmake");
  const hasGpp = hasCmd("g++") || hasCmd("clang++");
  log(`deps: cmake=${hasCmake} make=${hasMake} g++=${hasGpp}`);
  if (hasMake && hasGpp) {
    const tmp = path.join(os.tmpdir(), "whisper.cpp");
    const cloneOrPull = () => {
      if (!fs.existsSync(path.join(tmp, "CMakeLists.txt"))) {
        if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
        const r = spawnSync("git", ["clone", "--depth", "1", "https://github.com/ggml-org/whisper.cpp.git", tmp], { stdio: "inherit" });
        return r.status === 0;
      }
      return spawnSync("git", ["-C", tmp, "pull", "--ff-only"], { stdio: "inherit" }).status === 0;
    };

    // Helper: copy the built binary + any shared libs it needs into binDir,
    // then re-point its RUNPATH at binDir so it self-loads locally.
    const installFrom = (built) => {
      if (!built || !fs.existsSync(built)) return false;
      fs.copyFileSync(built, whisperBin);
      try { fs.chmodSync(whisperBin, 0o755); } catch {}
      if (process.platform !== "win32") {
        try {
          const deps = execSync(`ldd "${built}"`, { encoding: "utf8" }).split("\n")
            .map(l => l.match(/=>\s+(\S+\.so(?:\.\d+)*)\s/)?.[1] ?? "")
            .filter(Boolean);
          const buildBin = path.dirname(built);
          let copied = false;
          for (const dep of deps) {
            const base = path.basename(dep);
            const src = path.join(buildBin, base);
            if (dep.includes(`/build/`) && fs.existsSync(src)) {
              fs.copyFileSync(src, path.join(binDir, base));
              try { fs.chmodSync(path.join(binDir, base), 0o755); } catch {}
              copied = true;
            }
          }
          if (copied) {
            try {
              execSync(`patchelf --set-rpath "${binDir}" "${whisperBin}" 2>/dev/null || true`);
            } catch {}
          }
        } catch {}
      }
      const sz = fs.statSync(whisperBin).size / 1024 / 1024;
      const envExtra = process.platform !== "win32" ? { LD_LIBRARY_PATH: binDir } : {};
      const sm = spawnSync(whisperBin, ["--help"], { stdio: "pipe", env: { ...process.env, ...envExtra } });
      log(`installed whisper-cli -> ${whisperBin} (${sz.toFixed(1)} MB) smoke: ${sm.status===0 ? "ok" : "exit "+sm.status} ${String(sm.stdout||sm.stderr).slice(0,200)}`);
      if (sm.status !== 0) return false;
      return true;
    };

    if (!cloneOrPull()) { warn("git clone/pull failed"); }
    log("building whisper-cli — this takes 1-3 min ...");
    let built = null;
    let buildDir = path.join(tmp, "build");
    if (hasCmake) {
      fs.mkdirSync(buildDir, { recursive: true });
      // Prefer a fully static build (GGML_SHARED=OFF + WHISPER_BUILD_STATIC=ON)
      // so the binary carries no .so deps. Fall back to copying the shared libs.
      let r = spawnSync("cmake", [
        "-B", buildDir,
        "-DCMAKE_BUILD_TYPE=Release",
        "-DGGML_SHARED=OFF",
        "-DWHISPER_BUILD_STATIC=ON",
        "-DWHISPER_BUILD_SHARED=OFF",
      ], { cwd: tmp, stdio: "inherit" });
      if (r.status === 0) {
        r = spawnSync("cmake", ["--build", buildDir, "-j", String(Math.max(2, os.cpus().length -1)), "--config", "Release"], { cwd: tmp, stdio: "inherit" });
        if (r.status !== 0) warn("cmake build failed, continuing search");
      } else {
        warn("cmake configure failed with static flags, retrying with defaults");
        r = spawnSync("cmake", ["-B", buildDir, "-DCMAKE_BUILD_TYPE=Release"], { cwd: tmp, stdio: "inherit" });
        if (r.status === 0) r = spawnSync("cmake", ["--build", buildDir, "-j", String(Math.max(2, os.cpus().length -1)), "--config", "Release"], { cwd: tmp, stdio: "inherit" });
      }
    } else {
      // No cmake: whisper.cpp ships a plain Makefile that builds statically.
      log("cmake not found, using whisper.cpp Makefile build (static)");
      const m = spawnSync("make", ["-j", String(Math.max(2, os.cpus().length -1))], { cwd: tmp, stdio: "inherit" });
      if (m.status !== 0) warn(`make build failed code=${m.status}, continuing search`);
    }

    // Candidates across cmake build/bin and make build dirs
    for (const cand of [
      path.join(buildDir, "bin", "whisper-cli"),
      path.join(buildDir, "bin", "whisper-cli.exe"),
      path.join(buildDir, "whisper-cli"),
      path.join(tmp, "build", "bin", "whisper-cli"),
      path.join(tmp, "build", "bin", "main"),
      path.join(tmp, "build", "main"),
    ]) if (fs.existsSync(cand)) { built = cand; break; }
    if (!built) {
      if (process.platform !== "win32") {
        try {
          const out = execSync(`find ${tmp}/build -type f \\( -name "whisper-cli*" -o -name "main" \\) | head -n 5`, { encoding: "utf8" });
          const first = out.trim().split("\n")[0];
          if (first && fs.existsSync(first)) built = first;
        } catch {}
      } else {
        // Windows: walk for whisper-cli.exe without Unix find
        const walk = (d) => {
          try {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
              const p = path.join(d, e.name);
              if (e.isFile() && e.name.toLowerCase().startsWith("whisper-cli")) return p;
              if (e.isDirectory()) { const r = walk(p); if (r) return r; }
            }
          } catch {}
          return null;
        };
        built = walk(path.join(tmp, "build")) ?? null;
      }
    }
    if (installFrom(built)) return true;
    warn("built binary failed smoke test (missing shared libs) — tried to copy libs beside it.");
    // On Windows, fall back to prebuilt download even if build was attempted
    if (process.platform === "win32") {
      log("build failed — trying prebuilt download for Windows ...");
      const downloaded = await downloadPrebuiltWhisperWindows();
      if (downloaded) return true;
    }
    return false;
  } else {
    // Windows fallback: download prebuilt whisper-cli.exe from GitHub releases
    if (process.platform === "win32") {
      log("cmake/make not found — trying prebuilt download for Windows ...");
      const downloaded = await downloadPrebuiltWhisperWindows();
      if (downloaded) return true;
      warn("prebuilt download failed");
    }
    warn("make/g++ missing — install: sudo apt install -y cmake build-essential git  (Windows: install Visual Studio Build Tools + cmake + git)");
    warn("Skipping whisper build. You can still run mocks, or install deps and re-run.");
    return false;
  }
}

async function downloadPrebuiltWhisperWindows() {
  // Official ggml-org/whisper.cpp CI binaries. whisper-bin-x64.zip contains
  // whisper-cli.exe + required DLLs — ALL files must be copied to binDir.
  const urls = [
    "https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip",
    "https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-blas-bin-x64.zip",
  ];
  for (const url of urls) {
    try {
      const tmpZip = path.join(os.tmpdir(), `whisper-win-${Date.now()}.zip`);
      log(`downloading prebuilt whisper from ${url} ...`);
      await downloadUrlToFile(url, tmpZip);
      if (fs.statSync(tmpZip).size < 100_000) { warn(`downloaded zip too small (${fs.statSync(tmpZip).size} B) — bad mirror`); continue; }
      const tmpDir = path.join(os.tmpdir(), `whisper-win-extract-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      // Use PowerShell Expand-Archive on Windows, unzip on other platforms
      const expand = process.platform === "win32"
        ? spawnSync("powershell", ["-Command", `Expand-Archive -Force -LiteralPath '${tmpZip}' -DestinationPath '${tmpDir}'`], { stdio: "inherit" })
        : spawnSync("unzip", ["-o", tmpZip, "-d", tmpDir], { stdio: "inherit" });
      if (expand.status !== 0) { warn(`extract failed for ${url}`); continue; }
      // Locate whisper-cli (or legacy main.exe) inside the extraction tree
      const findCli = (d) => {
        try {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isFile()) {
              const n = e.name.toLowerCase();
              if (n === "whisper-cli.exe" || n === "whisper-cli" || n === "main.exe") return p;
            } else if (e.isDirectory()) {
              const r = findCli(p); if (r) return r;
            }
          }
        } catch {}
        return null;
      };
      const exePath = findCli(tmpDir);
      if (!exePath) { warn(`no whisper-cli found inside ${url} zip`); continue; }
      const srcDir = path.dirname(exePath);
      // Copy EVERYTHING from the exe's folder (exe + ggml.dll + whisper.dll + ...)
      for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
        if (!e.isFile()) continue;
        fs.copyFileSync(path.join(srcDir, e.name), path.join(binDir, e.name));
      }
      try { fs.chmodSync(whisperBin, 0o755); } catch {}
      log(`installed prebuilt bundle -> ${binDir} (${fs.readdirSync(binDir).length} files)`);
      const sm = spawnSync(whisperBin, ["--help"], { stdio: "pipe" });
      if (sm.status === 0) { log(`smoke test ok — real transcription ready`); return true; }
      warn(`prebuilt binary smoke failed (exit ${sm.status}) ${String(sm.stderr || sm.stdout || "").slice(0, 200)} — trying next mirror`);
    } catch (e) { warn(`prebuilt download from ${url} failed: ${String(e).slice(0,200)}`); }
  }
  return false;
}

function downloadUrlToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? httpsGet : httpGet;
    const file = fs.createWriteStream(dest);
    const req = proto(url, { headers: { "User-Agent": "clipzard-setup" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.unlink(dest, () => {});
        downloadUrlToFile(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`download ${res.statusCode}`)); return; }
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
      file.on("error", reject);
    });
    req.on("error", reject);
  });
}

async function downloadModels() {
  if (skipLlm) {
    log(`SKIP_LLM set — downloading whisper only (LLM will be fetched on-demand in installed app)`);
  }
  const tierArg = tierFlag ? ` --tier=${tierFlag}` : "";
  const skipLlmArg = skipLlm ? " --skip-llm" : "";
  log(`downloading models for tier=${tierFlag ?? "auto"}${skipLlm ? " [whisper-only]" : ""} ...`);
  const cmd = `node ${path.join(root, "scripts/download-models.mjs")}${tierArg}${skipLlmArg}`;
  log(`> ${cmd}`);
  const extra = [];
  if (tierFlag) extra.push(`--tier=${tierFlag}`);
  if (skipLlm) extra.push("--skip-llm");
  const r = spawnSync("node", [path.join(root, "scripts/download-models.mjs"), ...extra], { stdio: "inherit" });
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
  console.log(`[setup-ai] root=${root} plat=${platformDir}-${archSuffix} tier=${tierFlag ?? "auto (ram="+(os.totalmem()/1024**3).toFixed(1)+"GB)"} skipLlm=${skipLlm}`);
  if (skipLlm) console.log(`[setup-ai] SKIP_LLM=1 — LLM download will be skipped (on-demand in installed app)`);
  if (!whisperOnly) {
    // 1. ensure ffmpeg/yt-dlp present
    const ffCandidates = [
      path.join(root, "node_modules/ffmpeg-static/ffmpeg"),
      path.join(root, "node_modules/ffmpeg-static/ffmpeg.exe"),
    ];
    const ff = ffCandidates.find((p) => fs.existsSync(p));
    if (!ff) {
      try {
        const req = createRequire(import.meta.url);
        const p = req("ffmpeg-static");
        if (p && fs.existsSync(p)) log(`ffmpeg ${p} present`);
        else warn("ffmpeg-static missing — run: npm install (in electron/)");
      } catch { warn("ffmpeg-static missing — run: npm install (in electron/)"); }
    } else log(`ffmpeg ${ff} present`);
    // ensure dist built for verify-pipeline
    const distMain = path.join(root, "dist/main.js");
    if (!fs.existsSync(distMain)) {
      log(`dist/main.js missing — running npx tsc ...`);
      spawnSync("npx", ["tsc"], { cwd: root, stdio: "inherit" });
    }
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
  console.log(`[setup-ai] models under: ${process.env.USER_DATA_PATH ?? path.join(os.homedir(), ".config", "clipzard-desktop", "models")}`);
  console.log(`[setup-ai] To use real local AI, ensure:`);
  console.log(`  - whisper-cli at ${whisperBin}`);
  console.log(`  - models at <userData>/models/whisper/ggml-*.bin and <userData>/models/llm/*.gguf`);
  console.log(`  - no LLM_API_KEY set (else cloud is used) — check .env`);
  console.log(`[setup-ai] Test real transcribe: USER_DATA_PATH=/tmp/x node -e "import('electron/dist/services/transcriber.js').then(m=>m.transcribeWithWords('/tmp/x/src.mp4'))"`);
})();
