import { app, BrowserWindow, ipcMain, protocol, net } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getDb, getRaw, nowIso } from "./services/db.js";
import { verifyLicense, isLicensed, getLicense } from "./services/license.js";
import { ramTier, whisperModelForTier, llmModelForTier } from "./services/system.js";
import { runAnalyze, runRender } from "./services/pipeline.js";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    backgroundColor: "#0a0a0a",
  });

  const devUrl = process.env.ELECTRON_DEV_URL;
  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    const rendererDist = path.join(__dirname, "../renderer/dist/index.html");
    const resourceRenderer = path.join(process.resourcesPath, "app.asar", "renderer/dist/index.html");
    const fallbackWeb = path.join(path.resolve("..", "web", "out", "index.html"));
    const p = [rendererDist, resourceRenderer, fallbackWeb].find((x) => fs.existsSync(x));
    if (p) win.loadFile(p);
    else win.loadURL("data:text/html,<h1>ClipForge - renderer not built. Run: npm --prefix electron/renderer run build</h1>");
  }
}

app.whenReady().then(() => {
  protocol.handle("media", async (req) => {
    const url = new URL(req.url);
    const filePath = decodeURIComponent(url.pathname);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return new Response("not found", { status: 404 });
      const ext = path.extname(filePath).toLowerCase();
      const mime: Record<string, string> = { ".mp4": "video/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".ass": "text/plain" };
      const headers: Record<string, string> = { "Content-Type": mime[ext] ?? "application/octet-stream", "Content-Length": String(stat.size) };
      const range = req.headers.get("range");
      if (range) {
        const m = range.match(/bytes=(\d*)-(\d*)/);
        if (m) {
          const start = m[1] ? parseInt(m[1], 10) : 0;
          const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
          const chunk = fs.createReadStream(filePath, { start, end });
          const chunks: Buffer[] = [];
          for await (const c of chunk) chunks.push(c as Buffer);
          const buf = Buffer.concat(chunks);
          return new Response(buf, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes" } });
        }
      }
      return net.fetch(`file://${filePath}`);
    } catch {
      return new Response("not found", { status: 404 });
    }
  });

  getDb();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

ipcMain.handle("license:verify", async (_e, { key, email }: { key: string; email?: string }) => {
  try { return await verifyLicense(key, email); } catch (e) { return { valid: false, message: String((e as Error).message ?? e) }; }
});
ipcMain.handle("license:status", async () => {
  try { return { licensed: isLicensed(), license: getLicense() }; } catch { return { licensed: false, license: null }; }
});
ipcMain.handle("system:info", async () => {
  try {
    const tier = ramTier();
    return { tier, whisperModel: whisperModelForTier(tier), llmModel: llmModelForTier(tier).file, licensed: isLicensed() };
  } catch { return { tier: "low", whisperModel: "base", llmModel: "qwen2.5-3b-q4_k_m.gguf", licensed: false }; }
});

ipcMain.handle("projects:list", async () => {
  const rows = getRaw().prepare("SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC").all();
  return rows;
});

ipcMain.handle("projects:get", async (_e, id: string) => {
  const project = getRaw().prepare("SELECT * FROM projects WHERE id=?").get(id);
  if (!project) return null;
  const jobs = getRaw().prepare("SELECT * FROM jobs WHERE project_id=? ORDER BY created_at DESC").all(id);
  const clips = getRaw().prepare("SELECT * FROM clips WHERE project_id=? ORDER BY start_time").all(id);
  const words = getRaw().prepare("SELECT * FROM timeline_words WHERE project_id=? ORDER BY idx").all(id);
  return { project, jobs, clips, words };
});

ipcMain.handle("projects:create", async (_e, data: { title: string; source: string; sourceType?: string }) => {
  if (!isLicensed()) throw new Error("License required");
  const id = randomUUID();
  const now = nowIso();
  const sourceType = data.sourceType ?? "youtube";
  const sourceKey = sourceType === "upload" ? data.source : null;
  getRaw().prepare("INSERT INTO projects (id, title, source, source_type, source_key, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, data.title || "Untitled", data.source, sourceType, sourceKey, "idle", now, now);
  return { id };
});

ipcMain.handle("projects:delete", async (_e, id: string) => {
  getRaw().prepare("UPDATE projects SET deleted_at=? WHERE id=?").run(nowIso(), id);
  return { ok: true };
});

ipcMain.handle("jobs:start", async (_e, { projectId, opts }: { projectId: string; opts?: Record<string, unknown> }) => {
  if (!isLicensed()) throw new Error("License required");
  const id = randomUUID();
  const now = nowIso();
  getRaw().prepare("INSERT INTO jobs (id, project_id, type, status, stage, progress, options, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, projectId, "analyze", "queued", "queued", 0, JSON.stringify(opts ?? {}), now, now);
  getRaw().prepare("UPDATE projects SET status='queued', updated_at=? WHERE id=?").run(now, projectId);
  setImmediate(() => {
    runAnalyze(id, (stage, progress) => win?.webContents.send("job:progress", { jobId: id, projectId, stage, progress }))
      .then(() => win?.webContents.send("job:progress", { jobId: id, projectId, stage: "completed", progress: 100 }))
      .catch((err) => win?.webContents.send("job:progress", { jobId: id, projectId, stage: "failed", error: String(err) }));
  });
  return { id };
});

ipcMain.handle("jobs:render", async (_e, { projectId, clipId, opts }: { projectId: string; clipId: string; opts?: Record<string, unknown> }) => {
  if (!isLicensed()) throw new Error("License required");
  const existing = getRaw().prepare("SELECT * FROM jobs WHERE project_id=? AND clip_id=? AND status IN ('queued','running')").get(projectId, clipId) as Record<string, unknown> | undefined;
  if (existing) throw new Error("Render already queued");
  const id = randomUUID();
  const now = nowIso();
  getRaw().prepare("INSERT INTO jobs (id, project_id, type, clip_id, status, stage, progress, options, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, projectId, "render", clipId, "queued", "queued", 0, JSON.stringify(opts ?? {}), now, now);
  setImmediate(() => {
    runRender(id, (stage, progress) => win?.webContents.send("job:progress", { jobId: id, projectId, clipId, stage, progress }))
      .then(() => win?.webContents.send("job:progress", { jobId: id, projectId, clipId, stage: "completed", progress: 100 }))
      .catch((err) => win?.webContents.send("job:progress", { jobId: id, projectId, clipId, stage: "failed", error: String(err) }));
  });
  return { id };
});

ipcMain.handle("jobs:get", async (_e, id: string) => getRaw().prepare("SELECT * FROM jobs WHERE id=?").get(id));
ipcMain.handle("clips:list", async (_e, projectId: string) => getRaw().prepare("SELECT * FROM clips WHERE project_id=? ORDER BY start_time").all(projectId));
