"use client";

import { wasmExtract, wasmMux } from "./client";

function pickDedup(formats: any[], predicate: (f: any) => boolean) {
  const filtered = formats.filter(predicate);
  const m = new Map();
  for (const f of filtered) {
    const h = f.height || 0;
    const cur = m.get(h);
    if (!cur || (f.tbr || 0) > (cur.tbr || 0)) m.set(h, f);
  }
  return [...m.values()].sort((a, b) => (a.height || 0) - (b.height || 0));
}

function buildBestChoice(info: any) {
  const formats = info.formats || [];
  const isHttp = (f: any) => f.protocol === "https" || f.protocol === "http";
  const progressive = pickDedup(formats, (f) => !!(f.url && f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none" && isHttp(f)));
  const videoOnly = pickDedup(formats, (f) => !!(f.url && f.vcodec && f.vcodec !== "none" && (!f.acodec || f.acodec === "none") && isHttp(f)));
  const audioOnly = formats
    .filter((f: any) => !!(f.url && f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none") && isHttp(f)))
    .sort((a: any, b: any) => (b.tbr || 0) - (a.tbr || 0))[0] || null;
  if (audioOnly && videoOnly.length) {
    // pick best quality video (highest height) for smooth default
    const bestV = [...videoOnly].sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    return { kind: "dash" as const, videoUrl: bestV.url, audioUrl: audioOnly.url };
  }
  if (progressive.length) {
    const best = [...progressive].sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    return { kind: "single" as const, url: best.url, mime: best.ext === "webm" ? "video/webm" : "video/mp4" };
  }
  if (audioOnly) return { kind: "single" as const, url: audioOnly.url, mime: "audio/mp4" };
  return null;
}

async function fetchBytes(url: string, onProgress?: (pct: number | null) => void): Promise<Uint8Array> {
  const res = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !total) {
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      onProgress?.(Math.round((received / total) * 100));
    }
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export type ProgressPhase = "extracting" | "downloading" | "processing" | "uploading";

export async function downloadViaWasm(
  url: string,
  onPhase: (phase: ProgressPhase, pct?: number | null) => void
): Promise<{ blob: Blob; title: string }> {
  onPhase("extracting");
  const info = await wasmExtract(url);
  if (!info || !info.formats) throw new Error("No formats");
  const title: string = info.title || "video";
  const choice: any = buildBestChoice(info);
  if (!choice) throw new Error("No playable format");
  onPhase("downloading", 0);
  let blob: Blob;
  if (choice.kind === "single") {
    const bytes = await fetchBytes(choice.url, (p) => onPhase("downloading", p));
    blob = new Blob([bytes as any], { type: choice.mime || "video/mp4" });
  } else {
    const videoBytes = await fetchBytes(choice.videoUrl, (p) => onPhase("downloading", p ? Math.round(p * 0.5) : null));
    const audioBytes = await fetchBytes(choice.audioUrl, (p) => onPhase("downloading", p ? 50 + Math.round(p * 0.5) : null));
    onPhase("processing");
    const muxed = await wasmMux(videoBytes, audioBytes);
    blob = new Blob([muxed as any], { type: "video/mp4" });
  }
  return { blob, title };
}
