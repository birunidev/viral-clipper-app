/**
 * VideoAnalysis — facade for cached deterministic analysis (faces/scenes/silences/fillers).
 * Electron only, local. Cache at userData/analysis-cache/{projectId}.json
 * and/or sqlite analysis_cache table (project_id PK).
 * Changing aspect/tightness reuses cache; new upload invalidates.
 */
import fs from "node:fs";
import path from "node:path";
import { userDataRoot } from "./userData.js";

type FacesJson = unknown;
type ScenesJson = unknown;

export type AnalysisCache = {
  projectId: string;
  sourceDuration?: number;
  srcW?: number;
  srcH?: number;
  faces?: FacesJson;
  scenes?: ScenesJson;
  silences?: { start: number; end: number; duration: number; type: string }[];
  fillers?: { start: number; end: number; text: string; confidence: number }[];
  createdAt: string;
  version: 1;
};

function cacheDir(): string {
  const d = path.join(userDataRoot(), "analysis-cache");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function cachePath(projectId: string): string {
  return path.join(cacheDir(), `${projectId}.json`);
}

export function loadAnalysisCache(projectId: string): AnalysisCache | null {
  const p = cachePath(projectId);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    return raw as AnalysisCache;
  } catch {
    return null;
  }
}

export function saveAnalysisCache(projectId: string, data: Partial<AnalysisCache>): AnalysisCache {
  const existing = loadAnalysisCache(projectId);
  const base = {
    projectId,
    createdAt: new Date().toISOString(),
    version: 1 as const,
    ...(existing ?? {}),
    ...data,
  } as AnalysisCache;
  const merged: AnalysisCache = { ...base, projectId };
  fs.writeFileSync(cachePath(projectId), JSON.stringify(merged, null, 2), "utf-8");
  return merged;
}

export function invalidateAnalysisCache(projectId: string): void {
  const p = cachePath(projectId);
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

// Orchestrator — wires face + scene + silence/filler detectors, cached per project.
export async function analyzeSource(
  sourcePath: string,
  words?: { start_ms: number; end_ms: number; text: string }[],
  opts: { projectId?: string; tightness?: "natural" | "social" | "aggressive" } = {}
): Promise<AnalysisCache> {
  const projectId = opts.projectId ?? sourcePath;
  const cached = loadAnalysisCache(projectId);
  if (cached?.faces && cached?.scenes && cached?.silences && cached?.fillers) return cached;
  const { detectFaces } = await import("./faceDetector.js");
  const { detectScenes } = await import("./sceneDetector.js");
  const { detectSilences } = await import("./silenceDetector.js");
  const { detectFillers } = await import("./fillerDetector.js");
  const faces = await detectFaces(sourcePath, { fps: 1 }).catch(() => []);
  const scenes = detectScenes(sourcePath, 0.4);
  const silences = detectSilences(sourcePath);
  const fillers = words ? detectFillers(words) : [];
  return saveAnalysisCache(projectId, { faces: faces as FacesJson, scenes: scenes as ScenesJson, silences, fillers, sourceDuration: undefined, version: 1, projectId, createdAt: new Date().toISOString() });
}
