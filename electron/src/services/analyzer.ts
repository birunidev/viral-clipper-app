import { ramTier, llmModelForTier } from "./system.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";

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

const BLOCK_SECONDS = 30;
const DEFAULT_CHUNK_CHARS = 9000;

const SYSTEM_PROMPT = `You are a short-form video analyst. Read this portion of a video transcript and identify the most viral-worthy moments that would perform well as short vertical clips (TikTok, Reels, Shorts). For each clip provide a catchy title, a short one-line viral hook caption, and the start/end timestamps in seconds measured from the beginning of the source video. Return ONLY a JSON object matching this exact schema and nothing else:

{"clips": [{"title": "string", "hook": "string", "start": 12.5, "end": 38.0}]}

Rules:
- Transcript lines are prefixed with their [startS-endS] second offsets into the FULL video. Use those markers: clip start/end must fall inside the offsets of the lines you picked from.
- IMPORTANT: write the title and hook in the SAME language as the transcript.
- hook is a punchy attention-grabbing line (max ~15 words).
- start and end must be numbers in seconds, end > start.
- Clip length should be between {min_duration} and {max_duration} seconds.
- Return between 1 and 8 clips from THIS portion. If nothing compelling, return {"clips": []}.
`;

export class AnalysisError extends Error {}

const JSON_OBJECT_RE = /\{.*\}/s;
const JSON_ARRAY_RE = /\[.*\]/s;
const FENCE_RE = /```(?:json)?\s*/gi;

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", id: "Indonesian (Bahasa Indonesia)", es: "Spanish", pt: "Portuguese",
  fr: "French", de: "German", ja: "Japanese", ko: "Korean", zh: "Chinese",
  hi: "Hindi", ar: "Arabic", vi: "Vietnamese", th: "Thai", tr: "Turkish",
  ru: "Russian", it: "Italian", nl: "Dutch", ms: "Malay", tl: "Filipino (Tagalog)",
};

export function formatTimestampedWords(words: { text: string; start_ms: number; end_ms: number }[], blockSeconds = BLOCK_SECONDS): string[] {
  const lines: string[] = [];
  let blockStart: number | null = null;
  let blockEnd = 0;
  let buf: string[] = [];
  for (const w of words) {
    const s = Number(w.start_ms) / 1000, e = Math.max(s, Number(w.end_ms) / 1000);
    const t = String(w.text ?? "").trim();
    if (!t) continue;
    if (blockStart === null) blockStart = s;
    buf.push(t);
    blockEnd = e;
    if (blockEnd - blockStart >= blockSeconds) {
      lines.push(`[${Math.floor(blockStart)}s-${Math.floor(blockEnd)}s] ${buf.join(" ")}`);
      buf = []; blockStart = null;
    }
  }
  if (buf.length) lines.push(`[${Math.floor(blockStart ?? 0)}s-${Math.floor(blockEnd)}s] ${buf.join(" ")}`);
  return lines;
}

export function chunkLines(lines: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let cur: string[] = [], size = 0;
  for (const line of lines) {
    if (cur.length && size + line.length + 1 > maxChars) { chunks.push(cur.join("\n")); cur = []; size = 0; }
    cur.push(line); size += line.length + 1;
  }
  if (cur.length) chunks.push(cur.join("\n"));
  return chunks;
}

export function mergeClips(clips: { title: string; hook?: string; start: number; end: number }[]): typeof clips {
  const ordered = [...clips].sort((a, b) => a.start - b.start);
  const result: typeof clips = [];
  for (const c of ordered) {
    let dup = false;
    for (const k of result) {
      const inter = Math.min(k.end, c.end) - Math.max(k.start, c.start);
      const shorter = Math.min(k.end - k.start, c.end - c.start);
      if (shorter > 0 && inter / shorter > 0.5) { dup = true; break; }
    }
    if (!dup) result.push(c);
  }
  return result;
}

export function parseClips(raw: string, minDuration = 15, maxDuration = 90): { title: string; hook?: string; start: number; end: number }[] {
  if (!raw) return [];
  const text = raw.replace(FENCE_RE, "").trim();
  const candidates: string[] = [];
  const om = JSON_OBJECT_RE.exec(text);
  if (om) candidates.push(om[0]);
  const am = JSON_ARRAY_RE.exec(text);
  if (am) candidates.push(am[0]);
  const seen = new Set<string>();
  const clips: { title: string; hook?: string; start: number; end: number }[] = [];
  for (const cand of candidates) {
    let data: unknown;
    try { data = JSON.parse(cand); } catch { continue; }
    let arr: unknown[] = [];
    if (Array.isArray(data)) arr = data;
    else if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).clips)) arr = (data as Record<string, unknown>).clips as unknown[];
    else if (data && typeof data === "object") arr = [data];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const c = coerceClip(item as Record<string, unknown>, minDuration, maxDuration);
      if (c) {
        const k = `${c.title}:${c.start}:${c.end}`;
        if (!seen.has(k)) { seen.add(k); clips.push(c); }
      }
    }
  }
  return clips;
}

function coerceClip(item: Record<string, unknown>, minDuration: number, maxDuration: number): { title: string; hook?: string; start: number; end: number } | null {
  const title = String(item.title ?? "").trim();
  if (!title) return null;
  const start = Number(item.start), end = Number(item.end);
  if (!(end > start && start >= 0)) return null;
  if (minDuration > maxDuration) [minDuration, maxDuration] = [maxDuration, minDuration];
  let s = start, e = end;
  const dur = e - s;
  if (dur > maxDuration) e = s + maxDuration;
  else if (dur < minDuration) e = s + minDuration;
  if (s > 100000 || e > 100000) return null;
  const hook = String(item.hook ?? "").trim();
  return hook ? { title, hook, start: Math.round(s * 100) / 100, end: Math.round(e * 100) / 100 } : { title, start: Math.round(s * 100) / 100, end: Math.round(e * 100) / 100 };
}

function llmModelPath(): string {
  const tier = ramTier();
  const { file } = llmModelForTier(tier);
  const override = process.env.LLM_MODEL_FILE;
  const f = override ?? file;
  return path.join(getUserDataPath(), "models", "llm", f);
}

async function ensureLlmModel(onProgress?: (f: number) => void): Promise<string> {
  const tier = ramTier();
  const { file, url } = llmModelForTier(tier);
  const dest = path.join(getUserDataPath(), "models", "llm", file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const envUrl = process.env.LLM_MODEL_URL ?? url;
  await downloadFile(envUrl, dest, onProgress);
  return dest;
}

function downloadFile(url: string, dest: string, onProgress?: (f: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const h = url.startsWith("https") ? require("node:https") : require("node:http");
    const file = fs.createWriteStream(dest);
    h.get(url, (res: { statusCode?: number; headers: Record<string, string>; pipe: (s: unknown) => void; on: (e: string, cb: (c: Buffer) => void) => void }) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.unlink(dest, () => {});
        downloadFile(res.headers.location, dest, onProgress).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new AnalysisError(`LLM download ${res.statusCode}`)); return; }
      const total = parseInt(res.headers["content-length"] ?? "0", 10);
      let done = 0;
      res.on("data", (c: Buffer) => { done += c.length; if (onProgress && total) onProgress(done / total); });
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
      file.on("error", reject);
    }).on("error", reject);
  });
}

function mockAnalyze(words: { text: string; start_ms: number; end_ms: number }[] | undefined, transcript: string, minDuration: number, maxDuration: number, language?: string): { title: string; hook?: string; start: number; end: number }[] {
  const isId = (language ?? "en").toLowerCase().startsWith("id");
  const totalSec = words && words.length ? Math.max(...words.map((w) => w.end_ms)) / 1000 : Math.max(30, Math.ceil(transcript.length / 15));
  const clipCount = Math.min(3, Math.max(1, Math.floor(totalSec / 15)));
  const clips: { title: string; hook?: string; start: number; end: number }[] = [];
  for (let i = 0; i < clipCount; i++) {
    const start = Math.round((i * totalSec) / clipCount / 5) * 5;
    const end = Math.min(totalSec, start + minDuration + 5);
    clips.push({
      title: isId ? `Momen Viral ${i + 1}` : `Viral Moment ${i + 1}`,
      hook: isId ? "Jangan lewatkan momen ini" : "Don't miss this moment",
      start,
      end,
    });
  }
  return clips;
}

export async function analyze(transcript: string, words?: { text: string; start_ms: number; end_ms: number }[], opts: { language?: string; minDuration?: number; maxDuration?: number; onProgress?: (f: number) => void } = {}): Promise<{ title: string; hook?: string; start: number; end: number }[]> {
  const minDuration = opts.minDuration ?? 15;
  const maxDuration = opts.maxDuration ?? 90;
  if (!transcript.trim() && !words?.length) throw new AnalysisError("empty transcript");
  const apiKey = process.env.LLM_API_KEY?.trim();
  const baseUrl = process.env.LLM_BASE_URL?.trim();
  if (apiKey && baseUrl) {
    try {
      return await analyzeViaOpenAI(transcript, words, { ...opts, apiKey, baseUrl });
    } catch (e) {
      console.warn("[analyzer] openai failed, using mock", e);
      return mockAnalyze(words, transcript, minDuration, maxDuration, opts.language);
    }
  }
  try {
    return await analyzeLocal(transcript, words, opts);
  } catch (e) {
    console.warn("[analyzer] local failed, using mock", e);
    return mockAnalyze(words, transcript, minDuration, maxDuration, opts.language);
  }
}

async function analyzeViaOpenAI(transcript: string, words: { text: string; start_ms: number; end_ms: number }[] | undefined, opts: { language?: string; minDuration?: number; maxDuration?: number; onProgress?: (f: number) => void; apiKey: string; baseUrl: string }): Promise<{ title: string; hook?: string; start: number; end: number }[]> {
  const minDuration = opts.minDuration ?? 15, maxDuration = opts.maxDuration ?? 90;
  const model = process.env.LLM_MODEL ?? "gpt-4o-mini";
  let systemPrompt = SYSTEM_PROMPT.replace("{min_duration}", String(minDuration)).replace("{max_duration}", String(maxDuration));
  if (opts.language) {
    const name = LANGUAGE_NAMES[opts.language.toLowerCase()] ?? opts.language;
    systemPrompt += `\nLanguage hint: the transcript is in ${name} (code: ${opts.language}). Write every title and hook in ${name}, not English.`;
  }
  const chunkChars = parseInt(process.env.LLM_CHUNK_CHARS ?? String(DEFAULT_CHUNK_CHARS), 10) || DEFAULT_CHUNK_CHARS;
  const payloads = words?.length ? chunkLines(formatTimestampedWords(words), chunkChars) : [transcript.slice(0, 20000)];
  if (!payloads.length) payloads.push("");
  const collected: { title: string; hook?: string; start: number; end: number }[] = [];
  for (let i = 0; i < payloads.length; i++) {
    const payload = payloads[i];
    const res = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: payload.slice(0, 20000) }],
        response_format: { type: "json_object" },
        temperature: 0.4,
      }),
    });
    if (!res.ok) {
      if (payloads.length === 1) throw new AnalysisError(`LLM ${res.status}: ${await res.text().catch(() => "")}`);
      continue;
    }
    const j = await res.json() as { choices?: { message?: { content?: string } }[] };
    const raw = j.choices?.[0]?.message?.content ?? "";
    collected.push(...parseClips(raw, minDuration, maxDuration));
    opts.onProgress?.((i + 1) / payloads.length);
  }
  const merged = mergeClips(collected);
  if (!merged.length) throw new AnalysisError("no clips");
  return merged;
}

async function analyzeLocal(transcript: string, words: { text: string; start_ms: number; end_ms: number }[] | undefined, opts: { language?: string; minDuration?: number; maxDuration?: number; onProgress?: (f: number) => void }): Promise<{ title: string; hook?: string; start: number; end: number }[]> {
  const minDuration = opts.minDuration ?? 15, maxDuration = opts.maxDuration ?? 90;
  let systemPrompt = SYSTEM_PROMPT.replace("{min_duration}", String(minDuration)).replace("{max_duration}", String(maxDuration));
  if (opts.language) {
    const name = LANGUAGE_NAMES[opts.language.toLowerCase()] ?? opts.language;
    systemPrompt += `\nLanguage hint: the transcript is in ${name} (code: ${opts.language}). Write every title and hook in ${name}, not English.`;
  }
  const chunkChars = parseInt(process.env.LLM_CHUNK_CHARS ?? String(DEFAULT_CHUNK_CHARS), 10) || DEFAULT_CHUNK_CHARS;
  const payloads = words?.length ? chunkLines(formatTimestampedWords(words), chunkChars) : [transcript.slice(0, 20000)];
  if (!payloads.length) payloads.push("");
  const modelPath = await ensureLlmModel((f) => opts.onProgress?.(f * 0.3));
  const { getLlama, LlamaChatSession } = await import("node-llama-cpp");
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext();
  const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt });
  const collected: { title: string; hook?: string; start: number; end: number }[] = [];
  for (let i = 0; i < payloads.length; i++) {
    try {
      const raw = await session.prompt(payloads[i].slice(0, 20000), { temperature: 0.4, maxTokens: 1024 });
      collected.push(...parseClips(raw, minDuration, maxDuration));
    } catch {}
    opts.onProgress?.(0.3 + 0.7 * ((i + 1) / payloads.length));
  }
  try { await context.dispose(); await model.dispose(); } catch {}
  const merged = mergeClips(collected);
  if (!merged.length) throw new AnalysisError("no clips");
  return merged;
}
