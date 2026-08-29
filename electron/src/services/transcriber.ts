import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { ramTier, whisperModelForTier, threadCount } from "./system.js";
import { ffmpegPath, whisperPath } from "./bin.js";

const require = createRequire(import.meta.url);

function getUserDataPath(): string {
  if (process.env.USER_DATA_PATH) return process.env.USER_DATA_PATH;
  try {
    const { app } = require("electron") as { app: { getPath: (n: string) => string } };
    return app.getPath("userData");
  } catch {
    return path.join(os.homedir(), ".clipzard");
  }
}

export type Word = { text: string; start_ms: number; end_ms: number };
export type TranscriptResult = { text: string; words: Word[]; language?: string };

export class TranscriptionError extends Error {}

function ffmpegBin(): string { return ffmpegPath(); }
function whisperBin(): string { return whisperPath(); }

function modelsDir(): string {
  const d = path.join(getUserDataPath(), "models", "whisper");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function modelPath(name: string): string {
  return path.join(modelsDir(), `ggml-${name}.bin`);
}

const MODEL_EXPECTED: Record<string, number> = {
  tiny: 75680328,
  base: 148000000, // ~141 MB actual, allow 10% slack
  small: 488000000,
  medium: 1533763059,
  large: 3090000000,
  "large-v1": 3090000000,
  "large-v2": 3090000000,
  "large-v3": 3090000000,
};

async function ensureModel(name: string, onProgress?: (f: number) => void): Promise<string> {
  const p = modelPath(name);
  if (fs.existsSync(p)) {
    const sz = fs.statSync(p).size;
    const exp = MODEL_EXPECTED[name] ?? 0;
    // If file >1 MB and within 15% of expected, treat as valid. If truncated (<85%), re-download.
    if (sz > 1024 && (!exp || sz > exp * 0.85)) return p;
    if (exp && sz < exp * 0.85) {
      console.warn(`[transcriber] model ${name} truncated ${sz} < ${exp} (85%), re-downloading`);
      try { fs.unlinkSync(p); } catch {}
    } else if (sz > 1024) return p;
  }
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;
  await downloadFile(url, p, onProgress, MODEL_EXPECTED[name] ?? 0);
  return p;
}

function downloadFile(url: string, dest: string, onProgress?: (f: number) => void, expectedBytes = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? require("node:https") : require("node:http");
    const file = fs.createWriteStream(dest);
    proto.get(url, (res: { statusCode?: number; headers: Record<string, string>; pipe: (s: unknown) => void; on: (e: string, cb: (c: Buffer) => void) => void }) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(dest, () => {});
        downloadFile(res.headers.location, dest, onProgress, expectedBytes).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new TranscriptionError(`model download failed ${res.statusCode}`));
        return;
      }
      // HF streams chunked (no content-length) — use known model size fallback
      const total = parseInt(res.headers["content-length"] ?? "0", 10) || expectedBytes;
      let done = 0;
      let lastMbLog = 0;
      res.on("data", (c: Buffer) => {
        done += c.length;
        if (!onProgress) return;
        if (total) onProgress(Math.min(1, done / total));
        else if (done - lastMbLog >= 10 * 1048576) { lastMbLog = done; console.log(`[transcriber] model downloaded ${(done / 1048576).toFixed(0)} MB`); }
      });
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
      file.on("error", reject);
    }).on("error", reject);
  });
}

function extractAudio(videoPath: string): Promise<string> {
  const out = path.join(os.tmpdir(), `clipzard_${Date.now()}.wav`);
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBin(), ["-y", "-hide_banner", "-loglevel", "error", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out], { stdio: "pipe" });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (code === 0 && fs.existsSync(out)) return resolve(out);
      let msg = err || "ffmpeg extract failed";
      // "Output file does not contain any stream" = the source has no audio track
      // (video-only yt-dlp download or muted upload). NO_AUDIO_TRACK is a stable
      // token — main.ts purges source + youtube-cache on it so retry re-downloads.
      if (msg.includes("does not contain any stream")) {
        msg = `NO_AUDIO_TRACK: source video has no audio stream (video-only download or muted file) — job will purge the cached source; press Start again to re-download with merged audio`;
      }
      reject(new TranscriptionError(msg));
    });
    p.on("error", (e) => reject(new TranscriptionError(String(e))));
  });
}

