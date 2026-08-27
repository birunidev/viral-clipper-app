"use client";

export function getSupportedMimeType(): string {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=h264,opus",
    "video/webm",
    "video/mp4",
  ];
  for (const t of candidates) {
    try {
      if ((window as any).MediaRecorder?.isTypeSupported?.(t)) return t;
    } catch {}
  }
  return "video/webm";
}

export type RecorderController = {
  recorder: MediaRecorder;
  mimeType: string;
  stop: () => void;
};

export function createRecorder(
  stream: MediaStream,
  onChunk: (blob: Blob) => void,
  opts?: { mimeType?: string; timesliceMs?: number; videoBitsPerSecond?: number }
): RecorderController {
  const mimeType = opts?.mimeType || getSupportedMimeType();
  const timeslice = opts?.timesliceMs ?? 1000;
  const rec = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: opts?.videoBitsPerSecond ?? 5_000_000,
  } as any);
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) onChunk(e.data);
  };
  // start with timeslice for incremental blobs
  rec.start(timeslice);
  return {
    recorder: rec,
    mimeType,
    stop: () => {
      try { if (rec.state !== "inactive") rec.stop(); } catch {}
    },
  };
}
