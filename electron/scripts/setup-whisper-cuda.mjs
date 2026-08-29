#!/usr/bin/env node
// Download CUDA/GPU whisper.cpp binary for Windows (RTX 5060 auto-GPU)
// Run: node scripts/setup-whisper-cuda.mjs  (from electron/)
// Auto-detects GPU, downloads ggml-cuda build, extracts to resources/bin/win-x64/
// If GPU not needed, exits with CPU fallback message.

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { execSync, spawnSync } from "node:child_process";

const OUT_DIR = path.join(process.cwd(), "resources", "bin", "win-x64");
const CUDA_DLL = path.join(OUT_DIR, "ggml-cuda.dll");
const CUDA_URL = process.env.WHISPER_CUDA_URL || "https://github.com/ggml-org/whisper.cpp/releases/download/b4938/whisper-cublas-11.8.0-bin-x64.zip";
const TMP_ZIP = path.join(process.env.TEMP || process.env.TMP || "/tmp", "whisper-cuda.zip");
const TMP_DIR = path.join(process.env.TEMP || process.env.TMP || "/tmp", "whisper-cuda-extract");

function hasCudaDll() {
  return fs.existsSync(CUDA_DLL) || fs.existsSync(path.join(OUT_DIR, "ggml-cuda.so")) || fs.existsSync(path.join(OUT_DIR, "whisper-cuda.dll"));
}

if (hasCudaDll()) {
  console.log("[whisper-cuda] ggml-cuda.dll already present — GPU enabled");
  process.exit(0);
}

console.log("[whisper-cuda] CPU-only bundle detected (no ggml-cuda.dll).");
console.log(`[whisper-cuda] Downloading CUDA build from ${CUDA_URL} ...`);
console.log(`[whisper-cuda] -> ${TMP_ZIP} (${(269).toFixed(0)} MB, may take 2-5 min)`);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { "User-Agent": "clipzard" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(dest, () => {});
        download(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const total = parseInt(res.headers["content-length"] || "0", 10);
      let done = 0;
      let lastPct = -1;
      res.on("data", (c) => {
        done += c.length;
        if (total) {
          const pct = Math.floor((done / total) * 100);
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct;
            process.stdout.write(`\r[whisper-cuda] ${pct}% (${(done / 1024 / 1024).toFixed(1)}/${(total / 1024 / 1024).toFixed(1)} MB)`);
          }
        } else if (done % (20 * 1024 * 1024) < 65536) {
          process.stdout.write(`\r[whisper-cuda] ${(done / 1024 / 1024).toFixed(1)} MB`);
        }
      });
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        if (total) process.stdout.write("\n");
        resolve(dest);
      });
      file.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(120000, () => reject(new Error("download timeout")));
  });
}

try {
  fs.mkdirSync(path.dirname(TMP_ZIP), { recursive: true });
  await download(CUDA_URL, TMP_ZIP);
  console.log(`[whisper-cuda] downloaded ${ (fs.statSync(TMP_ZIP).size / 1024 / 1024).toFixed(1)} MB`);

  // Extract via PowerShell Expand-Archive (Windows) or unzip
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  if (process.platform === "win32") {
    console.log("[whisper-cuda] extracting via PowerShell Expand-Archive ...");
    execSync(`powershell -Command "Expand-Archive -Path '${TMP_ZIP.replace(/'/g, "''")}' -DestinationPath '${TMP_DIR.replace(/'/g, "''")}' -Force"`, { stdio: "inherit" });
  } else {
    execSync(`unzip -o "${TMP_ZIP}" -d "${TMP_DIR}"`, { stdio: "inherit" });
  }

  // Find extracted whisper files (may be in subfolder)
  const findFiles = (dir, names) => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (names.some((n) => e.name.toLowerCase() === n.toLowerCase() || e.name.toLowerCase().includes(n.toLowerCase()))) out.push(p);
      }
    };
    walk(dir);
    return out;
  };

  const needed = ["whisper-cli.exe", "whisper.dll", "ggml-cuda.dll", "ggml-base.dll", "cublas", "cudart"];
  const found = findFiles(TMP_DIR, needed);
  console.log(`[whisper-cuda] found ${found.length} relevant files:`);
  found.forEach((f) => console.log("  -", path.relative(TMP_DIR, f), `(${(fs.statSync(f).size / 1024).toFixed(0)} KB)`));

  // Copy to OUT_DIR
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let copied = 0;
  for (const src of found) {
    const base = path.basename(src);
    const dest = path.join(OUT_DIR, base);
    // Don't overwrite if same size and newer? Just copy
    fs.copyFileSync(src, dest);
    copied++;
    console.log(`[whisper-cuda] copied ${base} -> ${OUT_DIR}`);
  }

  // Also ensure whisper-cli.exe is there (if nested)
  const cliSrc = found.find((f) => path.basename(f).toLowerCase() === "whisper-cli.exe");
  if (cliSrc && !fs.existsSync(path.join(OUT_DIR, "whisper-cli.exe"))) {
    fs.copyFileSync(cliSrc, path.join(OUT_DIR, "whisper-cli.exe"));
  }

  console.log(`[whisper-cuda] done — copied ${copied} files to ${OUT_DIR}`);
  console.log("[whisper-cuda] Verify: Get-ChildItem resources/bin/win-x64/*.dll | Select Name");
  console.log("[whisper-cuda] Next: restart Electron, transcribing will log [transcriber] GPU detected — using CUDA/Vulkan");

  // Cleanup
  try { fs.unlinkSync(TMP_ZIP); } catch {}
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}

  if (!fs.existsSync(CUDA_DLL) && !found.some((f) => f.toLowerCase().includes("cuda"))) {
    console.warn("[whisper-cuda] WARNING: ggml-cuda.dll not found in archive — may be Vulkan build, GPU may still work via ggml-vulkan.dll");
  }
} catch (e) {
  console.error("[whisper-cuda] failed:", e.message);
  console.error("[whisper-cuda] Manual fallback:");
  console.error("  1) https://github.com/ggml-org/whisper.cpp/releases -> whisper-cublas-11.8.0-bin-x64.zip");
  console.error("  2) Unzip and copy whisper-cli.exe + ggml-cuda.dll + cublas*.dll to resources/bin/win-x64/");
  process.exit(1);
}
