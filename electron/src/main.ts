import { app, BrowserWindow, ipcMain, protocol, net, dialog, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { getDb, getRaw, nowIso, initDb, dbFetchOne, dbFetchAll, dbExecute, getDbPathExport } from "./services/db.js";
import { verifyLicense, isLicensed, isLicensedSync, getLicense } from "./services/license.js";
import { ramTier, whisperModelForTier, llmModelForTier } from "./services/system.js";
import { listVariants, currentSelectedVariant, whisperStatus, ensureVariant, removeVariant } from "./services/models.js";
import { randomUUID } from "node:crypto";
import { utilityProcess } from "electron";
import { startLocalFastAPI, getLocalApiUrl, isLocalFastAPIEnabled, stopLocalFastAPI } from "./services/fastapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.setName("clipzard-desktop");
if (process.platform === "win32") app.setAppUserModelId("com.clipzard.desktop");

let win: BrowserWindow | null = null;

function createWindow() {
  const preloadPath = path.join(__dirname, "preload.cjs");
  const fallbackPreload = path.join(__dirname, "preload.js");
  const resolvedPreload = fs.existsSync(preloadPath) ? preloadPath : fallbackPreload;
  console.log("[main] preload path", resolvedPreload, "exists", fs.existsSync(resolvedPreload));
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: resolvedPreload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    backgroundColor: "#0a0a0a",
  });

  const devUrl = process.env.ELECTRON_DEV_URL;
  if (devUrl) {
    console.log("[main] loading devUrl", devUrl);
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: "detach" });
    win.webContents.on("did-fail-load", (_e, code, desc, url) => console.error("[main] did-fail-load", code, desc, url));
    win.webContents.on("console-message", (_e, level, msg, line, src) => console.log(`[renderer:${level}] ${msg} @${src}:${line}`));
  } else {
    const rendererDist = path.join(__dirname, "../renderer/dist/index.html");
    const resourceRenderer = path.join(process.resourcesPath, "app.asar", "renderer/dist/index.html");
    const fallbackWeb = path.join(path.resolve("..", "web", "out", "index.html"));
    const p = [rendererDist, resourceRenderer, fallbackWeb].find((x) => fs.existsSync(x));
    console.log("[main] loading file", p);
    if (p) {
      win.loadFile(p);
      win.webContents.openDevTools({ mode: "detach" });
      win.webContents.on("console-message", (_e, level, msg, line, src) => console.log(`[renderer:${level}] ${msg} @${src}:${line}`));
    } else win.loadURL("data:text/html,<h1>ClipZard - renderer not built. Run: npm --prefix electron/renderer run build</h1>");
  }
}

function isSafeMediaPath(p: string): string | null {
  const normalized = path.normalize(p);
  const roots = [path.normalize(path.join(app.getPath("userData"), "projects")), path.normalize(app.getPath("temp")), path.normalize(os.tmpdir())];
  if (roots.some((r) => normalized.startsWith(r))) return normalized;
  if (process.platform === "win32" && /^[a-zA-Z]:\\/.test(normalized) && roots.some((r) => normalized.toLowerCase().startsWith(r.toLowerCase()))) return normalized;
  return null;
}

let fastApiUrl: string | null = null;

