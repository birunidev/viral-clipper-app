/**
 * SilenceDetector — VAD/dead-air via ffmpeg silencedetect.
 * Spec Feature 6: {start:42.1,end:44.4,duration:2.3,type:"silence"} + tightness thresholds
 * <300 keep, 300-800 usually keep, 800-1500 candidate, >1500 strong.
 */
import { spawnSync } from "node:child_process";
import { ffmpegPath } from "./bin.js";

export type Silence = { start: number; end: number; duration: number; type: "silence"; tightness: "keep" | "usually_keep" | "candidate" | "strong" };

function classify(durationMs: number): Silence["tightness"] {
  const sec = durationMs / 1000;
  if (sec < 0.3) return "keep";
  if (sec < 0.8) return "usually_keep";
  if (sec < 1.5) return "candidate";
  return "strong";
}

export function detectSilences(src: string, noise = "-30dB", minDur = 0.3): Silence[] {
  try {
    const r = spawnSync(ffmpegPath(), [
      "-hide_banner",
      "-i",
      src,
      "-af",
      `silencedetect=noise=${noise}:d=${minDur}`,
      "-f",
      "null",
      "-",
    ], { encoding: "utf8", timeout: 30000 });
    const log = String(r.stderr ?? "") + String(r.stdout ?? "");
    const starts: number[] = [];
    const out: Silence[] = [];
    const startRe = /silence_start:\s*([0-9.]+)/g;
    const endRe = /silence_end:\s*([0-9.]+).*?silence_duration:\s*([0-9.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = startRe.exec(log)) !== null) starts.push(Number(m[1]));
    let startIdx = 0;
    while ((m = endRe.exec(log)) !== null) {
      const end = Number(m[1]);
      const dur = Number(m[2]);
      const start = starts[startIdx++] ?? end - dur;
      const tightness = classify(dur * 1000);
      out.push({ start, end, duration: dur, type: "silence", tightness });
    }
    return out.sort((a, b) => a.start - b.start);
  } catch {
    return [];
  }
}

export function silencesToRemovals(silences: Silence[], tightnessMode: "natural" | "social" | "aggressive" = "social"): { start: number; end: number; type: "dead_air" }[] {
  return silences
    .filter((s) => {
      if (tightnessMode === "natural") return s.tightness === "strong";
      if (tightnessMode === "social") return s.tightness === "candidate" || s.tightness === "strong";
      return s.tightness !== "keep"; // aggressive: all except <300
    })
    .map((s) => ({ start: s.start, end: s.end, type: "dead_air" as const }));
}
