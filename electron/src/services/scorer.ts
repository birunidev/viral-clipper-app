// LOCKED: Lightweight rule-based viral scorer — Clipyr-inspired, multilingual, no LLM / no API
// Hook FINDING is locked (scoring/ranking) — do not change without user approval
// Used as always-ensemble with Qwen 7b (0.7*LLM + 0.3*rule) while Qwen3-4B trains
import { LANGUAGE_NAMES, normalizeLang } from "./analyzer.js";

export type AudioFeatures = {
  tempo?: number;
  energyVariance?: number;
};

const VIRAL_KEYWORDS: Record<string, string[]> = {
  en: ["wow","amazing","incredible","unbelievable","shocking","surprise","secret","trick","hack","tip","mistake","fail","success","breakthrough","discovery","reveal","expose","truth","lie","before","after","transformation","change","upgrade","improve","money","rich","poor","expensive","cheap","free","save","love","hate","angry","happy","sad","funny","laugh","cry","first time","last time","never","always","everyone","nobody","finally","suddenly","immediately","instantly","quickly"],
  id: ["wah","luar biasa","tidak terduga","mengejutkan","kejutan","rahasia","trik","tip","kesalahan","gagal","sukses","terobosan","penemuan","ungkap","kebenaran","bohong","sebelum","sesudah","perubahan","upgrade","uang","kaya","miskin","mahal","murah","gratis","hemat","cinta","benci","marah","senang","sedih","lucu","tertawa","menangis","pertama kali","terakhir kali","tidak pernah","selalu","semua orang","tidak ada","akhirnya","tiba-tiba","segera","cepat"],
  ms: ["wah","luar biasa","rahsia","trik","wang","kaya","miskin","cinta","benci","marah","gembira","sedih","lucu"],
  es: ["wow","increíble","secreto","truco","dinero","rico","pobre","amor","odio","enojado","feliz","triste","gracioso","nunca","siempre","todos","nadie","finalmente","de repente"],
  pt: ["uau","incrível","segredo","truque","dinheiro","rico","pobre","amor","ódio","feliz","triste","engraçado","nunca","sempre","todos","ninguém"],
  fr: ["wow","incroyable","secret","astuce","argent","riche","pauvre","amour","haine","heureux","triste","drôle","jamais","toujours","tout le monde","personne"],
  de: ["wow","unglaublich","geheimnis","trick","geld","reich","arm","liebe","hass","glücklich","traurig","lustig","nie","immer","jeder","niemand"],
  ja: ["すごい","信じられない","秘密","コツ","お金","金持ち","貧乏","愛","嫌い","嬉しい","悲しい","面白い","初めて","最後","いつも","誰も","ついに","突然"],
  ko: ["와","놀라운","비밀","팁","돈","부자","가난한","사랑","미움","행복한","슬픈","웃긴","처음","마지막","항상","아무도","마침내","갑자기"],
  zh: ["哇","惊人","秘密","技巧","钱","有钱","穷","爱","恨","开心","难过","好笑","第一次","最后","从不","总是","每个人","没有人","终于","突然"],
  // fallback for others uses en
};

const HOOK_PATTERNS: Record<string, string[]> = {
  en: ["you won't believe","this will change","nobody talks about","the truth about","what happens when","here's what","this is why","the secret","watch this","wait for it"],
  id: ["kamu tidak akan percaya","ini akan mengubah","tidak ada yang membicarakan","kebenaran tentang","apa yang terjadi ketika","inilah mengapa","rahasia","tonton ini","tunggu dulu","inilah yang"],
  ms: ["anda tidak akan percaya","ini akan mengubah","rahsia","kebenaran tentang"],
  es: ["no vas a creer","esto cambiará","nadie habla de","la verdad sobre","lo que pasa cuando"],
  pt: ["você não vai acreditar","isso vai mudar","ninguém fala sobre","a verdade sobre"],
  fr: ["vous n'allez pas croire","cela va changer","personne ne parle de","la vérité sur"],
  de: ["du wirst nicht glauben","das wird ändern","niemand spricht über","die wahrheit über"],
  ja: ["信じられない","これが変わる","誰も語らない","真実"],
  ko: ["믿지 못할","이것이 바꿀","아무도 말하지 않는","진실"],
  zh: ["你不会相信","这将改变","没有人谈论","真相"],
};

function getKeywords(lang: string | null): string[] {
  if (!lang) return VIRAL_KEYWORDS.en;
  return VIRAL_KEYWORDS[lang] ?? VIRAL_KEYWORDS[lang.split("-")[0]] ?? VIRAL_KEYWORDS.en;
}
function getHooks(lang: string | null): string[] {
  if (!lang) return HOOK_PATTERNS.en;
  return HOOK_PATTERNS[lang] ?? HOOK_PATTERNS[lang.split("-")[0]] ?? HOOK_PATTERNS.en;
}