function normalizeLang(code?: string | null): string | null {
  if (!code) return null;
  const s = String(code).trim().toLowerCase();
  if (!s || s === "null" || s === "undefined" || s === "auto") return null;
  return s.split(/[-_]/)[0] ?? null;
}

const MOCK_TEXTS: Record<string, string> = {
  id: "Halo teman teman hari ini kita akan membahas tentang bitcoin dan market yang sedang turun karena The Fed memberikan sinyal hawkish dan investor mulai khawatir akan inflasi dan suku bunga yang naik ",
  en: "Hey everyone today we talk about bitcoin and the market crash because The Fed gave a hawkish signal and investors are worried about inflation and rising interest rates ",
};

function mockTranscript(_videoPath: string, lang?: string): TranscriptResult {
  const norm = normalizeLang(lang) ?? "id";
  const sampleBase = MOCK_TEXTS[norm] ?? MOCK_TEXTS[norm.startsWith("id") ? "id" : "en"] ?? MOCK_TEXTS.en;
  const sampleText = sampleBase.repeat(4);
  const durationMs = 30000;
  const wordsRaw = sampleText.trim().split(/\s+/);
  const words: Word[] = wordsRaw.map((text, i) => ({
    text,
    start_ms: Math.round((i * durationMs) / wordsRaw.length),
    end_ms: Math.round(((i + 1) * durationMs) / wordsRaw.length),
  }));
  const text = words.map((w) => w.text).join(" ");
  return { text, words, language: norm };
}

function mockAllowed(): boolean {
  return process.env.CLIPZARD_ALLOW_MOCK === "1";
}

function whisperMissingError(bin: string): TranscriptionError {
  return new TranscriptionError(
    `whisper-cli not found at ${bin} — real transcription requires the binary. ` +
    `Fix: run "npm run setup:whisper" in electron/ (auto-downloads official prebuilt whisper-cli.exe). ` +
    `Dev-only mock opt-out: set CLIPZARD_ALLOW_MOCK=1`
  );
}

