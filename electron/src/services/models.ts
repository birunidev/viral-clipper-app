import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import http from "node:http";
import { llmModelForVariant, whisperModelForTier, ramTier } from "./system.js";

function userDataRoot(): string {
  if (process.env.USER_DATA_PATH) return process.env.USER_DATA_PATH;
  try {
    const { app } = require("electron") as { app: { getPath: (n: string) => string } };
    return app.getPath("userData");
  } catch { return path.join(process.cwd(), ".data"); }
}

export type ModelVariant = "tiny" | "balanced" | "quality";
export type WhisperModel = "base" | "small" | "medium" | "large-v3";

export interface VariantInfo {
  key: ModelVariant;
  label: string;
  file: string;
  url: string;
  sizeMb: number;
  installed: boolean;
  path: string;
  bytesOnDisk: number;
  description: string;
}

const VARIANTS: Record<ModelVariant, { label: string; sizeMb: number; description: string }> = {
  tiny: { label: "Tiny — 0.5B", sizeMb: 380, description: "380 MB · fastest · weakest hooks, generic JSON" },
  balanced: { label: "Balanced — 1.5B (recommended)", sizeMb: 950, description: "950 MB · best MB/quality · <2 GB installer" },
  quality: { label: "Quality — 3B", sizeMb: 2000, description: "2.0 GB · better nuance · needs 3 GB RAM" },
};

export function getVariantInfo(v: ModelVariant): VariantInfo {
  const meta = VARIANTS[v];
  const { file, url } = llmModelForVariant(v);
  const full = path.join(userDataRoot(), "models", "llm", file);
  let bytes = 0;
  try { if (fs.existsSync(full)) bytes = fs.statSync(full).size; } catch {}
  return {
    key: v,
    label: meta.label,
    file, url,
    sizeMb: meta.sizeMb,
    installed: bytes > 1024 * 1024,
    path: full,
    bytesOnDisk: bytes,
    description: meta.description,
  };
}

export function listVariants(): VariantInfo[] {
  return (["tiny", "balanced", "quality"] as ModelVariant[]).map(getVariantInfo);
}

export function currentSelectedVariant(): ModelVariant {
  const env = (process.env.LLM_TIER ?? "").toLowerCase();
  if (env === "tiny" || env === "0.5b" || env === "nano") return "tiny";
  if (env === "balanced" || env === "1.5b") return "balanced";
  if (env === "quality" || env === "3b") return "quality";
  // Try electron-store
  try {
    const Store = require("electron-store") as unknown as { default: new (o: unknown)=> { get:(k:string, d?:unknown)=>unknown } };
    const Ctor = (Store.default ?? Store) as unknown as new (o: unknown)=> { get:(k:string,d?:unknown)=>unknown };
    const store = new Ctor({ name: "clipzard-config" });
    const v = String(store.get("llmVariant", "") ?? "").toLowerCase();
    if (v === "tiny" || v === "balanced" || v === "quality") return v as ModelVariant;
  } catch {}
  // Default based on tier (low=balanced, mid/high keep larger but UI defaults to balanced)
  const tier = ramTier();
  if (tier === "high" || tier === "mid") return "balanced"; // don't default to tiny even on high
  return "balanced";
}

export function whisperStatus(): { tier: string; model: string; installed: boolean; path: string; bytesOnDisk: number } {
  const tier = ramTier();
  const model = whisperModelForTier(tier as unknown as Parameters<typeof whisperModelForTier>[0]);
  const p = path.join(userDataRoot(), "models", "whisper", `ggml-${model}.bin`);
  let bytes = 0;
  try { if (fs.existsSync(p)) bytes = fs.statSync(p).size; } catch {}
  return { tier, model, installed: bytes > 1024 * 1024, path: p, bytesOnDisk: bytes };
}

let activeDownload: { variant: ModelVariant; controller?: AbortController } | null = null;

export async function ensureVariant(v: ModelVariant, onProgress?: (p: number) => void): Promise<string> {
  const info = getVariantInfo(v);
  if (info.installed) return info.path;
  if (activeDownload) throw new Error(`Already downloading ${activeDownload.variant}`);
  activeDownload = { variant: v };
  try {
    await downloadFile(info.url, info.path, onProgress);
    return info.path;
  } finally {
    activeDownload = null;
  }
}

export async function removeVariant(v: ModelVariant): Promise<void> {
  const info = getVariantInfo(v);
  if (fs.existsSync(info.path)) fs.unlinkSync(info.path);
}

function downloadFile(url: string, dest: string, onProgress?: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) return resolve();
    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    let total = 0, done = 0;
    const req = proto.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        downloadFile(res.headers.location!, dest, onProgress).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      total = parseInt(res.headers["content-length"] ?? "0", 10);
      res.on("data", (c: Buffer) => {
        done += c.length;
        if (onProgress && total) onProgress(done / total);
      });
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
      file.on("error", reject);
    });
    req.on("error", (e) => { try { file.close(); fs.unlinkSync(dest); } catch {} reject(e); });
  });
}
