/**
 * ReactionDetector — reaction-aware editing (spec F15)
 * Flag-gated via editPlan.output.reaction, default off.
 * Detects reaction shot: Speaker A emotional line → hold B face 0.8s → back to A.
 */
export type ReactionShot = { time: number; duration: number; targetFaceId: string; confidence: number };

export function detectReactions(
  faces: { timestamp: number; faces: { id: string; confidence: number }[] }[],
  speakerEvents: { time: number; type: string; target: string }[],
  enableReaction: boolean
): ReactionShot[] {
  if (!enableReaction) return [];
  const out: ReactionShot[] = [];
  for (const ev of speakerEvents) {
    if (ev.type !== "speaker_switch") continue;
    const nearby = faces.find((f) => Math.abs(f.timestamp - ev.time) < 0.5);
    if (!nearby) continue;
    const confident = nearby.faces.find((f) => f.confidence > 0.85);
    if (!confident) continue;
    out.push({ time: ev.time, duration: 0.8, targetFaceId: confident.id, confidence: confident.confidence });
  }
  return out;
}
