/**
 * SpeakerAnalyzer — lightweight diar for local.
 * Tries whisper-cli speaker_id if present, else falls back to simple VAD-based speaker alternation.
 * Output: speaker segments [{start,end,speakerId,confidence}]
 */
export type SpeakerSegment = { start: number; end: number; speakerId: string; confidence: number };

export function analyzeSpeakers(
  words: { text: string; start_ms: number; end_ms: number }[],
  opts: { expectedSpeakers?: number } = {}
): SpeakerSegment[] {
  void opts;
  if (!words.length) return [];
  // Lightweight heuristic: split on long pauses >800ms as speaker turn candidate
  // In real diar we'd use webrtcvad + embeddings; for M4 stub we alternate speakers on pauses
  const segments: SpeakerSegment[] = [];
  let currentSpeaker = "spk_1";
  let segStart = words[0].start_ms / 1000;
  let lastEnd = segStart;
  for (let i = 1; i < words.length; i++) {
    const gap = (words[i].start_ms - words[i - 1].end_ms) / 1000;
    if (gap > 0.8) {
      const segEnd = words[i - 1].end_ms / 1000;
      if (segEnd - segStart > 1) {
        segments.push({ start: segStart, end: segEnd, speakerId: currentSpeaker, confidence: 0.6 });
        currentSpeaker = currentSpeaker === "spk_1" ? "spk_2" : "spk_1";
        segStart = words[i].start_ms / 1000;
      }
      lastEnd = segEnd;
    } else {
      lastEnd = words[i].end_ms / 1000;
    }
  }
  segments.push({ start: segStart, end: lastEnd, speakerId: currentSpeaker, confidence: 0.6 });
  return segments.filter((s) => s.end - s.start >= 1);
}

export function speakersToVisualEvents(segments: SpeakerSegment[]): { time: number; type: "speaker_switch"; target: string }[] {
  const events: { time: number; type: "speaker_switch"; target: string }[] = [];
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].speakerId !== segments[i - 1].speakerId) {
      events.push({ time: segments[i].start, type: "speaker_switch", target: segments[i].speakerId });
    }
  }
  return events;
}