export function scoreSegment(text: string, lang?: string | null, audio?: AudioFeatures, durationSec?: number): number {
  const norm = normalizeLang(lang ?? null) ?? "en";
  const lower = text.toLowerCase();
  let score = 0;

  // viral keywords +1 each
  for (const kw of getKeywords(norm)) if (lower.includes(kw)) score += 1;
  // hook patterns +3 each
  for (const pat of getHooks(norm)) if (lower.includes(pat)) score += 3;

  // audio (if available)
  if (audio?.tempo && audio.tempo > 120) score += 1;
  if (audio?.energyVariance && audio.energyVariance > 0.01) score += 1;

  // duration sweet spot 25-65s +2, 15-90s +1
  if (durationSec != null) {
    if (durationSec >= 25 && durationSec <= 65) score += 2;
    else if (durationSec >= 15 && durationSec <= 90) score += 1;
  }
  // word count 20-100 +1
  const wc = text.split(/\s+/).filter(Boolean).length;
  if (wc >= 20 && wc <= 100) score += 1;

  return Math.min(score, 10);
}

export type ScoredClip = {
  start: number;
  end: number;
  text: string;
  duration: number;
  virality: number;
  language: string | null;
};

export function findBestMoments(
  words: { text: string; start_ms: number; end_ms: number }[],
  language?: string | null,
  audio?: AudioFeatures,
  opts: { targetDuration?: number; maxClips?: number } = {}
): ScoredClip[] {
  const target = opts.targetDuration ?? 30;
  const maxClips = opts.maxClips ?? 5;
  if (!words.length) return [];

  // Build 30s blocks like analyzer.ts for grouping, but score per window
  // Group words into segments of ~target seconds by walk
  const segments: { start: number; end: number; text: string }[] = [];
  let buf: string[] = [];
  let segStart: number | null = null;
  let segEnd = 0;
  for (const w of words) {
    const s = w.start_ms / 1000, e = w.end_ms / 1000;
    if (segStart == null) segStart = s;
    buf.push(w.text);
    segEnd = e;
    if (segEnd - (segStart ?? 0) >= 8) { // 8s micro-segments for flexible grouping
      segments.push({ start: segStart ?? 0, end: segEnd, text: buf.join(" ") });
      buf = []; segStart = null;
    }
  }
  if (buf.length) segments.push({ start: segStart ?? 0, end: segEnd, text: buf.join(" ") });

  const scored: ScoredClip[] = [];
  for (let i = 0; i < segments.length; i++) {
    let combined = segments[i].text;
    let start = segments[i].start;
    let end = segments[i].end;
    let dur = end - start;
    let j = i + 1;
    while (j < segments.length && dur < target) {
      if (segments[j].end - start <= target * 1.5) {
        combined += " " + segments[j].text;
        end = segments[j].end;
        dur = end - start;
        j++;
      } else break;
    }
    const virality = scoreSegment(combined, language, audio, dur);
    scored.push({ start, end, text: combined, duration: dur, virality, language: language ?? null });
  }

  // sort by virality, dedupe overlaps, top N
  scored.sort((a, b) => b.virality - a.virality);
  const out: ScoredClip[] = [];
  for (const c of scored) {
    let overlap = false;
    for (const ex of out) if (c.start < ex.end && c.end > ex.start) { overlap = true; break; }
    if (!overlap) {
      out.push(c);
      if (out.length >= maxClips) break;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function ensembleScore(llmScores: { start: number; end: number; title: string; hook?: string }[], ruleClips: ScoredClip[] | { start: number; end: number; title?: string; hook?: string; text?: string; duration?: number; virality?: number; language?: string | null }[]): { title: string; hook?: string; start: number; end: number }[] {
  if (!llmScores.length) {
    // fallback to rule only — generate titles from rule text
    return ruleClips.map((r: any, i: number) => ({
      title: (r.text ?? `Viral ${r.language ?? "en"} Moment ${i+1}`).split(/\s+/).slice(0, 6).join(" ").slice(0, 40) || `Viral ${r.language ?? "en"} Moment ${i+1}`,
      hook: (r.text ?? "").slice(0, 80),
      start: r.start,
      end: r.end,
    }));
  }
  if (!ruleClips.length) return llmScores;

  // Always ensemble: 0.7*LLM rank + 0.3*rule overlap boost
  // Boost LLM clips that overlap high-virality rule windows
  const boosted = llmScores.map((c) => {
    let boost = 0;
    for (const r of ruleClips as any[]) {
      const inter = Math.min(c.end, r.end) - Math.max(c.start, r.start);
      if (inter > 0) boost = Math.max(boost, ((r.virality ?? 5) / 10) * 0.3);
    }
    return { ...c, _boost: boost };
  });
  // Keep original order but slightly promote boosted; stable sort by boost
  boosted.sort((a: any, b: any) => (b._boost - a._boost));
  return boosted.map(({ _boost, ...rest }: any) => rest);
}
