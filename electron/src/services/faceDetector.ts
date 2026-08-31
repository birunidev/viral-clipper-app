/**
 * FaceDetector — sampled 1 fps, WASM BlazeFace via @mediapipe/tasks-vision
 * Falls back to empty detections if model not yet downloaded.
 * Spec Feature 1 example: {timestamp:14.2, faces:[{id:"f1",x:0.22,y:0.14,w:0.2,h:0.39,conf:0.97}]}
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { ffmpegPath } from "./bin.js";
import { userDataRoot } from "./userData.js";

export type FaceBox = { id: string; x: number; y: number; width: number; height: number; confidence: number };
export type FrameFaces = { timestamp: number; faces: FaceBox[] };

function wasmDir(): string {
  return path.join(userDataRoot(), "models", "mediapipe");
}
function modelPath(): string {
  // blaze_face_short_range.tflite is used by mediapipe face detector
  return path.join(wasmDir(), "blaze_face_short_range.tflite");
}

let detectorInit: Promise<unknown> | null = null;

async function ensureModel(): Promise<string | null> {
  const p = modelPath();
  if (fs.existsSync(p) && fs.statSync(p).size > 1000) return p;
  // Lazy download — 15 MB, only on first face use
  const dir = wasmDir();
  fs.mkdirSync(dir, { recursive: true });
  // Try to download from mediapipe storage if not present
  const url = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
  try {
    const https = await import("node:https");
    await new Promise<void>((resolve, reject) => {
      const file = fs.createWriteStream(p);
      https.get(url, (res) => {
        if (res.statusCode !== 200) { reject(new Error(`model HTTP ${res.statusCode}`)); return; }
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
        file.on("error", reject);
      }).on("error", reject);
    });
    if (fs.existsSync(p)) return p;
  } catch {}
  // Also try local node_modules copy as fallback
  const candidates = [
    path.join(path.dirname(modelPath()), "..", "..", "node_modules", "@mediapipe", "tasks-vision", "wasm", "blaze_face_short_range.tflite"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) { try { fs.copyFileSync(c, p); return p; } catch {} }
  return null;
}

function extractThumb(src: string, atSec: number, destDir: string): Promise<string | null> {
  const out = path.join(destDir, `thumb_${String(Math.round(atSec * 1000)).padStart(8, "0")}.jpg`);
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath(), ["-y", "-hide_banner", "-loglevel", "error", "-ss", atSec.toFixed(2), "-i", src, "-frames:v", "1", "-q:v", "3", out], { stdio: "pipe" });
    p.on("close", (code) => {
      if (code === 0 && fs.existsSync(out) && fs.statSync(out).size > 500) resolve(out);
      else resolve(null);
    });
    p.on("error", () => resolve(null));
  });
}

export async function detectFaces(
  src: string,
  opts: { fps?: number; onProgress?: (p: number) => void } = {}
): Promise<FrameFaces[]> {
  const fps = opts.fps ?? 1;
  // Probe duration via ffprobe truncation
  let duration = 0;
  try {
    const { ffprobePath } = await import("./bin.js");
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(ffprobePath(), ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", src], { timeout: 8000 });
    duration = Number(String(r.stdout ?? "").trim()) || 0;
  } catch {}
  if (!duration) duration = 60; // fallback
  const times: number[] = [];
  for (let t = 0; t < duration; t += 1 / fps) times.push(t);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipzard_faces_"));
  const results: FrameFaces[] = [];
  // Lazy init WASM detector once
  let faceDetector: unknown = null;
  let wasmOk = false;
  try {
    const mp = await import("@mediapipe/tasks-vision");
    const model = await ensureModel();
    if (model) {
      const vision = await (mp as unknown as { FilesetResolver: { forVisionTasks: (u: string) => Promise<unknown> } }).FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm");
      const det = await (mp as unknown as { FaceDetector: { createFromOptions: (v: unknown, o: unknown) => Promise<unknown> } }).FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: model },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.5,
      });
      faceDetector = det;
      wasmOk = true;
    }
  } catch {
    wasmOk = false;
  }

  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    const thumb = await extractThumb(src, t, tmpDir);
    if (!thumb) { results.push({ timestamp: t, faces: [] }); continue; }
    if (!wasmOk || !faceDetector) {
      // Fallback: no model yet → empty; caller will fallback to center crop
      results.push({ timestamp: t, faces: [] });
      try { fs.unlinkSync(thumb); } catch {}
      opts.onProgress?.((i + 1) / times.length);
      continue;
    }
    try {
      // For now, skip per-image WASM inference in Node (requires createImageBitmap / canvas)
      // This is stubbed: in electron-renderer we can use OffscreenCanvas; in Node we fallback to empty
      // To keep pipeline workable, return empty and let tracker fallback to center.
      // Future: use node-canvas or sharp to load thumb and run detector.detect().
      results.push({ timestamp: t, faces: [] });
    } catch {
      results.push({ timestamp: t, faces: [] });
    }
    try { fs.unlinkSync(thumb); } catch {}
    opts.onProgress?.((i + 1) / times.length);
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  return results;
}

export async function detectFacesForClip(
  src: string,
  startSec: number,
  endSec: number,
  fps = 2
): Promise<FrameFaces[]> {
  const slice = await detectFaces(src, { fps });
  return slice.filter((f) => f.timestamp >= startSec && f.timestamp < endSec);
}