app.whenReady().then(async () => {
  console.log("[main] userData", app.getPath("userData"), "appName", app.getName(), "isPackaged", app.isPackaged, "dbPath", getDbPathExport());
  await initDb();
  if (isLocalFastAPIEnabled()) {
    try {
      fastApiUrl = await startLocalFastAPI();
      console.log("[main] FastAPI local ready at", fastApiUrl);
    } catch (e) {
      console.error("[main] FastAPI failed to start, falling back to Node pipeline", e);
    }
  }
  protocol.handle("media", async (req) => {
    try {
      const url = new URL(req.url);
      let rawPath = decodeURIComponent(url.pathname);
      if (process.platform === "win32") {
        if (rawPath.startsWith("/")) rawPath = rawPath.slice(1);
        rawPath = rawPath.replace(/\//g, path.sep);
      }
      const safe = isSafeMediaPath(rawPath);
      if (!safe) return new Response("forbidden", { status: 403 });
      const stat = fs.statSync(safe);
      if (!stat.isFile()) return new Response("not found", { status: 404 });
      const ext = path.extname(safe).toLowerCase();
      const mime: Record<string, string> = { ".mp4": "video/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".ass": "text/plain" };
      const headers: Record<string, string> = { "Content-Type": mime[ext] ?? "application/octet-stream", "Content-Length": String(stat.size) };
      const range = req.headers.get("range");
      if (range) {
        const m = range.match(/bytes=(\d*)-(\d*)/);
        if (m) {
          const start = m[1] ? parseInt(m[1], 10) : 0;
          const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
          if (start >= stat.size || end >= stat.size || start > end) return new Response("range not satisfiable", { status: 416 });
          const chunk = fs.createReadStream(safe, { start, end });
          const chunks: Buffer[] = [];
          for await (const c of chunk) chunks.push(c as Buffer);
          const buf = Buffer.concat(chunks);
          return new Response(buf, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-store" } });
        }
      }
      return net.fetch(`file://${safe}`);
    } catch {
      return new Response("not found", { status: 404 });
    }
  });

  await seedCaptionStyles();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

async function seedCaptionStyles() {
  try {
    const row = await dbFetchOne<{ c: number }>("SELECT count(*) as c FROM caption_styles");
    if ((row?.c ?? 0) > 0) return;
    const presets = [
      { key: "classic", label: "Classic", config: { font: "Anton", font_size: 72, x: "center", y: 0.8, bold: true, italic: false, primary_color: "#FFFFFF", highlight_color: "#FFD60A", outline_color: "#000000", outline: 4, shadow: 0, words_per_line: 4, max_chars_per_line: 32, boxed: false, box_opacity: 0.0 } },
      { key: "clean", label: "Clean", config: { font: "Space Grotesk", font_size: 64, x: "center", y: 0.8, bold: false, italic: false, primary_color: "#FFFFFF", highlight_color: "#FFFFFF", outline_color: "#000000", outline: 3, shadow: 0, words_per_line: 5, max_chars_per_line: 36, boxed: false, box_opacity: 0.0 } },
      { key: "pop", label: "Pop", config: { font: "Anton", font_size: 88, x: "center", y: 0.75, bold: true, italic: false, primary_color: "#FFFFFF", highlight_color: "#FF5A52", outline_color: "#000000", outline: 5, shadow: 2, words_per_line: 3, max_chars_per_line: 28, boxed: false, box_opacity: 0.0 } },
      { key: "boxed", label: "Boxed", config: { font: "Space Grotesk", font_size: 60, x: "center", y: 0.82, bold: true, italic: false, primary_color: "#FFFFFF", highlight_color: "#FFD60A", outline_color: "#000000", outline: 2, shadow: 0, words_per_line: 4, max_chars_per_line: 30, boxed: true, box_opacity: 0.7 } },
    ];
    for (const p of presets) {
      await dbExecute("INSERT OR IGNORE INTO caption_styles (id, key, label, config, is_builtin) VALUES (?,?,?,?,?)", [p.key, p.key, p.label, JSON.stringify(p.config), 1]);
    }
  } catch {}
}

function toMediaUrl(p: string | null): string | null {
  if (!p) return null;
  if (p.startsWith("http://") || p.startsWith("https://") || p.startsWith("media://")) return p;
  return `media://${p}`;
}

app.on("window-all-closed", () => {
  for (const [, child] of activeUtilities) { try { child.kill(); } catch {} }
  stopLocalFastAPI();
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => {
  for (const [, child] of activeUtilities) { try { child.kill(); } catch {} }
  stopLocalFastAPI();
});
app.on("child-process-gone", (_e, details) => {
  if (details.type === "Utility") console.warn(`[main] utility gone reason=${details.reason} exitCode=${details.exitCode}`);
});

ipcMain.handle("fastapi:getUrl", async () => fastApiUrl);
ipcMain.handle("license:verify", async (_e, { key, email }: { key: string; email?: string }) => {
  try { return await verifyLicense(key, email); } catch (e) { return { valid: false, message: String((e as Error).message ?? e) }; }
});
ipcMain.handle("license:status", async () => {
  try { return { licensed: await isLicensed(), license: await getLicense() }; } catch { return { licensed: false, license: null }; }
});
ipcMain.handle("system:info", async () => {
  try {
    const tier = ramTier();
    return { tier, whisperModel: whisperModelForTier(tier), llmModel: llmModelForTier(tier).file, licensed: await isLicensed(), fastApiUrl, selectedVariant: currentSelectedVariant(), whisper: whisperStatus() };
  } catch { return { tier: "low", whisperModel: "base", llmModel: "qwen2.5-1.5b-q4_k_m.gguf", licensed: false, fastApiUrl: null, selectedVariant: "balanced", whisper: null }; }
});
ipcMain.handle("models:list", async () => {
  try { return { variants: listVariants(), selected: currentSelectedVariant(), whisper: whisperStatus() }; }
  catch (e) { return { variants: [], selected: "balanced", whisper: null, error: String(e) }; }
});
ipcMain.handle("models:setVariant", async (_e, variant: string) => {
  const v = String(variant).toLowerCase();
  if (!["tiny","balanced","quality"].includes(v)) throw new Error("invalid variant");
  try {
    const Store = (await import("electron-store")).default as unknown as new (o: unknown)=> { set:(k:string,v:unknown)=>void; get:(k:string)=>unknown };
    const store = new (Store as unknown as new (o: unknown)=> { set:(k:string,v:unknown)=>void })({ name: "clipzard-config" });
    store.set("llmVariant", v);
    process.env.LLM_TIER = v;
    return { ok: true, selected: v };
  } catch (e) { throw new Error(String((e as Error).message)); }
});
ipcMain.handle("models:ensure", async (_e, variant: string) => {
  const v = String(variant).toLowerCase() as "tiny"|"balanced"|"quality";
  if (!["tiny","balanced","quality"].includes(v)) throw new Error("invalid variant");
  await ensureVariant(v, (p) => win?.webContents.send("models:progress", { variant: v, progress: p }));
  win?.webContents.send("models:progress", { variant: v, progress: 1, done: true });
  return { ok: true };
});
ipcMain.handle("models:remove", async (_e, variant: string) => {
  const v = String(variant).toLowerCase() as "tiny"|"balanced"|"quality";
  await removeVariant(v);
  return { ok: true };
});

ipcMain.handle("projects:list", async () => {
  const rows = await dbFetchAll<Record<string, unknown>>("SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC");
  const result: Record<string, unknown>[] = [];
  for (const r of rows) {
    const clipRow = await dbFetchOne<{ c: number }>("SELECT count(*) as c FROM clips WHERE project_id=?", [r.id as string]);
    result.push({ ...r, clip_count: clipRow?.c ?? 0 });
  }
  return result;
});

ipcMain.handle("projects:get", async (_e, id: string) => {
  const project = await dbFetchOne<Record<string, unknown>>("SELECT * FROM projects WHERE id=?", [id]);
  if (!project) return null;
  const jobs = await dbFetchAll<Record<string, unknown>>("SELECT * FROM jobs WHERE project_id=? ORDER BY created_at DESC", [id]);
  const rawClips = await dbFetchAll<Record<string, unknown>>("SELECT * FROM clips WHERE project_id=? ORDER BY start_time", [id]);
  const clips = rawClips.map((c) => ({
    ...c,
    video_url: toMediaUrl(c.video_url as string | null),
    thumbnail_url: toMediaUrl(c.thumbnail_url as string | null),
    signed_video_url: toMediaUrl(c.video_url as string | null),
    signed_thumbnail_url: toMediaUrl(c.thumbnail_url as string | null),
  }));
  const words = await dbFetchAll<Record<string, unknown>>("SELECT * FROM timeline_words WHERE project_id=? ORDER BY idx", [id]);
  const sourceUrl = toMediaUrl(project.source_key as string | null) ?? toMediaUrl(project.source as string | null);
  return { project: { ...project, source_url: sourceUrl, signed_source_url: sourceUrl }, jobs, clips, words, source_url: sourceUrl };
});

ipcMain.handle("projects:create", async (_e, data: { title: string; source: string; sourceType?: string }) => {
  if (!(await isLicensed())) throw new Error("License required");
  const id = randomUUID();
  const now = nowIso();
  const sourceType = data.sourceType ?? "youtube";
  const sourceKey = sourceType === "upload" ? data.source : null;
  await dbExecute("INSERT INTO projects (id, title, source, source_type, source_key, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", [id, data.title || "Untitled", data.source, sourceType, sourceKey, "idle", now, now]);
  return { id };
});

ipcMain.handle("projects:delete", async (_e, id: string) => {
  await dbExecute("UPDATE projects SET deleted_at=? WHERE id=?", [nowIso(), id]);
  return { ok: true };
});
ipcMain.handle("projects:trash", async () => {
  return await dbFetchAll<Record<string, unknown>>("SELECT * FROM projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC");
});
ipcMain.handle("projects:restore", async (_e, id: string) => {
  await dbExecute("UPDATE projects SET deleted_at=NULL, updated_at=? WHERE id=?", [nowIso(), id]);
  return { ok: true };
});
ipcMain.handle("projects:purge", async (_e, id: string) => {
  const p = await dbFetchOne<Record<string, unknown>>("SELECT * FROM projects WHERE id=?", [id]);
  if (p) {
    const clipFiles = await dbFetchAll<Record<string, unknown>>("SELECT * FROM clips WHERE project_id=?", [id]);
    for (const c of clipFiles) {
      try { if (c.video_url) fs.unlinkSync(c.video_url as string); } catch {}
      try { if (c.thumbnail_url) fs.unlinkSync(c.thumbnail_url as string); } catch {}
    }
    try { if (p.source_key) fs.unlinkSync(p.source_key as string); } catch {}
    try { const dir = path.join(app.getPath("userData"), "projects", id); fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  await dbExecute("DELETE FROM projects WHERE id=?", [id]);
  return { ok: true };
});
ipcMain.handle("caption-styles:list", async () => {
  return await dbFetchAll<Record<string, unknown>>("SELECT * FROM caption_styles ORDER BY label");
});
ipcMain.handle("caption-styles:create", async (_e, data: { label: string; config: Record<string, unknown> }) => {
  const id = randomUUID();
  const key = `custom_${id.slice(0, 8)}`;
  await dbExecute("INSERT INTO caption_styles (id, key, label, config, is_builtin) VALUES (?,?,?,?,?)", [id, key, data.label, JSON.stringify(data.config), 0]);
  return await dbFetchOne<Record<string, unknown>>("SELECT * FROM caption_styles WHERE id=?", [id]);
});

const activeUtilities = new Map<string, Electron.UtilityProcess>();

async function runJobInUtility(jobId: string, projectId: string, clipId?: string) {
  console.log(`[main] runJobInUtility jobId=${jobId} projectId=${projectId} clipId=${clipId} isLicensed=${isLicensedSync()} packaged=${app.isPackaged}`);
  const userDataPath = app.getPath("userData");
  const resourcesPath = process.resourcesPath ?? process.cwd();
  const runnerPath = path.join(__dirname, "worker", "jobRunner.js");
  const fallbackRunner = path.join(__dirname, "worker/jobRunner.js");
  const resolved = fs.existsSync(runnerPath) ? runnerPath : fallbackRunner;
  console.log(`[main] utility runner ${resolved} exists ${fs.existsSync(resolved)} userData=${userDataPath}`);

  if (!fs.existsSync(resolved)) {
    console.error("[main] jobRunner not found, marking job failed");
    try {
      const db = getRaw();
      db.prepare("UPDATE jobs SET status='failed', error=? WHERE id=?").run("jobRunner missing", jobId);
      db.prepare("UPDATE projects SET status='failed' WHERE id=?").run(projectId);
    } catch {}
    win?.webContents.send("job:progress", { jobId, projectId, clipId, stage: "failed", error: "jobRunner missing" });
    return;
  }

  // Gather snapshot for the utility (so it doesn't need SQLite)
  const project = await dbFetchOne<Record<string, unknown>>("SELECT * FROM projects WHERE id=?", [projectId]);
  const job = await dbFetchOne<Record<string, unknown>>("SELECT * FROM jobs WHERE id=?", [jobId]);
  if (!project || !job) {
    console.error("[main] project/job not found for utility", projectId, jobId);
    return;
  }
  const jobType = String(job.type ?? "analyze");

  // Mark running immediately (main owns DB, not utility)
  const now = nowIso();
  await dbExecute("UPDATE jobs SET status='running', stage='downloading', progress=2, updated_at=? WHERE id=?", [now, jobId]);
  await dbExecute("UPDATE projects SET status='running', updated_at=? WHERE id=?", [now, projectId]);
  win?.webContents.send("job:progress", { jobId, projectId, clipId, stage: "downloading", progress: 2 });

  // For analyze, include cached timeline_words if any (so utility can skip transcribe on re-run)
  let cachedWords: unknown[] | undefined;
  try {
    const rows = await dbFetchAll<Record<string, unknown>>("SELECT text, start_ms, end_ms FROM timeline_words WHERE project_id=? ORDER BY idx", [projectId]);
    if (rows.length) cachedWords = rows.map((r) => ({ text: String(r.text), start_ms: Number(r.start_ms), end_ms: Number(r.end_ms) }));
  } catch {}

  let child: Electron.UtilityProcess;
  try {
    child = utilityProcess.fork(resolved, [], {
      serviceName: `clipzard-job-${jobId.slice(0, 8)}`,
      stdio: "pipe",
      env: { ...process.env, USER_DATA_PATH: userDataPath, RESOURCES_PATH: resourcesPath },
    });
  } catch (e) {
    console.error("[main] utilityProcess.fork failed", e);
    try {
      await dbExecute("UPDATE jobs SET status='failed', error=? WHERE id=?", [String((e as Error).message).slice(0, 500), jobId]);
      await dbExecute("UPDATE projects SET status='failed' WHERE id=?", [projectId]);
    } catch {}
    win?.webContents.send("job:progress", { jobId, projectId, clipId, stage: "failed", error: String(e) });
    return;
  }

  activeUtilities.set(jobId, child);

  child.on("spawn", async () => {
    console.log(`[main] utility spawned pid=${child.pid} for ${jobId}`);
    child.stdout?.on("data", (d: Buffer) => console.log(`[utility:${jobId.slice(0,6)} out] ${d.toString().trim()}`));
    child.stderr?.on("data", (d: Buffer) => console.error(`[utility:${jobId.slice(0,6)} err] ${d.toString().trim()}`));

    // Send start payload after spawn so parentPort is ready
    const payload: Record<string, unknown> = clipId
      ? {
          type: "start",
          jobId,
          projectId,
          clipId,
          jobType: "render",
          project: { id: projectId, source_key: String(project.source_key ?? "") },
          clip: await (async () => {
            const c = await dbFetchOne<Record<string, unknown>>("SELECT * FROM clips WHERE id=?", [clipId]);
            if (!c) return null;
            return { id: String(c.id), title: String(c.title), start_time: Number(c.start_time), end_time: Number(c.end_time), caption_json: c.caption_json as string | null, thumbnail_url: c.thumbnail_url as string | null };
          })(),
          opts: (() => {
            try { return JSON.parse(String(job.options ?? "{}")); } catch { return {}; }
          })(),
        }
      : {
          type: "start",
          jobId,
          projectId,
          jobType: "analyze",
          project: { id: projectId, title: String(project.title), source: String(project.source), source_type: String(project.source_type ?? "youtube"), source_key: project.source_key as string | null, language: (project.language as string | null) ?? null },
          opts: (() => {
            try { return JSON.parse(String(job.options ?? "{}")); } catch { return {}; }
          })(),
          cachedWords: cachedWords ?? undefined,
        };

    if (clipId && !(payload as Record<string, unknown>).clip) {
      console.error("[main] clip not found for render", clipId);
      child.kill();
      return;
    }
    child.postMessage(payload as never);
  });

  child.on("message", async (msg: unknown) => {
    const m = msg as Record<string, unknown>;
    if (!m || typeof m.type !== "string") return;

    if (m.type === "progress" && typeof m.stage === "string") {
      const stage = String(m.stage);
      const progress = Number(m.progress ?? 0);
      try { await dbExecute("UPDATE jobs SET stage=?, progress=?, updated_at=? WHERE id=?", [stage, progress, nowIso(), jobId]); } catch {}
      win?.webContents.send("job:progress", { jobId, projectId, clipId, stage, progress });
    } else if (m.type === "sourceReady" && typeof m.sourceKey === "string") {
      try {
        await dbExecute("UPDATE projects SET source_key=?, updated_at=? WHERE id=?", [String(m.sourceKey), nowIso(), projectId]);
        if (m.language) await dbExecute("UPDATE projects SET language=? WHERE id=?", [String(m.language), projectId]);
      } catch {}
    } else if (m.type === "meta" && typeof m.language === "string") {
      try { await dbExecute("UPDATE projects SET language=? WHERE id=?", [String(m.language), projectId]); } catch {}
    } else if (m.type === "words" && Array.isArray(m.words)) {
      try {
        const words = m.words as { text: string; start_ms: number; end_ms: number }[];
        const lang = (m.language as string | null) ?? null;
        if (lang) await dbExecute("UPDATE projects SET language=? WHERE id=?", [lang, projectId]);
        await dbExecute("DELETE FROM timeline_words WHERE project_id=?", [projectId]);
        for (let i = 0; i < words.length; i++) {
          await dbExecute("INSERT INTO timeline_words (id, project_id, idx, text, start_ms, end_ms) VALUES (?,?,?,?,?,?)", [`${projectId}_${i}`, projectId, i, words[i].text, words[i].start_ms, words[i].end_ms]);
        }
      } catch (e) { console.warn("[main] words persist failed", e); }
    } else if (m.type === "done") {
      const payload = m.payload as Record<string, unknown> | undefined;
      try {
        if (jobType === "render" || clipId) {
          const videoUrl = String((payload as Record<string, unknown>)?.videoUrl ?? "");
          const thumbPath = (payload as Record<string, unknown>)?.thumbPath as string | null | undefined;
          if (videoUrl) await dbExecute("UPDATE clips SET video_url=? WHERE id=?", [videoUrl, clipId!]);
          if (thumbPath) {
            const existing = await dbFetchOne<Record<string, unknown>>("SELECT thumbnail_url FROM clips WHERE id=?", [clipId!]);
            if (!existing?.thumbnail_url) await dbExecute("UPDATE clips SET thumbnail_url=? WHERE id=?", [thumbPath, clipId!]);
          }
          await dbExecute("UPDATE jobs SET status='completed', stage=NULL, progress=100, updated_at=? WHERE id=?", [nowIso(), jobId]);
          win?.webContents.send("job:progress", { jobId, projectId, clipId, stage: "completed", progress: 100 });
        } else {
          const clips = (payload as Record<string, unknown>)?.clips as { title: string; hook?: string; start: number; end: number; thumbPath: string | null; captionJson: string | null }[] | undefined;
          if (Array.isArray(clips) && clips.length) {
            for (let i = 0; i < clips.length; i++) {
              const c = clips[i];
              const clipIdNew = `${jobId}_${i}`;
              await dbExecute("INSERT INTO clips (id, project_id, job_id, title, viral_hook, start_time, end_time, thumbnail_url, caption_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", [clipIdNew, projectId, jobId, c.title, c.hook ?? null, c.start, c.end, c.thumbPath, c.captionJson, nowIso()]);
            }
          }
          await dbExecute("UPDATE jobs SET status='completed', stage=NULL, progress=100, updated_at=? WHERE id=?", [nowIso(), jobId]);
          await dbExecute("UPDATE projects SET status='completed', updated_at=? WHERE id=?", [nowIso(), projectId]);
          win?.webContents.send("job:progress", { jobId, projectId, clipId, stage: "completed", progress: 100 });
        }
      } catch (e) { console.error("[main] done handling failed", e); }
    } else if (m.type === "error") {
      const err = String(m.error ?? "unknown").slice(0, 800);
      console.error(`[main] utility error ${jobId} ${err}`);
      try {
        await dbExecute("UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?", [err.slice(0, 500), nowIso(), jobId]);
        await dbExecute("UPDATE projects SET status='failed', updated_at=? WHERE id=?", [nowIso(), projectId]);
      } catch {}
      win?.webContents.send("job:progress", { jobId, projectId, clipId, stage: "failed", error: err });
    }
  });

  // UtilityProcess has no 'error' event in types; handle via exit/message
  (child as unknown as { on: (e: string, cb: (err: Error) => void) => void }).on("error", async (err: Error) => {
    console.error(`[utility] error ${jobId}`, err);
    activeUtilities.delete(jobId);
    try {
      await dbExecute("UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?", [String(err).slice(0, 500), nowIso(), jobId]);
      await dbExecute("UPDATE projects SET status='failed', updated_at=? WHERE id=?", [nowIso(), projectId]);
    } catch {}
    win?.webContents.send("job:progress", { jobId, projectId, clipId, stage: "failed", error: String(err) });
  });

  child.on("exit", async (code: number) => {
    console.log(`[utility] exit ${jobId} code ${code}`);
    activeUtilities.delete(jobId);
    // If exit without done/error and job still running, mark failed
    try {
      const j = await dbFetchOne<Record<string, unknown>>("SELECT status FROM jobs WHERE id=?", [jobId]);
      if (j && (j.status === "running" || j.status === "queued")) {
        if (code !== 0) {
          await dbExecute("UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?", [`utility exit ${code}`, nowIso(), jobId]);
          await dbExecute("UPDATE projects SET status='failed', updated_at=? WHERE id=?", [nowIso(), projectId]);
          win?.webContents.send("job:progress", { jobId, projectId, clipId, stage: "failed", error: `utility exit ${code}` });
        }
      }
    } catch {}
  });
}

ipcMain.handle("jobs:start", async (_e, { projectId, opts }: { projectId: string; opts?: Record<string, unknown> }) => {
  if (!(await isLicensed())) throw new Error("License required");
  const id = randomUUID();
  const now = nowIso();
  await dbExecute("INSERT INTO jobs (id, project_id, type, status, stage, progress, options, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", [id, projectId, "analyze", "queued", "queued", 0, JSON.stringify(opts ?? {}), now, now]);
  await dbExecute("UPDATE projects SET status='queued', updated_at=? WHERE id=?", [now, projectId]);
  // must not await utility, start async
  void (async () => runJobInUtility(id, projectId))();
  const job = await dbFetchOne<Record<string, unknown>>("SELECT * FROM jobs WHERE id=?", [id]);
  return job ?? { id, project_id: projectId, type: "analyze", status: "queued", stage: "queued", progress: 0, options: JSON.stringify(opts ?? {}), created_at: now, updated_at: now };
});

ipcMain.handle("jobs:render", async (_e, { projectId, clipId, opts }: { projectId: string; clipId: string; opts?: Record<string, unknown> }) => {
  if (!(await isLicensed())) throw new Error("License required");
  const existing = await dbFetchOne<Record<string, unknown>>("SELECT * FROM jobs WHERE project_id=? AND clip_id=? AND status IN ('queued','running')", [projectId, clipId]);
  if (existing) throw new Error("Render already queued");
  const id = randomUUID();
  const now = nowIso();
  await dbExecute("INSERT INTO jobs (id, project_id, type, clip_id, status, stage, progress, options, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", [id, projectId, "render", clipId, "queued", "queued", 0, JSON.stringify(opts ?? {}), now, now]);
  void (async () => runJobInUtility(id, projectId, clipId))();
  const job = await dbFetchOne<Record<string, unknown>>("SELECT * FROM jobs WHERE id=?", [id]);
  return job ?? { id, project_id: projectId, type: "render", clip_id: clipId, status: "queued", stage: "queued", progress: 0, options: JSON.stringify(opts ?? {}), created_at: now, updated_at: now };
});

ipcMain.handle("jobs:cancel", async (_e, jobId: string) => {
  const child = activeUtilities.get(jobId);
  if (child) { try { child.kill(); } catch {} activeUtilities.delete(jobId); }
  try {
    const j = await dbFetchOne<Record<string, unknown>>("SELECT status FROM jobs WHERE id=?", [jobId]);
    if (j && (j.status === "queued" || j.status === "running")) {
      await dbExecute("UPDATE jobs SET status='failed', error='cancelled', updated_at=? WHERE id=?", [nowIso(), jobId]);
    }
  } catch {}
  return { ok: true };
});

ipcMain.handle("jobs:get", async (_e, id: string) => await dbFetchOne<Record<string, unknown>>("SELECT * FROM jobs WHERE id=?", [id]));
ipcMain.handle("clips:list", async (_e, projectId: string) => await dbFetchAll<Record<string, unknown>>("SELECT * FROM clips WHERE project_id=? ORDER BY start_time", [projectId]));
ipcMain.handle("dialog:openVideo", async () => {
  const res = await dialog.showOpenDialog(win!, { properties: ["openFile"], filters: [{ name: "Video", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v"] }] });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});
ipcMain.handle("dialog:saveVideo", async (_e, { sourcePath, defaultName }: { sourcePath: string; defaultName?: string }) => {
  const safe = isSafeMediaPath(sourcePath);
  if (!safe) throw new Error("forbidden path");
  if (!fs.existsSync(safe)) throw new Error("file not found");
  const { canceled, filePath } = await dialog.showSaveDialog(win!, {
    defaultPath: defaultName ?? path.basename(safe),
    filters: [{ name: "Video", extensions: ["mp4"] }],
  });
  if (canceled || !filePath) return null;
  fs.copyFileSync(safe, filePath);
  return filePath;
});
ipcMain.handle("shell:showItemInFolder", async (_e, filePath: string) => {
  const safe = isSafeMediaPath(filePath) ?? (fs.existsSync(filePath) ? filePath : null);
  if (!safe) throw new Error("forbidden");
  shell.showItemInFolder(safe);
  return { ok: true };
});
ipcMain.handle("shell:openPath", async (_e, filePath: string) => {
  const safe = isSafeMediaPath(filePath) ?? (fs.existsSync(filePath) ? filePath : null);
  if (!safe) throw new Error("forbidden");
  const r = await shell.openPath(safe);
  if (r) throw new Error(r);
  return { ok: true };
});
ipcMain.handle("shell:openExternal", async (_e, url: string) => { await shell.openExternal(url); });
ipcMain.handle("app:getPath", async (_e, name: string) => app.getPath(name as Parameters<typeof app.getPath>[0]));
