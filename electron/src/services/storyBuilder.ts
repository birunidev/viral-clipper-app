/**
 * StoryBuilder — non-contiguous Hook→Payoff stitching (spec F12)
 * Flag-gated via editPlan.output.story, default off.
 * When off → single segment contiguous. When on → allow 2-4 segments concatenated with TimelineMapper sync.
 */
export type StorySegment = { start: number; end: number; label: string };

export function buildStory(
  segments: { start: number; end: number; title?: string }[],
  enableStory: boolean
): { start: number; end: number }[] {
  if (!enableStory) {
    return segments.map((s) => ({ start: s.start, end: s.end }));
  }
  // Simple stitch: Hook 08:21 + Conflict 12:42 etc — for now just return as-is concatenated
  // Real Qwen story selection would pick semantically consistent non-contiguous moments
  // Here we just preserve order and let cutter concat with TimelineMapper
  return segments.map((s) => ({ start: s.start, end: s.end }));
}
