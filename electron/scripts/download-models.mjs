#!/usr/bin/env node
/**
 * ClipZard — pre-download models for installer / first-run.
 * - Downloads whisper.cpp model + Qwen GGUF into Electron userData dir
 *   (structure matches transcriber.ts / analyzer.ts: userData/models/whisper|llm)
 * - Also optionally populates resources/bin placeholders.
 *
 * Usage:
 *   node scripts/download-models.mjs              # auto tier
 *   node scripts/download-models.mjs --tier=low|mid|high --out=/tmp/userData
 *   node scripts/download-models.mjs --all        # all tiers
 *   WHISPER_MODEL=small node scripts/download-models.mjs
 *   LLM_MODEL_FILE=qwen2.5-7b-q4_k_m.gguf LLM_MODEL_URL=https://... node scripts/download-models.mjs
 *
 * In CI / installer build you can run this with --out pointing at a staging
 * dir that later becomes extraResources. For end-user installer, the app itself
 * downloads lazily on first analyze/transcribe (analyzer.ts:147 + transcriber.ts:39)
 * — this script is just for pre-seeding to avoid first-run wait.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import http from "node:http";

const args = process.argv.slice(2);
const getArg = (k, d = null) => {
  const m = args.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split("=")[1] : (args.includes(`--${k}`) ? true : d);
};

function ramTier() {
  const gb = os.totalmem() / 1024 ** 3;
  if (gb >= 20) return "high";
  if (gb >= 12) return "mid";
  return "low";
}
function whisperFor(t) { if (t === "high") return "large-v3"; if (t === "mid") return "medium"; return "small"; }
// Expected sizes (MB) — skip only if file is >= 85% of expected, else re-download
const EXPECTED_MB = {
  "ggml-tiny.bin": 76, "ggml-base.bin": 148, "ggml-small.bin": 488, "ggml-medium.bin": 1534,
  "qwen2.5-0.5b-q4_k_m.gguf": 380, "qwen2.5-1.5b-q4_k_m.gguf": 950,
  "qwen2.5-3b-q4_k_m.gguf": 2000, "qwen2.5-7b-q4_k_m.gguf": 4700, "qwen2.5-14b-q4_k_m.gguf": 8500,
};
function llmFor(t) {
  // keep in sync with src/services/system.ts — bartowski single-file builds avoid 404 sharded Qwen files
  const tiny = (process.env.LLM_TIER ?? "").toLowerCase();
  if (tiny === "tiny" || tiny === "nano" || tiny === "0.5b") return { file: "qwen2.5-0.5b-q4_k_m.gguf", url: "https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf" };
  if (tiny === "7b" || tiny === "mid") return { file: "qwen2.5-7b-q4_k_m.gguf", url: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf" };
  if (tiny === "14b" || tiny === "high") return { file: "qwen2.5-14b-q4_k_m.gguf", url: "https://huggingface.co/bartowski/Qwen2.5-14B-Instruct-GGUF/resolve/main/Qwen2.5-14B-Instruct-Q4_K_M.gguf" };
  if (tiny === "quality" || tiny === "3b") return { file: "qwen2.5-3b-q4_k_m.gguf", url: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf" };
  // Default now 7B (4.7GB) — user requested 7b as default local while Qwen3-4B trains; keep 1.5B via LLM_TIER=balanced
  if (tiny === "balanced" || tiny === "1.5b") return { file: "qwen2.5-1.5b-q4_k_m.gguf", url: "https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf" };
  return { file: "qwen2.5-7b-q4_k_m.gguf", url: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf" };
}

function resolveOutDir() {
  const explicit = getArg("out", null);
  if (explicit) return path.resolve(explicit);
  // Unified userData — matches src/services/userData.ts
  if (process.env.USER_DATA_PATH) return process.env.USER_DATA_PATH;
  if (process.platform === "win32") return path.join(os.homedir(), ".clipzard");
  return path.join(os.homedir(), ".config", "clipzard-desktop");
}

function downloadFile(url, dest, label) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) {
      const sz = fs.statSync(dest).size;
      const expMb = EXPECTED_MB[path.basename(dest)];
      // Skip only if complete (>= 85% of expected); truncated partial downloads
      // (e.g. 737 MB "14B") must be deleted and re-downloaded, not skipped.
      if (sz > 1024 * 1024 && (!expMb || sz >= expMb * 1024 * 1024 * 0.85)) {
        console.log(`[models] skip ${label} — exists ${dest} (${(sz/1024/1024).toFixed(1)} MB)`);
        return resolve(dest);
      }
      if (expMb && sz < expMb * 1024 * 1024 * 0.85) {
        console.log(`[models] ${label} truncated (${(sz/1024/1024).toFixed(1)} MB < 85% of ${expMb} MB) — re-downloading`);
        try { fs.unlinkSync(dest); } catch {}
      }
    }
    const proto = url.startsWith("https") ? https : http;
    console.log(`[models] downloading ${label} -> ${dest}\n  from ${url}`);
    const file = fs.createWriteStream(dest);
    let total = 0, done = 0, lastPct = -1;
    const req = proto.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); try{ fs.unlinkSync(dest);}catch{}
        downloadFile(res.headers.location, dest, label).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close(); try{ fs.unlinkSync(dest);}catch{}
        return reject(new Error(`${label} HTTP ${res.statusCode}`));
      }
      total = parseInt(res.headers["content-length"] || "0", 10);
      res.on("data", (c) => {
        done += c.length;
        if (total) {
          const pct = Math.floor(done/total*100);
          if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; process.stdout.write(`\r[models] ${label} ${pct}% (${(done/1024/1024).toFixed(1)}/${(total/1024/1024).toFixed(1)} MB)`); }
        } else if (done % (50*1024*1024) < 65536) process.stdout.write(`\r[models] ${label} ${(done/1024/1024).toFixed(1)} MB`);
      });
      res.pipe(file);
      file.on("finish", () => { file.close(); if (total) process.stdout.write("\n"); console.log(`[models] done ${label} ${(fs.statSync(dest).size/1024/1024).toFixed(1)} MB`); resolve(dest); });
    });
    req.on("error", (e) => { try{ file.close(); fs.unlinkSync(dest);}catch{}; reject(e); });
    file.on("error", reject);
  });
}

async function main() {
  const tierFlag = getArg("tier", null);
  const all = !!getArg("all", false);
  const outBase = resolveOutDir();
  const whisperModelOverride = process.env.WHISPER_MODEL || null;
  const llmFileOverride = process.env.LLM_MODEL_FILE || null;
  const llmUrlOverride = process.env.LLM_MODEL_URL || null;

  const tiers = all ? ["low","mid","high"] : [tierFlag || whisperModelOverride ? (tierFlag || ramTier()) : ramTier()];
  // allow explicit --tier even with --all (then ignore all)
  const targetTiers = tierFlag && !all ? [tierFlag] : tiers;

  console.log(`[models] outBase=${outBase} tiers=${targetTiers.join(",")} platform=${process.platform} arch=${process.arch} ram=${(os.totalmem()/1024**3).toFixed(1)}GB`);

  let ok = 0, fail = 0;
  for (const tier of targetTiers) {
    const wName = whisperModelOverride || whisperFor(tier);
    const wUrl = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${wName}.bin`;
    const wDest = path.join(outBase, "models", "whisper", `ggml-${wName}.bin`);
    try { await downloadFile(wUrl, wDest, `whisper-${wName} [${tier}]`); ok++; } catch(e){ console.error(`[models] whisper ${wName} failed:`, e.message); fail++; }

    const llm = llmFileOverride ? { file: llmFileOverride, url: llmUrlOverride || llmFor(tier).url } : llmFor(tier);
    const lDest = path.join(outBase, "models", "llm", llm.file);
    // env URL overrides only when single tier
    const lUrl = (llmUrlOverride && targetTiers.length===1) ? llmUrlOverride : llm.url;
    try { await downloadFile(lUrl, lDest, `llm-${llm.file} [${tier}]`); ok++; } catch(e){ console.error(`[models] llm ${llm.file} failed:`, e.message); fail++; }
  }

  console.log(`\n[models] complete ok=${ok} fail=${fail} outBase=${outBase}`);
  console.log(`[models] layout:`);
  console.log(`  ${path.join(outBase, "models/whisper/ggml-*.bin")}`);
  console.log(`  ${path.join(outBase, "models/llm/*.gguf")}`);
  console.log(`\n[models] Next steps:`);
  console.log(`  - Dev: set USER_DATA_PATH=${outBase} and run electron dev — pipeline will find models without re-download`);
  console.log(`  - Installer: bundle ${outBase}/models into extraResources or pre-seed userData on first run`);
  if (fail) process.exitCode = 1;
}

main().catch(e=>{ console.error(e); process.exit(1); });
