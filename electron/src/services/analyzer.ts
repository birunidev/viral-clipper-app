import { ramTier, llmModelForTier } from "./system.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { userDataRoot } from "./userData.js";

const require = createRequire(import.meta.url);

function getUserDataPath(): string {
  return userDataRoot();
}

const BLOCK_SECONDS = 30;
const DEFAULT_CHUNK_CHARS = 9000;

// LOCKED for hook FINDING (scoring/ranking via scorer.ts + LLM ensemble) — do not change ranking logic
// TWEAKED for hook/title GENERATION only (below) — user requested natural title/hook tune
// EXTENDED for 05 Qwen Director — adds editorial angle + viral reasoning without breaking ranking
const SYSTEM_PROMPT = `You are a short-form video analyst. Read this portion of a video transcript and identify the most viral-worthy moments that would perform well as short vertical clips (TikTok, Reels, Shorts). For each clip provide a catchy title, a short one-line viral hook caption, and the start/end timestamps in seconds measured from the beginning of the source video. Return ONLY a JSON object matching this exact schema and nothing else:

{"clips": [{"title": "string", "hook": "string", "start": 12.5, "end": 38.0}]}

Rules:
- Transcript lines are prefixed with their [startS-endS] second offsets into the FULL video. Use those markers: clip start/end must fall inside the offsets of the lines you picked from.
- CRITICAL: write the title and hook in the SAME language as the transcript. Detect the transcript language if no hint is given — never default to English.
- HOOK generation (tweaked for natural virality, max 12 words, no hashtags):
  - Must be a curiosity gap or strong payoff, not a summary. Use hook patterns: question ("Why…?", "Kenapa…?"), "you won't believe", "kamu tidak akan percaya", "the truth about", "rahasia", "what happens when", "watch this", "wait for it".
  - Start with strong verb, number, or "you"/"kamu" when possible. Conversational, TikTok-native — never generic like "Don't miss this" or "Jangan lewatkan".
  - Use words actually in the transcript portion, but rephrase for punch. For ID, keep casual Bahasa, not formal.
- TITLE generation (tweaked for natural, 3-7 words, curiosity-driven):
  - Specific, not clickbait vague. Use 1-2 keywords from transcript + transformation/secret/money/hack angle when relevant.
  - For EN: Title Case, for ID: natural Bahasa (no Title Case needed). Keep it tight, no hashtags, no emojis.
  - Examples of good vs bad:
    - Bad: "Viral Moment 1" / "Momen Viral 1" / "Don't miss this moment"
    - Good: "Fed Just Crashed Bitcoin" / "The Fed Bikin Bitcoin Anjlok" (specific + curiosity)
- start and end must be numbers in seconds, end > start.
- Clip length should be between {min_duration} and {max_duration} seconds.
- NEVER produce clips beyond the last timestamp in the transcript. The last [startS-endS] marker is the video end — cap all start/end within 0 to that max end. If no marker exceeds your clip, discard it.
- Return between 1 and 8 clips from THIS portion. If nothing compelling, return {"clips": []}.

Examples (follow this style for any language):
- EN transcript: "bitcoin crashed because The Fed is hawkish..." -> {"title": "Fed Just Crashed Bitcoin", "hook": "Why your portfolio is down today", "start": 12, "end": 38}
- EN transcript: "I quit my 9-to-5 to sell cookies on TikTok..." -> {"title": "I Quit My Job for Cookies", "hook": "This cookie paid my rent", "start": 5, "end": 28}
- EN transcript: "the secret to saving $10k is not budgeting, it's..." -> {"title": "The $10K Secret No One Tells You", "hook": "You won't believe what actually saves money", "start": 45, "end": 70}
- ID transcript: "kita bahas kenapa bitcoin turun karena The Fed hawkish..." -> {"title": "The Fed Bikin Bitcoin Anjlok", "hook": "Kenapa portofolio kamu merah hari ini?", "start": 8, "end": 32}
- ID transcript: "aku resign kerja kantoran jualan kue di TikTok..." -> {"title": "Resign Demi Jualan Kue", "hook": "Kue ini yang bayar kosanku", "start": 6, "end": 30}
- ID transcript: "rahasia nabung 10 juta bukan budgeting, tapi..." -> {"title": "Rahasia Nabung 10 Juta", "hook": "Kamu tidak akan percaya yang bikin hemat", "start": 40, "end": 65}

Optional structured context (if provided, use it to avoid choosing solely on dramatic sentences — prefer standalone payoff + clear hook):
- faces: nearby face count/confidence, scenes: boundaries, silences: pauses you may keep if intentional, tightness: social
`;

export class AnalysisError extends Error {}

