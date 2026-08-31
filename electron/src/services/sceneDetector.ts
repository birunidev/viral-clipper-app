/**
 * SceneDetector — uses ffmpeg lavfi select='gt(scene,0.4)' to emit cut times.
 * Falls back to empty (no cuts) if ffprobe unavailable.
 */
import { spawnSync } from "node:child_process";
import { ffmpegPath } from "./bin.js";

export type SceneCut = { time: number; confidence: number };

export function detectScenes(src: string, threshold = 0.4): SceneCut[] {
  try {
    // Use ffmpeg with -filter:v "select='gt(scene,0.4)',showinfo" and parse stderr
    const r = spawnSync(ffmpegPath(), [
      "-hide_banner",
      "-loglevel",
      "info",
      "-i",
      src,
      "-filter:v",
      `select='gt(scene,${threshold})',showinfo`,
      "-f",
      "null",
      "-",
    ], { timeout: 30000, encoding: "utf8" });
    const log = String(r.stderr ?? "") + String(r.stdout ?? "");
    const cuts: SceneCut[] = [];
    // showinfo line: ... n:12 pts_time:3.42 ...
    const re = /pts_time:([0-9.]+)/g;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((m = re.exec(log)) !== null) {
      const t = Number(m[1]);
      const key = t.toFixed(2);
      if (!seen.has(key) && Number.isFinite(t)) { seen.add(key); cuts.push({ time: t, confidence: threshold }); }
    }
    cuts.sort((a, b) => a.time - b.time);
    return cuts;
  } catch {
    return [];
  }
}
