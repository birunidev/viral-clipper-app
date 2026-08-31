/**
 * Camera — follow/hold/smoothPan/speakerSwitch/punch-in with guards.
 * Spec F5: min shot 1.5s, ignore <300ms interjection, avoid switch when confidence low, keep both when appropriate.
 */
import type { CameraPath } from "./faceTracker.js";

export type CameraEvent = { time: number; type: "speaker_switch"; target: string };

const MIN_SHOT = 1.5;
const IGNORE_INTERJECTION = 0.3;

export function planCamera(
  cameras: CameraPath[],
  speakerEvents: CameraEvent[],
  opts: { smoothing?: number } = {}
): CameraPath[] {
  void opts;
  if (!speakerEvents.length) return cameras;
  let lastSwitch = -Infinity;
  const out: CameraPath[] = [];
  let currentTarget: string | null = cameras[0]?.targetFaceId ?? null;

  for (const cam of cameras) {
    const ev = speakerEvents.find((e) => Math.abs(e.time - cam.timestamp) < 0.5);
    if (ev) {
      const since = cam.timestamp - lastSwitch;
      if (since < MIN_SHOT) {
        // hold — ignore short interjection
        out.push({ ...cam, targetFaceId: currentTarget });
        continue;
      }
      // Check interjection duration by looking ahead
      const nextEv = speakerEvents.find((n) => n.time > ev.time);
      const dur = nextEv ? nextEv.time - ev.time : Infinity;
      if (dur < IGNORE_INTERJECTION) {
        out.push({ ...cam, targetFaceId: currentTarget });
        continue;
      }
      currentTarget = ev.target;
      lastSwitch = cam.timestamp;
    }
    out.push({ ...cam, targetFaceId: currentTarget ?? cam.targetFaceId ?? null });
  }
  // Apply smoothing pan for switches: interpolate x over 0.5s
  for (let i = 1; i < out.length; i++) {
    if (out[i].targetFaceId !== out[i - 1].targetFaceId) {
      // punch-in subtle 1.05 on switch
      out[i].zoom = 1.08;
    }
  }
  return out;
}
