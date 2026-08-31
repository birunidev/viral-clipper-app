/**
 * FillerDetector — Spec Feature 7, EN + ID
 * lexicons: EN [um, uh, erm, you know, basically, I mean, kind of, sort of]
 *           ID [eee, eh, anu, apa namanya, kayak, gitu, maksudnya, sebenernya]
 * Uses word timestamps, confidence 0.96 for single token, lower for phrases.
 */
export type FillerCandidate = { start: number; end: number; type: "filler"; text: string; confidence: number };

const EN_FILLERS = new Set(["um", "uh", "erm", "you", "basically", "kind", "sort"]);
const EN_PHRASES: [string[], number][] = [
  [["you", "know"], 0.85],
  [["i", "mean"], 0.85],
  [["kind", "of"], 0.82],
  [["sort", "of"], 0.82],
];
const ID_FILLERS = new Set(["eee", "eh", "anu", "kayak", "gitu", "maksudnya", "sebenernya"]);
const ID_PHRASES: [string[], number][] = [
  [["apa", "namanya"], 0.85],
];

function norm(t: string): string {
  return t.toLowerCase().replace(/[^a-z]/g, "");
}

export function detectFillers(
  words: { text: string; start_ms: number; end_ms: number }[],
  opts: { lang?: string } = {}
): FillerCandidate[] {
  const out: FillerCandidate[] = [];
  const lang = (opts.lang ?? "en").toLowerCase();
  const isID = lang.startsWith("id");
  // single token
  for (const w of words) {
    const n = norm(w.text);
    if (!n) continue;
    if (!isID && EN_FILLERS.has(n)) out.push({ start: w.start_ms / 1000, end: w.end_ms / 1000, type: "filler", text: w.text, confidence: n === "um" || n === "uh" || n === "erm" ? 0.96 : 0.88 });
    if (isID && ID_FILLERS.has(n)) out.push({ start: w.start_ms / 1000, end: w.end_ms / 1000, type: "filler", text: w.text, confidence: 0.96 });
  }
  // phrases (adjacent words)
  const phrases = isID ? [...ID_PHRASES] : [...EN_PHRASES, ...ID_PHRASES.slice(0, 0)];
  // also check cross-lang phrases always for robustness
  const allPhrases = [...EN_PHRASES, ...ID_PHRASES];
  for (let i = 0; i < words.length - 1; i++) {
    const w1 = norm(words[i].text);
    const w2 = norm(words[i + 1].text);
    for (const [seq, conf] of allPhrases) {
      if (seq.length === 2 && w1 === seq[0] && w2 === seq[1]) {
        out.push({ start: words[i].start_ms / 1000, end: words[i + 1].end_ms / 1000, type: "filler", text: `${words[i].text} ${words[i + 1].text}`, confidence: conf });
      }
    }
  }
  // dedupe overlapping phrase vs single already covered
  out.sort((a, b) => a.start - b.start);
  return out;
}

export function fillersToRemovals(
  fillers: FillerCandidate[],
  tightness: "natural" | "social" | "aggressive" = "social",
  removeFiller = true
): { start: number; end: number; type: "filler"; text: string }[] {
  if (!removeFiller) return [];
  return fillers
    .filter((f) => {
      if (tightness === "natural") return f.confidence >= 0.95 && f.text.toLowerCase().trim().length <= 2; // only strong um/uh
      if (tightness === "social") return f.confidence >= 0.85;
      return true; // aggressive all
    })
    .map((f) => ({ start: f.start, end: f.end, type: "filler" as const, text: f.text }));
}
