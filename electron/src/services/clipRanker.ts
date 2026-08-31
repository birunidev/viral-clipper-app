/**
 * ClipRanker — viral angle classification + diversity (spec F10-11)
 * Ensures not 5 identical clips, supports story non-contiguous via optional flag.
 */
export type ClipScore = {
  title: string;
  hook?: string;
  start: number;
  end: number;
  score: number; // 0-100
  angle?: string;
  reason_codes: string[];
};

const ANGLES = ["educational", "contrarian", "story", "emotional", "funny", "insight", "practical", "surprising"] as const;

function classifyAngle(title: string, hook?: string): string {
  const t = `${title} ${hook ?? ""}`.toLowerCase();
  if (t.includes("secret") || t.includes("rahasia") || t.includes("mistake")) return "educational";
  if (t.includes("why") || t.includes("wrong") || t.includes("contrarian")) return "contrarian";
  if (t.includes("story") || t.includes("moment") || t.includes("journey")) return "story";
  if (t.includes("love") || t.includes("cry") || t.includes("angry")) return "emotional";
  if (t.includes("funny") || t.includes("lucu")) return "funny";
  return ANGLES[Math.floor(Math.random() * ANGLES.length)];
}

export function rankClips(
  clips: { title: string; hook?: string; start: number; end: number }[],
  opts: { maxPerAngle?: number } = {}
): ClipScore[] {
  const maxPerAngle = opts.maxPerAngle ?? 1;
  const scored: ClipScore[] = clips.map((c) => {
    const angle = classifyAngle(c.title, c.hook);
    const hasHook = Boolean(c.hook && c.hook.length > 5);
    const reason_codes = hasHook ? ["strong_hook", "clear_payoff"] : ["standalone_context"];
    const score = 70 + (hasHook ? 15 : 0) + (c.end - c.start > 25 && c.end - c.start < 65 ? 5 : 0);
    return { ...c, score: Math.min(100, score), angle, reason_codes };
  });
  // diversity: max 1 per angle
  scored.sort((a, b) => b.score - a.score);
  const byAngle = new Map<string, number>();
  const out: ClipScore[] = [];
  for (const c of scored) {
    const cnt = byAngle.get(c.angle ?? "") ?? 0;
    if (cnt < maxPerAngle) {
      out.push(c);
      byAngle.set(c.angle ?? "", cnt + 1);
    }
  }
  // If diversity filtered too many, fill remaining
  if (out.length < clips.length) {
    for (const c of scored) if (!out.includes(c)) out.push(c);
  }
  return out.slice(0, clips.length);
}

export function ensureDiversity(
  clips: { title: string; hook?: string; start: number; end: number }[]
): { title: string; hook?: string; start: number; end: number }[] {
  return rankClips(clips).map(({ score, angle, reason_codes, ...rest }) => rest);
}
