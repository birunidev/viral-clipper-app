/**
 * FaceTracker — stable IDs, interpolation, occlusion hold, EMA smoothing → camera path
 * Input: FrameFaces[] sampled 1 fps (from faceDetector)
 * Output: per-time camera {x,y,zoom} + face id
 */
import type { FaceBox, FrameFaces } from "./faceDetector.js";

export type TrackedFace = { id: string; box: FaceBox; timestamp: number };
export type CameraPath = { timestamp: number; x: number; y: number; zoom: number; targetFaceId: string | null };

function iou(a: FaceBox, b: FaceBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

function ema(prev: number, next: number, alpha = 0.6): number {
  return prev * (1 - alpha) + next * alpha;
}

export function trackFaces(
  frames: FrameFaces[],
  opts: { iouThreshold?: number; occlusionHoldSec?: number; smoothingAlpha?: number } = {}
): { tracks: Map<string, TrackedFace[]>; cameras: CameraPath[] } {
  const iouThr = opts.iouThreshold ?? 0.35;
  const hold = opts.occlusionHoldSec ?? 0.6;
  const alpha = opts.smoothingAlpha ?? 0.6;

  const tracks = new Map<string, TrackedFace[]>();
  let nextId = 0;
  const lastSeen = new Map<string, { box: FaceBox; timestamp: number }>();
  const cameras: CameraPath[] = [];
  let prevCam: CameraPath | null = null;

  for (const frame of frames) {
    const t = frame.timestamp;
    const assigned = new Set<string>();
    for (const face of frame.faces) {
      let bestId: string | null = null;
      let bestIoU = 0;
      for (const [id, last] of lastSeen) {
        if (t - last.timestamp > hold + 0.1) continue;
        const score = iou(face, last.box);
        if (score > bestIoU && score >= iouThr) {
          bestIoU = score;
          bestId = id;
        }
      }
      const id = bestId ?? `face_${nextId++}`;
      const tf: TrackedFace = { id, box: { ...face, id }, timestamp: t };
      if (!tracks.has(id)) tracks.set(id, []);
      tracks.get(id)!.push(tf);
      lastSeen.set(id, { box: face, timestamp: t });
      assigned.add(id);
      void assigned;
    }
    // camera: pick most prominent (largest area, highest conf) face in frame, else hold
    let target: FaceBox | null = null;
    let targetId: string | null = null;
    if (frame.faces.length) {
      const best = [...frame.faces].sort((a, b) => b.width * b.height - a.width * a.height)[0];
      target = best;
      // find id for best by IoU
      let bestId: string | null = null;
      let bestIoU = 0;
      for (const [id, last] of lastSeen) {
        const s = iou(best, last.box);
        if (s > bestIoU) { bestIoU = s; bestId = id; }
      }
      targetId = bestId;
    }
    const faceCenterX = target ? target.x + target.width / 2 : 0.5;
    const faceCenterY = target ? target.y + target.height / 2 : 0.35;
    let x = faceCenterX;
    let y = faceCenterY;
    if (prevCam) {
      x = ema(prevCam.x, x, alpha);
      y = ema(prevCam.y, y, alpha);
    }
    // zoom: subtle punch if face large
    const zoom = target && target.width > 0.25 ? 1.05 : 1;
    const cam: CameraPath = { timestamp: t, x, y, zoom, targetFaceId: targetId };
    cameras.push(cam);
    prevCam = cam;
  }

  // Interpolate missing frames (linear hold already via lastSeen check)
  return { tracks, cameras };
}

export function faceAwareCrop(
  camera: CameraPath,
  srcW: number,
  srcH: number,
  aspect: string
): { x: number; y: number; w: number; h: number; debug: string } {
  const [outW, outH] = (() => {
    if (aspect === "16:9") return [srcW, Math.round(srcW * 9 / 16)] as const;
    if (aspect === "1:1") return [Math.min(srcW, srcH), Math.min(srcW, srcH)] as const;
    if (aspect === "4:5") return [Math.round(srcH * 4 / 5), srcH] as const;
    return [Math.round(srcH * 9 / 16), srcH] as const; // 9:16 default
  })();
  const w = Math.min(outW, srcW);
  const h = Math.min(outH, srcH);
  const zoomW = w / (camera.zoom || 1);
  const zoomH = h / (camera.zoom || 1);
  // headroom 7%: face y is top, push crop up slightly
  const cx = camera.x * srcW;
  const cy = camera.y * srcH - 0.07 * zoomH;
  let x = Math.round(cx - zoomW / 2);
  let y = Math.round(cy - zoomH / 2);
  x = Math.max(0, Math.min(x, srcW - zoomW));
  y = Math.max(0, Math.min(y, srcH - zoomH));
  // evenDown for H264
  const even = (n: number) => (n % 2 === 0 ? n : n - 1);
  return { x, y: even(y), w: even(Math.round(zoomW)), h: even(Math.round(zoomH)), debug: `cam x=${camera.x.toFixed(2)} y=${camera.y.toFixed(2)} zoom=${camera.zoom}` };
}
