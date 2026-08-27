import path from "node:path";
import fs from "node:fs";
import { app } from "electron";

export function projectsRoot(): string {
  const r = path.join(app.getPath("userData"), "projects");
  fs.mkdirSync(r, { recursive: true });
  return r;
}

export function projectDir(projectId: string): string {
  const d = path.join(projectsRoot(), projectId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function sourcePath(projectId: string, ext = ".mp4"): string {
  return path.join(projectDir(projectId), `source${ext}`);
}

export function clipsDir(projectId: string): string {
  const d = path.join(projectDir(projectId), "clips");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function thumbsDir(projectId: string): string {
  const d = path.join(projectDir(projectId), "thumbs");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function clipPath(projectId: string, filename: string): string {
  return path.join(clipsDir(projectId), filename);
}

export function thumbPath(projectId: string, filename: string): string {
  return path.join(thumbsDir(projectId), filename);
}

export function ensureProjectDirs(projectId: string) {
  projectDir(projectId);
  clipsDir(projectId);
  thumbsDir(projectId);
}