const JSON_OBJECT_RE = /\{.*\}/s;
const JSON_ARRAY_RE = /\[.*\]/s;
const FENCE_RE = /```(?:json)?\s*/gi;

// whisper.cpp (ggml-small) supports 99 languages — keep full map so LLM hint is natural even for low-resource langs
export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", id: "Indonesian (Bahasa Indonesia)", ms: "Malay", jv: "Javanese", su: "Sundanese",
  zh: "Chinese", yue: "Cantonese", ja: "Japanese", ko: "Korean", vi: "Vietnamese", th: "Thai",
  lo: "Lao", km: "Khmer", my: "Burmese", tl: "Filipino (Tagalog)", ceb: "Cebuano",
  hi: "Hindi", bn: "Bengali", ta: "Tamil", te: "Telugu", kn: "Kannada", ml: "Malayalam",
  gu: "Gujarati", mr: "Marathi", pa: "Punjabi", ur: "Urdu", ne: "Nepali", si: "Sinhala",
  ar: "Arabic", fa: "Persian", he: "Hebrew", tr: "Turkish", az: "Azerbaijani",
  es: "Spanish", pt: "Portuguese", fr: "French", de: "German", it: "Italian", nl: "Dutch",
  pl: "Polish", cs: "Czech", sk: "Slovak", hu: "Hungarian", ro: "Romanian", bg: "Bulgarian",
  hr: "Croatian", sr: "Serbian", sl: "Slovenian", uk: "Ukrainian", ru: "Russian", be: "Belarusian",
  el: "Greek", lt: "Lithuanian", lv: "Latvian", et: "Estonian", fi: "Finnish", sv: "Swedish",
  da: "Danish", no: "Norwegian", nn: "Norwegian Nynorsk", is: "Icelandic", ga: "Irish", mt: "Maltese",
  ca: "Catalan", gl: "Galician", eu: "Basque", cy: "Welsh", af: "Afrikaans", sw: "Swahili",
  am: "Amharic", yo: "Yoruba", ha: "Hausa", so: "Somali",
  ka: "Georgian", hy: "Armenian", kk: "Kazakh", uz: "Uzbek", mn: "Mongolian", ky: "Kyrgyz",
  tg: "Tajik", tk: "Turkmen", tt: "Tatar", ba: "Bashkir",
  ps: "Pashto", sd: "Sindhi", ku: "Kurdish", bo: "Tibetan", mi: "Maori", haw: "Hawaiian",
  sa: "Sanskrit", as: "Assamese", or: "Odia", br: "Breton", fo: "Faroese", lb: "Luxembourgish",
  oc: "Occitan", an: "Aragonese", mg: "Malagasy", co: "Corsican", fy: "Frisian", gd: "Scottish Gaelic",
  ht: "Haitian Creole", ln: "Lingala", sn: "Shona", wo: "Wolof",
};

export function normalizeLang(code?: string | null): string | null {
  if (!code) return null;
  const s = String(code).trim().toLowerCase();
  if (!s || s === "null" || s === "undefined" || s === "auto") return null;
  return s.split(/[-_]/)[0] ?? null;
}

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

const LLM_EXPECTED_MB: Record<string, number> = {
  "qwen2.5-0.5b-q4_k_m.gguf": 380,
  "qwen2.5-1.5b-q4_k_m.gguf": 950,
  "qwen2.5-3b-q4_k_m.gguf": 2000,
  "qwen2.5-7b-q4_k_m.gguf": 4700,
  "qwen2.5-14b-q4_k_m.gguf": 8500,
};

async function ensureLlmModel(onProgress?: (f: number) => void): Promise<string> {
  const tier = ramTier();
  const { file, url } = llmModelForTier(tier);
  const dest = path.join(getUserDataPath(), "models", "llm", file);
  if (fs.existsSync(dest)) {
    const sz = fs.statSync(dest).size;
    const expMb = LLM_EXPECTED_MB[file];
    // Truncated download (llama.cpp fails with "data is not within the file
    // bounds") — delete and re-download instead of failing on every job.
    if (expMb && sz < expMb * 1024 * 1024 * 0.85) {
      console.warn(`[analyzer] LLM model ${file} truncated (${(sz / 1048576).toFixed(0)} MB < 85% of ${expMb} MB) — re-downloading`);
      try { fs.unlinkSync(dest); } catch {}
    } else if (sz > 1024 * 1024) return dest;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const envUrl = process.env.LLM_MODEL_URL ?? url;
  const expectedBytes = (LLM_EXPECTED_MB[file] ?? 0) * 1048576;
  console.log(`[analyzer] LLM model not found — downloading ${file}${expectedBytes ? ` (~${(expectedBytes / 1048576).toFixed(0)} MB)` : ""} to ${dest} (this can take minutes). Pre-download with: npm run setup:models`);
  let lastLogged = -1;
  await downloadFile(envUrl, dest, (f) => {
    onProgress?.(f);
    const pct = Math.floor(f * 100);
    if (pct % 5 === 0 && pct !== lastLogged) { lastLogged = pct; console.log(`[analyzer] LLM download ${pct}%`); }
  }, expectedBytes);
  return dest;
}

function downloadFile(url: string, dest: string, onProgress?: (f: number) => void, expectedBytes = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const h = url.startsWith("https") ? require("node:https") : require("node:http");
    const file = fs.createWriteStream(dest);
    h.get(url, (res: { statusCode?: number; headers: Record<string, string>; pipe: (s: unknown) => void; on: (e: string, cb: (c: Buffer) => void) => void }) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.unlink(dest, () => {});
        downloadFile(res.headers.location, dest, onProgress, expectedBytes).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new AnalysisError(`LLM download ${res.statusCode}`)); return; }
      // HF often streams chunked (no content-length) — fall back to the known
      // expected size so progress actually moves instead of sticking at 0%.
      const total = parseInt(res.headers["content-length"] ?? "0", 10) || expectedBytes;
      let done = 0;
      let lastMbLog = 0;
      res.on("data", (c: Buffer) => {
        done += c.length;
        if (!onProgress) return;
        if (total) onProgress(Math.min(1, done / total));
        else if (done - lastMbLog >= 25 * 1048576) { lastMbLog = done; console.log(`[analyzer] LLM downloaded ${(done / 1048576).toFixed(0)} MB`); }
      });
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
      file.on("error", reject);
    }).on("error", reject);
  });
}

const MOCK_TEMPLATES: Record<string, { titles: string[]; hooks: string[] }> = {
  en: { titles: ["Fed Just Crashed Bitcoin", "This Cookie Paid My Rent", "Market Panic Explained"], hooks: ["Why your portfolio is red today", "This cookie paid my rent", "The signal everyone missed"] },
  id: { titles: ["The Fed Bikin Bitcoin Anjlok", "Resign Demi Jualan Kue", "Market Panik Dijelaskan"], hooks: ["Kenapa portofolio kamu merah hari ini?", "Kue ini yang bayar kosanku", "Sinyal yang semua orang lewatkan"] },
};

function mockAnalyze(words: { text: string; start_ms: number; end_ms: number }[] | undefined, transcript: string, minDuration: number, maxDuration: number, language?: string): { title: string; hook?: string; start: number; end: number }[] {
  const lang = normalizeLang(language) ?? "en";
  const tmpl = MOCK_TEMPLATES[lang];
  const totalSec = words && words.length ? Math.max(...words.map((w) => w.end_ms)) / 1000 : Math.max(30, Math.ceil(transcript.length / 15));
  const clipCount = Math.min(3, Math.max(1, Math.floor(totalSec / 15)));
  const clips: { title: string; hook?: string; start: number; end: number }[] = [];
  // Use real transcript words for natural titles when possible
  const kw = transcript.split(/\s+/).filter((w) => w.length > 3).slice(0, 8).join(" ").slice(0, 40);
  for (let i = 0; i < clipCount; i++) {
    const start = Math.round((i * totalSec) / clipCount / 5) * 5;
    const end = Math.min(totalSec, start + minDuration + 5);
    if (tmpl) {
      clips.push({ title: tmpl.titles[i % tmpl.titles.length], hook: tmpl.hooks[i % tmpl.hooks.length], start, end });
    } else {
      const name = LANGUAGE_NAMES[lang] ?? lang;
      clips.push({ title: kw ? `${kw.slice(0, 28)}...` : `Viral ${name} Moment ${i + 1}`, hook: kw ? kw.slice(0, 48) : `Hook in ${name}`, start, end });
    }
  }
  return clips;
}

export async function analyze(transcript: string, words?: { text: string; start_ms: number; end_ms: number }[], opts: { language?: string; minDuration?: number; maxDuration?: number; onProgress?: (f: number) => void } = {}): Promise<{ title: string; hook?: string; start: number; end: number }[]> {
  const minDuration = opts.minDuration ?? 15;
  const maxDuration = opts.maxDuration ?? 90;
  if (!transcript.trim() && !words?.length) throw new AnalysisError("empty transcript");
  // CLIPZARD_FORCE_MOCK=1 → skip local LLM entirely (no multi-GB model download).
  // Used by verify scripts; the app itself never sets this.
  if (process.env.CLIPZARD_FORCE_MOCK === "1") {
    console.log("[analyzer] CLIPZARD_FORCE_MOCK=1 — using mock analyzer");
    return mockAnalyze(words, transcript, minDuration, maxDuration, opts.language);
  }
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
  // Load with one corrupt-model retry: llama.cpp fails with "data is not
  // within the file bounds" on truncated GGUFs — delete + re-download + retry.
  let model: Awaited<ReturnType<typeof llama.loadModel>>;
  try {
    model = await llama.loadModel({ modelPath });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (/corrupt|file bounds|failed to load model|not all tensors/i.test(msg)) {
      console.warn(`[analyzer] LLM model corrupted (${msg.slice(0, 160)}) — deleting and re-downloading once`);
      try { fs.unlinkSync(modelPath); } catch {}
      const freshPath = await ensureLlmModel((f) => opts.onProgress?.(f * 0.3));
      model = await llama.loadModel({ modelPath: freshPath });
    } else throw e;
  }
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
