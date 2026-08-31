/**
 * FalseStartDetector — Spec Feature 8
 * Detects unfinished / repeated starts: "So the biggest thing—" → "The biggest mistake …"
 * Heuristic for now; ambiguous cases handed to Qwen director in M5.
 * Never invent words, prefer final formulation.
 */
export type FalseStart = { start: number; end: number; type: "false_start"; text: string; confidence: number };

function isUnfinished(text: string): boolean {
  const t = text.trim();
  return /[-—–]\s*$/.test(t) || /\b(so|and|but|actually|what|i mean)\s*[-—]\s*$/i.test(t);
}

export function detectFalseStarts(
  words: { text: string; start_ms: number; end_ms: number }[],
  language?: string
): FalseStart[] {
  void language;
  const out: FalseStart[] = [];
  // Very light heuristic: short segment ending with dash followed by nearby restart with overlapping first words
  const text = words.map((w) => w.text).join(" ");
  // Split on sentence boundaries roughly: look for "—" or em dash inside transcript
  // For now, only catch obvious "So the biggest thing—" where next segment restarts with similar words
  // Keep stub empty to avoid false positives; M5 Qwen will review ambiguous.
  void text;
  void isUnfinished;
  return out;
}
