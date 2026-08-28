import { spawn } from "node:child_process";
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
    return path.join(os.homedir(), ".clipforge");
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

async function ensureModel(name: string, onProgress?: (f: number) => void): Promise<string> {
  const p = modelPath(name);
  if (fs.existsSync(p) && fs.statSync(p).size > 1024) return p;
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;
  await downloadFile(url, p, onProgress);
  return p;
}

function downloadFile(url: string, dest: string, onProgress?: (f: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? require("node:https") : require("node:http");
    const file = fs.createWriteStream(dest);
    proto.get(url, (res: { statusCode?: number; headers: Record<string, string>; pipe: (s: unknown) => void; on: (e: string, cb: (c: Buffer) => void) => void }) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(dest, () => {});
        downloadFile(res.headers.location, dest, onProgress).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new TranscriptionError(`model download failed ${res.statusCode}`));
        return;
      }
      const total = parseInt(res.headers["content-length"] ?? "0", 10);
      let done = 0;
      res.on("data", (c: Buffer) => {
        done += c.length;
        if (onProgress && total) onProgress(done / total);
      });
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
      file.on("error", reject);
    }).on("error", reject);
  });
}

function extractAudio(videoPath: string): Promise<string> {
  const out = path.join(os.tmpdir(), `clipforge_${Date.now()}.wav`);
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBin(), ["-y", "-hide_banner", "-loglevel", "error", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out], { stdio: "pipe" });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => (code === 0 && fs.existsSync(out) ? resolve(out) : reject(new TranscriptionError(err || "ffmpeg extract failed"))));
    p.on("error", (e) => reject(new TranscriptionError(String(e))));
  });
}

export async function transcribeWithWords(videoPath: string, onProgress?: (f: number) => void, language?: string): Promise<TranscriptResult> {
  if (!fs.existsSync(videoPath)) throw new TranscriptionError(`File not found: ${videoPath}`);
  const tier = ramTier();
  const modelName = process.env.WHISPER_MODEL ?? whisperModelForTier(tier);
  onProgress?.(0.05);
  const model = await ensureModel(modelName, (f) => onProgress?.(0.05 + f * 0.15));
  onProgress?.(0.22);
  const wav = await extractAudio(videoPath);
  onProgress?.(0.28);
  try {
    const bin = whisperBin();
    const args = ["-m", model, "-f", wav, "--output-json", "--word-th timestamps", "-t", String(threadCount()), "--print-progress"];
    if (language) args.push("-l", language);
    const result = await new Promise<{ text: string; words: Word[] }>((resolve, reject) => {
      const p = spawn(bin, args, { stdio: "pipe" });
      let out = "", err = "";
      p.stdout.on("data", (d) => (out += d.toString()));
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("close", (code) => {
        if (code !== 0) { reject(new TranscriptionError(err || `whisper failed code ${code}`)); return; }
        try {
          const j = JSON.parse(out);
          const words: Word[] = [];
          const textParts: string[] = [];
          for (const seg of j.transcription ?? j.segments ?? []) {
            for (const tok of seg.tokens ?? seg.words ?? []) {
              const text = String(tok.text ?? tok.word ?? "").trim();
              if (!text) continue;
              textParts.push(text);
              const s = Math.round(Number(tok.offsets?.from ?? tok.start ?? 0));
              const e = Math.round(Number(tok.offsets?.to ?? tok.end ?? s + 200));
              words.push({ text, start_ms: s, end_ms: e });
            }
            if (!seg.tokens && seg.text) {
              const t = String(seg.text).trim();
              if (t) textParts.push(t);
            }
          }
          const fallbackText = j.text ?? textParts.join(" ");
          resolve({ text: fallbackText, words });
        } catch (e) { reject(new TranscriptionError(`parse whisper output: ${String(e)}`)); }
      });
      p.on("error", (e) => reject(new TranscriptionError(String(e))));
    });
    onProgress?.(1);
    return { text: result.text, words: result.words, language };
  } finally {
    try { fs.unlinkSync(wav); } catch {}
  }
}