export async function transcribeWithWords(videoPath: string, onProgress?: (f: number) => void, language?: string): Promise<TranscriptResult> {
  if (!fs.existsSync(videoPath)) throw new TranscriptionError(`File not found: ${videoPath}`);
  const bin = whisperBin();
  if (!fs.existsSync(bin)) {
    if (mockAllowed()) {
      console.log(`[transcriber] whisper binary not found at ${bin}, using mock transcript (CLIPZARD_ALLOW_MOCK=1)`);
      onProgress?.(0.5);
      await new Promise((r) => setTimeout(r, 300));
      onProgress?.(1);
      return mockTranscript(videoPath, language);
    }
    throw whisperMissingError(bin);
  }
  // The binary may exist but fail to load (missing libwhisper.so.1/libggml.so.0).
  // Do a cheap smoke test so we fall back to mock instead of hard-failing later.
  try {
    const probe = spawn(bin, ["--help"], { stdio: "ignore", env: { ...process.env, LD_LIBRARY_PATH: path.dirname(bin) } });
    const probeOk = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => { try { probe.kill("SIGKILL"); } catch {} resolve(false); }, 8000);
      probe.on("close", (code) => { clearTimeout(t); resolve(code === 0); });
      probe.on("error", () => { clearTimeout(t); resolve(false); });
    });
    if (!probeOk) {
      if (mockAllowed()) {
        console.log(`[transcriber] whisper binary at ${bin} failed to load (missing shared libs?), using mock transcript (CLIPZARD_ALLOW_MOCK=1)`);
        onProgress?.(0.5);
        await new Promise((r) => setTimeout(r, 300));
        onProgress?.(1);
        return mockTranscript(videoPath, language);
      }
      throw new TranscriptionError(
        `whisper-cli at ${bin} exists but failed to load (exit != 0 — missing DLLs?). ` +
        `Fix: re-run "npm run setup:whisper" to reinstall the full prebuilt bundle (exe + DLLs). ` +
        `Dev-only mock opt-out: set CLIPZARD_ALLOW_MOCK=1`
      );
    }
  } catch {
    // ignore probe failures; let the real run surface any deeper error
  }
  const tier = ramTier();
  const modelName = process.env.WHISPER_MODEL ?? whisperModelForTier(tier);
  onProgress?.(0.05);
  let model: string;
  try {
    model = await ensureModel(modelName, (f) => onProgress?.(0.05 + f * 0.15));
  } catch (e) {
    if (mockAllowed()) {
      console.warn(`[transcriber] model ensure failed ${e}, using mock (CLIPZARD_ALLOW_MOCK=1)`);
      onProgress?.(1);
      return mockTranscript(videoPath, language);
    }
    throw new TranscriptionError(`whisper model download failed: ${String((e as Error).message ?? e)} — check network or set WHISPER_MODEL; dev-only mock opt-out: CLIPZARD_ALLOW_MOCK=1`);
  }
  onProgress?.(0.22);
  let wav: string;
  try {
    wav = await extractAudio(videoPath);
  } catch (e) {
    if (mockAllowed()) {
      console.warn(`[transcriber] extract failed ${e}, using mock (CLIPZARD_ALLOW_MOCK=1)`);
      onProgress?.(1);
      return mockTranscript(videoPath, language);
    }
    throw new TranscriptionError(`ffmpeg audio extraction failed: ${String((e as Error).message ?? e)} (dev-only mock opt-out: CLIPZARD_ALLOW_MOCK=1)`);
  }
  onProgress?.(0.28);
  // Retry once if model file is corrupted (truncated) — delete and re-download.
  let attempt = 0;
  try {
  while (attempt < 2) {
    try {
    // whisper.cpp writes JSON to a file: <base>.json when using -oj / -ojf
    // Use -of <base> + -ojf (full JSON with tokens) so we can read it reliably.
    const base = wav.replace(/\.wav$/i, "");
    const jsonPath = `${base}.json`;
    // Clean any previous json
    try { fs.unlinkSync(jsonPath); } catch {}
    const args = ["-m", model, "-f", wav, "-ojf", "-of", base, "-t", String(threadCount()), "-pp"];
    // Auto-use GPU when available: if cuda/vulkan DLL present or nvidia-smi succeeds, whisper.cpp CUDA build will offload
    // Keep CPU fallback: if GPU binary missing, still runs on CPU (no flag needed)
    const useGpu = (() => {
      if (process.env.WHISPER_GPU === "0" || process.env.CUDA_VISIBLE_DEVICES === "-1") return false;
      try {
        const dir = path.dirname(bin);
        if (fs.existsSync(path.join(dir, "ggml-cuda.dll")) || fs.existsSync(path.join(dir, "ggml-vulkan.dll")) || fs.existsSync(path.join(dir, "ggml-cuda.so")) ) return true;
      } catch {}
      try {
        const r = spawnSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { stdio: "pipe", timeout: 3000 });
        if (r.status === 0 && String(r.stdout ?? "").trim().length > 0) return true;
      } catch {}
      return false;
    })();
    if (useGpu) console.log("[transcriber] GPU detected — using CUDA/Vulkan acceleration");
    else console.log("[transcriber] GPU not detected — using CPU");
    const normLang = normalizeLang(language);
    if (normLang) {
      args.push("-l", normLang);
      if (normLang === "id") args.push("--prompt", "Ini adalah transkrip video berbahasa Indonesia yang akurat kata per kata.");
    } else args.push("-l", "auto");
    console.log(`[transcriber] spawn ${bin} ${args.join(" ")} (attempt ${attempt+1}) ${useGpu ? "[GPU]" : "[CPU]"}`);
    let detectedFromStderr: string | null = null;
    const result = await new Promise<{ text: string; words: Word[]; detected?: string | null }>((resolve, reject) => {
      const p = spawn(bin, args, { stdio: "pipe" });
      let out = "", err = "";
      p.stdout.on("data", (d) => (out += d.toString()));
      p.stderr.on("data", (d) => {
        const s = d.toString();
        err += s;
        // Try to capture auto-detected language from whisper stderr: "detected language: en" / "auto-detected language: id"
        const langM = s.match(/(?:detected|auto[-\s]*detected)\s+language\s*[:=]\s*([a-z]{2,3})/i) ?? s.match(/\blanguage\s*[:=]\s*([a-z]{2,3})\b/i);
        if (langM) detectedFromStderr = normalizeLang(langM[1]);
        // "whisper_print_progress_callback: progress =  45%"  -> fraction 0..1
        const m = s.match(/progress\s*=\s*\+?(\d+)%/);
        if (m && onProgress) {
          const v = Math.min(1, Number(m[1]) / 100);
          // whisper reports in progress_step chunks (default 5%); still monotonic
          onProgress(v);
        }
      });
      p.on("close", (code) => {
        console.log(`[transcriber] exit ${code} out=${out.slice(0,300)} err=${err.slice(0,600)} jsonExists=${fs.existsSync(jsonPath)}`);
        if (code !== 0) {
          // Detect truncated model: "not all tensors loaded ... expected 947, got 725"
          if (err.includes("not all tensors loaded") || err.includes("failed to load model")) {
            reject(new TranscriptionError(`CORRUPT_MODEL:${err.slice(0,400)}`));
          } else {
            reject(new TranscriptionError(err || out || `whisper failed code ${code}`));
          }
          return;
        }
        try {
          // Prefer file output (whisper.cpp v1.7+ writes to <base>.json with -ojf)
          let j: unknown = null;
          if (fs.existsSync(jsonPath)) {
            const raw = fs.readFileSync(jsonPath, "utf8");
            j = JSON.parse(raw);
            // cleanup json file after read
            try { fs.unlinkSync(jsonPath); } catch {}
          } else if (out.trim()) {
            // Fallback: some builds print JSON to stdout
            j = JSON.parse(out);
          } else {
            throw new Error(`no JSON output (stdout ${out.length} chars, err ${err.slice(0,200)}, json file missing)`);
          }
          const jo = j as Record<string, unknown>;
          // whisper.cpp json may contain detected language at top-level: { language, params: { language } }
          const jsonLangRaw = String((jo.language as string | undefined) ?? ((jo.params as Record<string, unknown> | undefined)?.language as string | undefined) ?? (jo as Record<string, unknown>).detected_language as string | undefined ?? "");
          const jsonLang = normalizeLang(jsonLangRaw);
          if (jsonLang && !detectedFromStderr) detectedFromStderr = jsonLang;
          const words: Word[] = [];
          const textParts: string[] = [];
          // whisper.cpp json shape: { transcription: [{ timestamps: { from, to }, offsets: { from,to }, text, tokens: [{ text, offsets, ...}] }] }
          // older shape: { segments: [...] }
          const segments = (jo.transcription ?? jo.segments ?? []) as unknown[];
          for (const seg of segments as Record<string, unknown>[]) {
            const segText = String((seg as Record<string, unknown>).text ?? "").trim();
            if (segText) textParts.push(segText);
            const tokens = (seg as Record<string, unknown>).tokens as unknown[] | undefined;
            const segTokens = tokens ?? ((seg as Record<string, unknown>).words as unknown[]);
            if (Array.isArray(segTokens) && segTokens.length) {
              // Merge subword tokens into proper words (fixes "tekn olog i" -> "teknologi")
              let pending: Word | null = null;
              const flush = () => { if (pending) { words.push(pending); textParts.push(pending.text); pending = null; } };
              for (const tok of segTokens as Record<string, unknown>[]) {
                const raw = String(tok.text ?? tok.word ?? "");
                const text = raw.trim();
                if (!text) continue;
                // Skip special tokens like [_BEG_], [_TT_123], <|...|>
                if (/^\[.*\]$/.test(text) || /^<\|.*\|>$/.test(text) || /^\[_.*_\]$/.test(text)) continue;
                const off = tok.offsets as Record<string, unknown> | undefined;
                const ts = tok.timestamps as Record<string, unknown> | undefined;
                const sRaw = off?.from ?? ts?.from ?? tok.start ?? tok.t0 ?? 0;
                const eRaw = off?.to ?? ts?.to ?? tok.end ?? tok.t1 ?? 0;
                const s = Math.round(Number(sRaw));
                const e = Math.round(Number(eRaw ?? s + 200));
                const sMs = s;
                const eMs = e;
                // Heuristic: new word if raw starts with space/▁ or pending is null
                const isNewWord = !pending || raw.startsWith(" ") || raw.startsWith("▁") || raw.startsWith("Ġ");
                if (isNewWord) {
                  flush();
                  pending = { text, start_ms: sMs, end_ms: Math.max(eMs, sMs + 80) };
                } else {
                  pending!.text += text;
                  pending!.end_ms = Math.max(eMs, pending!.end_ms);
                }
              }
              flush();
            } else {
              // Fallback: split seg text into words distributed over segment interval
              const ts = (seg as Record<string, unknown>).timestamps as Record<string, unknown> | undefined;
              const off = (seg as Record<string, unknown>).offsets as Record<string, unknown> | undefined;
              const s = Number(ts?.from ?? off?.from ?? 0);
              const e = Number(ts?.to ?? off?.to ?? s + 1000);
              if (segText) {
                const parts = segText.split(/\s+/).filter(Boolean);
                const dur = Math.max(e - s, parts.length * 200);
                for (let i = 0; i < parts.length; i++) {
                  const ws = Math.round(s + (i * dur) / parts.length);
                  const we = Math.round(s + ((i + 1) * dur) / parts.length);
                  words.push({ text: parts[i], start_ms: ws, end_ms: we });
                }
              }
            }
          }
          // Dedupe textParts vs words to avoid duplicate push above
          const uniqText = [...new Set(textParts)].join(" ");
          const fallbackText = (jo.text as string | undefined) ?? uniqText ?? words.map(w=>w.text).join(" ");
          if (!words.length) throw new Error(`no words parsed from ${JSON.stringify(jo).slice(0,500)}`);
          resolve({ text: fallbackText, words, detected: detectedFromStderr });
        } catch (e) { reject(new TranscriptionError(`parse whisper output: ${String(e)} | stdout=${out.slice(0,300)} err=${err.slice(0,300)}`)); }
      });
      p.on("error", (e) => reject(new TranscriptionError(String(e))));
    });
    onProgress?.(1);
    const finalLang = normalizeLang(result.detected) ?? normLang ?? normalizeLang(language) ?? null;
    return { text: result.text, words: result.words, language: finalLang ?? undefined };
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (msg.includes("CORRUPT_MODEL") && attempt === 0) {
        console.warn(`[transcriber] model corrupted for ${modelName}, deleting and re-downloading...`);
        try { fs.unlinkSync(model); } catch {}
        model = await ensureModel(modelName, (f) => onProgress?.(0.05 + f * 0.15));
        attempt++;
        continue;
      }
      throw e;
    }
    } // while
    throw new TranscriptionError("transcribe failed after retry");
  } finally {
    try { fs.unlinkSync(wav); } catch {}
    try { fs.unlinkSync(wav.replace(/\.wav$/i, "") + ".json"); } catch {}
  }
}
