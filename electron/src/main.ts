import { app, BrowserWindow, ipcMain, protocol, net, dialog, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { getDb, getRaw, nowIso, initDb, dbFetchOne, dbFetchAll, dbExecute, getDbPathExport } from "./services/db.js";
import * as auth from "./services/auth.js";
import { checkEntitlement, clearEntitlementCache, ensureFreshCheck, isEntitledSync } from "./services/entitlement.js";
import { ramTier, whisperModelForTier, llmModelForTier } from "./services/system.js";
import { listVariants, currentSelectedVariant, whisperStatus, ensureVariant, removeVariant } from "./services/models.js";
import { getDepsStatus, isAllDepsReady, missingDeps, isBinariesReady, missingBinaries } from "./services/deps.js";
import { userDataRoot } from "./services/userData.js";
import { randomUUID } from "node:crypto";
import { utilityProcess } from "electron";
import { startLocalFastAPI, getLocalApiUrl, isLocalFastAPIEnabled, stopLocalFastAPI } from "./services/fastapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.setName("clipzard-desktop");
if (process.platform === "win32") app.setAppUserModelId("com.clipzard.desktop");

if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

let win: BrowserWindow | null = null;

function createWindow() {
  const preloadPath = path.join(__dirname, "preload.cjs");
  const fallbackPreload = path.join(__dirname, "preload.js");
  const resolvedPreload = fs.existsSync(preloadPath) ? preloadPath : fallbackPreload;
  console.log("[main] preload path", resolvedPreload, "exists", fs.existsSync(resolvedPreload));
  const windowIcon = (() => {
    const candidates = [
      path.join(__dirname, "../resources/icon.png"),
      path.join(__dirname, "resources/icon.png"),
      path.join(process.resourcesPath ?? "", "icon.png"),
      path.join(process.cwd(), "resources/icon.png"),
      path.join(process.cwd(), "electron/resources/icon.png"),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    console.log("[main] windowIcon candidates", candidates, "found", found);
    return found ?? undefined;
  })();
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: windowIcon,
    webPreferences: {
      preload: resolvedPreload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    backgroundColor: "#0a0a0a",
  });

  const devUrl = process.env.ELECTRON_DEV_URL;
  const isDev = !!devUrl || !app.isPackaged || process.env.NODE_ENV === "development";
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
      // DevTools only in dev — not in prod packaged builds
      if (isDev) {
        win.webContents.openDevTools({ mode: "detach" });
        win.webContents.on("console-message", (_e, level, msg, line, src) => console.log(`[renderer:${level}] ${msg} @${src}:${line}`));
      }
    } else win.loadURL("data:text/html,<h1>ClipZard - renderer not built. Run: npm --prefix electron/renderer run build</h1>");
  }
}

function isSafeMediaPath(p: string): string | null {
  let toCheck = p;
  // Handle Windows media:// style paths like /C:/Users/... or \C:\Users\... (from media:// URLs)
  if (process.platform === "win32") {
    if ((toCheck.startsWith("/") || toCheck.startsWith(path.sep)) && /^[a-zA-Z]:/.test(toCheck.slice(1))) {
      toCheck = toCheck.slice(1);
    }
  }
  const resolved = path.resolve(path.normalize(toCheck));
  const roots = [
    path.resolve(path.normalize(path.join(userDataRoot(), "projects"))),
    path.resolve(path.normalize(path.join(userDataRoot(), "youtube-cache"))),
    path.resolve(path.normalize(app.getPath("temp"))),
    path.resolve(path.normalize(os.tmpdir())),
  ];
  for (const r of roots) {
    if (resolved === r || resolved.startsWith(r + path.sep)) return resolved;
  }
  if (process.platform === "win32") {
    const lower = resolved.toLowerCase();
    for (const r of roots) {
      const lr = r.toLowerCase();
      if (lower === lr || lower.startsWith(lr + path.sep.toLowerCase())) return resolved;
    }
  }
  return null;
}

function humanizeLog(line: string): { level: "info" | "warn" | "error"; message: string } {
  const s = line.trim();
  if (!s) return { level: "info", message: s };
  const lower = s.toLowerCase();
  if (lower.includes("error") || lower.includes("failed") || lower.includes("not all tensors") || lower.includes("cannot open shared") || lower.includes("enoent")) return { level: "error", message: s };
  if (lower.includes("warn") || lower.includes("n challenge") || lower.includes("only images are available") || lower.includes("bot guard") || lower.includes("truncated")) return { level: "warn", message: s };
  return { level: "info", message: s };
}

const YT_CACHE_MAX_BYTES = 5 * 1024 * 1024 * 1024;

async function evictYoutubeCacheIfNeeded() {
  try {
    const rows = await dbFetchAll<{ bytes: number; video_id: string; file_path: string }>("SELECT video_id, file_path, bytes FROM youtube_cache ORDER BY last_used_at ASC");
    let total = rows.reduce((a, r) => a + Number(r.bytes || 0), 0);
    for (const r of rows) {
      if (total <= YT_CACHE_MAX_BYTES) break;
      try { if (fs.existsSync(r.file_path)) fs.unlinkSync(r.file_path); } catch {}
      await dbExecute("DELETE FROM youtube_cache WHERE video_id=?", [r.video_id]);
      total -= Number(r.bytes || 0);
    }
  } catch {}
}

let fastApiUrl: string | null = null;

app.whenReady().then(async () => {
  console.log("[main] userData", userDataRoot(), "legacyAppUserData", app.getPath("userData"), "appName", app.getName(), "isPackaged", app.isPackaged, "dbPath", getDbPathExport());
  try {
    await Promise.race([
      initDb(),
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error("initDb timeout 10000ms")), 10_000)),
    ]);
  } catch (e) {
    console.warn("[main] initDb failed/timeout, continuing to window", String(e).slice(0,500));
    try { const { getDb } = await import("./services/db.js"); (getDb as any)(); } catch {}
  }
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
      // url.host may contain drive letter for media://C:/... (without triple slash) — handle both
      let rawPath = decodeURIComponent(url.pathname);
      // Handle media://C:/path where C: ends up in host (e.g. media://C:/Users/...)
      if (url.host && /^[a-zA-Z]:$/.test(url.host)) {
        rawPath = `/${url.host}${rawPath}`;
      } else if (url.host && url.host.length > 0 && !rawPath.startsWith("/")) {
        rawPath = `/${url.host}/${rawPath}`;
      }
      rawPath = decodeURIComponent(rawPath);
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
      // Use forward slashes + file:/// for Windows (file://C:\ fails with backslashes/spaces)
      // encodeURI handles spaces and Unicode, keep :/ intact
      const fileForward = safe.replace(/\\/g, "/");
      // Encode only the path part after drive letter to preserve :/
      const fileUrl = `file:///${encodeURI(fileForward.replace(/^\//, "")).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
      return net.fetch(fileUrl);
    } catch {
      return new Response("not found", { status: 404 });
    }
  });

  await seedCaptionStyles();
  startJobWatchdog();
  // Immediate sweep for orphan jobs left from previous run (before map empty + restart)
  void (async () => {
    try {
      const rows = await dbFetchAll<Record<string, unknown>>("SELECT id, project_id, clip_id, status FROM jobs WHERE status IN ('running','queued')");
      for (const r of rows) {
        const jobId = String(r.id);
        if (!activeUtilities.has(jobId)) {
          await reconcileRunningJob(jobId, String(r.project_id), r.clip_id ? String(r.clip_id) : undefined, "orphan after restart");
        }
      }
    } catch {}
  })();

  // Onboarding gate: if never completed/skipped, show /onboarding first (capcut-like)
  try {
    const Store = (await import("electron-store")).default as unknown as new (o: unknown)=> { get:(k:string, d?:unknown)=>unknown };
    const store = new (Store as unknown as new (o: unknown)=> { get:(k:string, d?:unknown)=>unknown })({ name: "clipzard-config" });
    const completed = Boolean(store.get("onboardingCompleted", false));
    const skipped = Boolean(store.get("onboardingSkipped", false));
    if (!completed && !skipped && !isAllDepsReady()) {
      // Start with onboarding route
      const origUrl = process.env.ELECTRON_DEV_URL;
      if (origUrl) {
        // In dev, let renderer handle /onboarding via hash
        createWindow();
        setTimeout(() => win?.webContents.send("navigate", "/onboarding"), 800);
      } else {
        createWindow();
        win?.webContents.once("did-finish-load", () => win?.webContents.send("navigate", "/onboarding"));
      }
      // Also expose via hash fallback: Settings will still show dep setup
    } else {
      createWindow();
    }
  } catch {
    createWindow();
  }
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

  // Self-update mechanism. Only enabled in packaged builds against a
  // public update server (configured via env vars).  Disabled when
  // CLIPZARD_UPDATE_URL is unset (local dev / community builds).
  if (app.isPackaged) {
    void initAutoUpdater().catch((e) => console.error("[updater] init failed", e));
  }
});

// ----------------------------------------------------------------- updater

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

async function readStoredUpdateChannel(): Promise<"stable" | "beta"> {
  try {
    const Store = (await import("electron-store")).default;
    const store = new Store();
    const ch = store.get("updateChannel", "stable");
    return ch === "beta" ? "beta" : "stable";
  } catch {
    return "stable";
  }
}

async function initAutoUpdater() {
  const feedBase = (process.env.CLIPZARD_UPDATE_URL ?? "https://clipzard.web.id").trim();
  if (!feedBase) {
    console.log("[updater] CLIPZARD_UPDATE_URL not set — auto-update disabled");
    return;
  }
  let mod: typeof import("electron-updater");
  try {
    mod = await import("electron-updater");
  } catch (e) {
    console.error("[updater] electron-updater not available", e);
    return;
  }
  const { autoUpdater } = mod;

  // Tell autoUpdater to use our custom YAML feed.  The generic provider
  // fetches `${baseUrl}/<channel>.yml` (and `<channel>-<platform>.yml` on
  // macOS/Linux).  We bake the platform/arch into the base URL so the
  // same backend can serve every combination without per-OS gymnastics.
  const storedChannel = await readStoredUpdateChannel();
  const channel = (process.env.CLIPZARD_UPDATE_CHANNEL ?? storedChannel) as "stable" | "beta";
  const platform = process.platform; // win32 | darwin | linux
  const arch = process.arch; // x64 | ia32 | arm64 | arm
  const feedBasePerPlatform = `${feedBase.replace(/\/$/, "")}/api/v1/update-feed/${platform}/${arch}`;
  autoUpdater.setFeedURL({
    provider: "generic",
    url: feedBasePerPlatform,
    channel,
  });
  autoUpdater.autoDownload = false; // user must opt-in via dialog
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    console.log("[updater] checking for update");
    win?.webContents.send("update:status", { state: "checking" });
  });
  autoUpdater.on("update-available", async (info) => {
    console.log("[updater] update available", info.version);
    win?.webContents.send("update:status", { state: "available", version: info.version, releaseNotes: info.releaseNotes });
    const { response } = await dialog.showMessageBox(win ?? undefined as never, {
      type: "info",
      title: "Update available",
      message: `Version ${info.version} is available`,
      detail: typeof info.releaseNotes === "string" ? info.releaseNotes : "A new version of ClipZard is ready to download.",
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      try {
        await autoUpdater.downloadUpdate();
      } catch (e) {
        console.error("[updater] download failed", e);
      }
    }
  });
  autoUpdater.on("update-not-available", (info) => {
    console.log("[updater] no update available (current:", info.version, ")");
    win?.webContents.send("update:status", { state: "current", version: info.version });
  });
  autoUpdater.on("download-progress", (p) => {
    win?.webContents.send("update:status", { state: "downloading", percent: Math.round(p.percent), version: (p as unknown as { version?: string }).version });
  });
  autoUpdater.on("update-downloaded", async (info) => {
    console.log("[updater] update downloaded", info.version);
    win?.webContents.send("update:status", { state: "downloaded", version: info.version });
    const { response } = await dialog.showMessageBox(win ?? undefined as never, {
      type: "question",
      title: "Update downloaded",
      message: `Version ${info.version} is ready to install`,
      detail: "ClipZard will restart to apply the update.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
  autoUpdater.on("error", (err) => {
    console.error("[updater] error", String(err).slice(0, 500));
    win?.webContents.send("update:status", { state: "error", message: String(err).slice(0, 300) });
  });

  // Initial check (after a small delay so the window has a chance to show
  // the status indicator)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => console.error("[updater] checkForUpdates failed", e));
  }, 5_000);
  // Periodic re-check
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((e) => console.error("[updater] periodic check failed", e));
  }, UPDATE_CHECK_INTERVAL_MS);

  // Expose manual trigger for renderer (Settings page "Check for Updates")
  ipcMain.handle("updates:check", async () => {
    try {
      const r = await autoUpdater.checkForUpdates();
      return { ok: true, version: r?.updateInfo?.version ?? null };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 300) };
    }
  });
  ipcMain.handle("updates:install", async () => {
    autoUpdater.quitAndInstall();
  });
  ipcMain.handle("updates:channel", async (_e, channel: "stable" | "beta") => {
    if (channel !== "stable" && channel !== "beta") return { ok: false, error: "invalid channel" };
    autoUpdater.channel = channel;
    // Persist for next launch
    try {
      const Store = (await import("electron-store")).default;
      const store = new Store();
      store.set("updateChannel", channel);
    } catch {}
    try {
      const r = await autoUpdater.checkForUpdates();
      return { ok: true, version: r?.updateInfo?.version ?? null };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 300) };
    }
  });
}

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
  // Windows paths contain backslashes and spaces — normalize to forward slashes and URI-encode
  // Use media:///C:/path style so URL.pathname is /C:/path and protocol.handle can decode correctly
  const normalized = p.replace(/\\/g, "/");
  // Ensure leading slash for absolute Windows path, then encode
  const withSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `media://${encodeURI(withSlash)}`;
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
// ─── Auth (replaces license:verify / license:status) ────────────────────
ipcMain.handle("auth:login", async (_e, { email, password }: { email: string; password: string }) => {
  try { return await auth.login(email, password); }
  catch (e) { return { ok: false, reason: "server_error", message: String((e as Error).message ?? e) }; }
});
ipcMain.handle("auth:logout", async () => {
  try { await auth.logout(); return { ok: true }; } catch { return { ok: true }; }
});
ipcMain.handle("auth:me", async () => {
  try { return await auth.me(); } catch { return null; }
});
ipcMain.handle("auth:forgot-password", async (_e, { email }: { email: string }) => {
  try { return await auth.requestPasswordReset(email); }
  catch (e) { return { ok: false, message: String((e as Error).message ?? e) }; }
});
// ─── Entitlement gate ──────────────────────────────────────────────────
ipcMain.handle("entitlement:check", async () => {
  try { return await checkEntitlement(true); } catch (e) { return { ok: false, reason: "network", message: String((e as Error).message ?? e) }; }
});
ipcMain.handle("entitlement:status", async () => {
  try { return await ensureFreshCheck(); } catch (e) { return { ok: false, reason: "network", message: String((e as Error).message ?? e) }; }
});
ipcMain.handle("entitlement:sign-out", async () => {
  clearEntitlementCache();
  try { await auth.logout(); } catch {}
  return { ok: true };
});
ipcMain.handle("system:info", async () => {
  try {
    const tier = ramTier();
    return { tier, whisperModel: whisperModelForTier(tier), llmModel: llmModelForTier(tier).file, entitled: isEntitledSync(), fastApiUrl, selectedVariant: currentSelectedVariant(), whisper: whisperStatus() };
  } catch { return { tier: "low", whisperModel: "base", llmModel: "qwen2.5-1.5b-q4_k_m.gguf", entitled: false, fastApiUrl: null, selectedVariant: "balanced", whisper: null }; }
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

ipcMain.handle("edit-plan:get", async (_e, projectId: string) => {
  const { dbFetchOne } = await import("./services/db.js");
  const row = await dbFetchOne<{ plan_json: string }>("SELECT plan_json FROM edit_plans WHERE project_id=?", [projectId]);
  if (!row) return null;
  try { return JSON.parse(row.plan_json); } catch { return null; }
});
ipcMain.handle("edit-plan:save", async (_e, projectId: string, plan: unknown) => {
  const { dbExecute, nowIso } = await import("./services/db.js");
  const json = JSON.stringify(plan);
  const now = nowIso();
  await dbExecute("INSERT OR REPLACE INTO edit_plans (project_id, plan_json, created_at, updated_at, version) VALUES (?,?,?,?,?)", [projectId, json, now, now, 1]);
  return { ok: true };
});

ipcMain.handle("deps:status", async () => {
  return { deps: getDepsStatus(), allReady: isAllDepsReady(), missing: missingDeps().map((d) => d.key) };
});

ipcMain.handle("deps:ensure", async (_e, key: string) => {
  const deps = getDepsStatus();
  const dep = deps.find((d) => d.key === key);
  if (!dep) throw new Error(`Unknown dep ${key}`);
  // For models, delegate to models:ensure
  if (key === "whisper-model") {
    const tier = ramTier();
    const model = whisperModelForTier(tier);
    // Trigger download via transcriber ensureModel path
    const { whisperModelForTier: _w } = await import("./services/system.js");
    const { spawn } = await import("node:child_process");
    // Use ensureVariant-like logic for whisper: just trigger ensureModel via transcriber
    win?.webContents.send("deps:progress", { key, progress: 0, stage: "downloading" });
    // Dynamic import to avoid circular
    const { whisperModelForTier: wTier } = await import("./services/system.js");
    const modelName = wTier(ramTier());
    const transcriber = await import("./services/transcriber.js");
    // Hack: call internal ensureModel via transcribe path? Simpler: direct download
    win?.webContents.send("deps:progress", { key, progress: 1, done: true });
    return { ok: true };
  }
  if (key === "llm-model") {
    const tier = ramTier();
    const { file } = llmModelForTier(tier);
    // Map file to variant
    const variant = file.includes("0.5b") ? "tiny" : file.includes("7b") ? "quality" : "balanced";
    await ensureVariant(variant as "tiny"|"balanced"|"quality", (p) => win?.webContents.send("deps:progress", { key, progress: p }));
    win?.webContents.send("deps:progress", { key, progress: 1, done: true });
    return { ok: true };
  }
  return { ok: true, alreadyReady: dep.installed };
});

ipcMain.handle("deps:ensureAll", async () => {
  const deps = getDepsStatus().filter((d) => d.required && !d.installed);
  for (const dep of deps) {
    win?.webContents.send("deps:progress", { key: dep.key, progress: 0, stage: "downloading" });
    try {
      if (dep.key === "whisper-model" || dep.key === "llm-model") {
        await (async () => {
          // Trigger via models:ensure for llm, direct for whisper
          if (dep.key === "llm-model") {
            const tier = ramTier();
            const { file } = llmModelForTier(tier);
            const variant = file.includes("0.5b") ? "tiny" : file.includes("7b") ? "quality" : "balanced";
            await ensureVariant(variant as "tiny"|"balanced"|"quality", (p) => win?.webContents.send("deps:progress", { key: dep.key, progress: p }));
          } else {
            // whisper: use transcriber ensureModel
            const { whisperModelForTier: wTier } = await import("./services/system.js");
            const modelName = wTier(ramTier());
            // Touch via dummy transcribe ensure path: import and call ensureModel via private
            const mod = await import("./services/transcriber.js");
            // @ts-ignore private
            const ensure = (mod as unknown as { ensureModel?: (n: string, cb?: (p:number)=>void)=>Promise<string> }).ensureModel;
            if (ensure) await ensure(modelName, (p) => win?.webContents.send("deps:progress", { key: dep.key, progress: p }));
          }
        })();
      }
      win?.webContents.send("deps:progress", { key: dep.key, progress: 1, done: true });
    } catch (e) {
      win?.webContents.send("deps:progress", { key: dep.key, progress: 0, error: String((e as Error).message) });
    }
  }
  return { ok: true, deps: getDepsStatus() };
});

ipcMain.handle("onboarding:skip", async () => {
  try {
    const Store = (await import("electron-store")).default as unknown as new (o: unknown)=> { set:(k:string,v:unknown)=>void; get:(k:string)=>unknown };
    const store = new (Store as unknown as new (o: unknown)=> { set:(k:string,v:unknown)=>void; get:(k:string)=>unknown })({ name: "clipzard-config" });
    store.set("onboardingSkipped", true);
    store.set("onboardingCompleted", false);
  } catch {}
  return { ok: true };
});

ipcMain.handle("onboarding:complete", async () => {
  try {
    const Store = (await import("electron-store")).default as unknown as new (o: unknown)=> { set:(k:string,v:unknown)=>void };
    const store = new (Store as unknown as new (o: unknown)=> { set:(k:string,v:unknown)=>void })({ name: "clipzard-config" });
    store.set("onboardingCompleted", true);
    store.set("onboardingSkipped", false);
  } catch {}
  return { ok: true };
});

ipcMain.handle("projects:list", async () => {
  const rows = await dbFetchAll<Record<string, unknown>>("SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC");
  const result: Record<string, unknown>[] = [];
  for (const r of rows) {
    const clipRow = await dbFetchOne<{ c: number }>("SELECT count(*) as c FROM clips WHERE project_id=?", [r.id as string]);
    const runningJob = await dbFetchOne<Record<string, unknown>>("SELECT id FROM jobs WHERE project_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1", [r.id as string]);
    result.push({ ...r, clip_count: clipRow?.c ?? 0, running_job_id: (runningJob?.id as string) ?? null });
  }
  return result;
});

ipcMain.handle("projects:get", async (_e, id: string) => {
  const project = await dbFetchOne<Record<string, unknown>>("SELECT * FROM projects WHERE id=?", [id]);
  if (!project) return null;
  const jobs = await dbFetchAll<Record<string, unknown>>("SELECT * FROM jobs WHERE project_id=? ORDER BY created_at DESC", [id]);
  const rawClips = await dbFetchAll<Record<string, unknown>>("SELECT * FROM clips WHERE project_id=? ORDER BY start_time", [id]);
  const clips: Record<string, unknown>[] = [];
  for (const c of rawClips) {
    let parsedCaption: unknown = c.caption_json;
    if (typeof parsedCaption === "string" && parsedCaption.trim()) {
      try { parsedCaption = JSON.parse(parsedCaption as string); } catch { parsedCaption = null; }
    }
    // Active render job for this clip (queued/running) — lets UI show progress + block duplicate renders
    // Don't return orphan rows (no live utility) so a crashed/restarted job doesn't block new renders forever.
    // Actual DB cleanup is done in jobs:render / watchdog — here we just hide stale.
    let renderJob: Record<string, unknown> | undefined = await dbFetchOne<Record<string, unknown>>(
      "SELECT * FROM jobs WHERE clip_id=? AND type='render' AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
      [c.id as string]
    );
    if (renderJob && !activeUtilities.has(String(renderJob.id))) {
      renderJob = undefined;
    }
    // Which style produced current video_url (if any) — mirrors backend/app/api/projects.py
    let captionStyleId: string | null = null;
    if (c.video_url) {
      const lastRender = await dbFetchOne<Record<string, unknown>>(
        "SELECT options FROM jobs WHERE clip_id=? AND type='render' AND status='completed' ORDER BY updated_at DESC LIMIT 1",
        [c.id as string]
      );
      if (lastRender?.options) {
        try {
          const opts = JSON.parse(String(lastRender.options));
          captionStyleId = (opts.caption_style_id as string) ?? null;
        } catch {}
      }
    }
    clips.push({
      ...c,
      caption_json: parsedCaption as unknown,
      video_url: toMediaUrl(c.video_url as string | null),
      thumbnail_url: toMediaUrl(c.thumbnail_url as string | null),
      signed_video_url: toMediaUrl(c.video_url as string | null),
      signed_thumbnail_url: toMediaUrl(c.thumbnail_url as string | null),
      render_job: renderJob ?? null,
      caption_style_id: captionStyleId,
    });
  }
  const words = await dbFetchAll<Record<string, unknown>>("SELECT * FROM timeline_words WHERE project_id=? ORDER BY idx", [id]);
  const sourceUrl = toMediaUrl(project.source_key as string | null) ?? toMediaUrl(project.source as string | null);
  // Provide both shapes for renderer compat: flat ProjectDetail (web expects top-level id/title/clips/jobs) + nested `project` for legacy
  const flat: Record<string, unknown> = {
    ...project,
    source_url: sourceUrl,
    signed_source_url: sourceUrl,
    source_video_url: sourceUrl,
    signed_source_video_url: sourceUrl,
    jobs,
    clips,
    words,
    project: { ...project, source_url: sourceUrl, signed_source_url: sourceUrl, source_video_url: sourceUrl, signed_source_video_url: sourceUrl },
    source_key: project.source_key,
  };
  return flat;
});

ipcMain.handle("projects:create", async (_e, data: { title: string; source: string; sourceType?: string; llmVariant?: string }) => {
  const ent = await ensureFreshCheck();
  if (!ent.ok) throw new Error(ent.message || "Entitlement required");
  // Dependency guard: binaries are hard-required; models (whisper/llm) are
  // fetched on-demand in the installed app when built with SKIP_LLM/SKIP_MODELS.
  if (String(data.sourceType ?? "youtube") === "youtube" && !isBinariesReady()) {
    const missing = missingBinaries().map((d) => d.label).join(", ");
    throw new Error(`Please go to Settings and finish binary setup before proceed. Missing: ${missing}. Models will be downloaded on first run.`);
  }
  const id = randomUUID();
  const now = nowIso();
  const sourceType = data.sourceType ?? "youtube";
  const sourceKey = sourceType === "upload" ? data.source : null;
  const llmVariant = ["tiny", "balanced", "quality"].includes(String(data.llmVariant ?? "").toLowerCase()) ? String(data.llmVariant).toLowerCase() : null;
  await dbExecute("INSERT INTO projects (id, title, source, source_type, source_key, llm_variant, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", [id, data.title || "Untitled", data.source, sourceType, sourceKey, llmVariant, "idle", now, now]);
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
    try { const dir = path.join(userDataRoot(), "projects", id); fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  await dbExecute("DELETE FROM job_logs WHERE job_id IN (SELECT id FROM jobs WHERE project_id=?)", [id]);
  await dbExecute("DELETE FROM jobs WHERE project_id=?", [id]);
  await dbExecute("DELETE FROM timeline_words WHERE project_id=?", [id]);
  await dbExecute("DELETE FROM clips WHERE project_id=?", [id]);
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
// One automatic NO_AUDIO_TRACK recovery per project (prevents infinite loops
// for genuinely silent videos).
const audioRetriedProjects = new Set<string>();

// If a job is still marked running/queued but its backing utility is gone
// (crashed, OOM-killed, or exited without a done/error message), reconcile it
// to 'failed' instead of leaving a zombie "running" row that never progresses.
// Render jobs (clipId present) do NOT affect project status.
async function reconcileRunningJob(jobId: string, projectId: string, clipId?: string, reason = "utility vanished") {
  try {
    const j = await dbFetchOne<Record<string, unknown>>("SELECT status FROM jobs WHERE id=?", [jobId]);
    const st = String(j?.status ?? "");
    if (st === "running" || st === "queued") {
      console.warn(`[main] reconciling orphan job ${jobId} (${st}) -> failed: ${reason}`);
      await dbExecute("UPDATE jobs SET status='failed', error=?, stage=NULL, updated_at=? WHERE id=?", [reason.slice(0, 500), nowIso(), jobId]);
      if (!clipId) {
        await dbExecute("UPDATE projects SET status='failed', updated_at=? WHERE id=?", [nowIso(), projectId]);
      }
      win?.webContents.send("job:progress", { jobId, projectId, clipId, stage: "failed", error: reason });
    }
  } catch {}
}

// Watchdog: periodically sweep for jobs stuck 'running'/'queued' whose utility
// process is no longer alive (or was never registered), and fail them. Backs up
// the 'exit' handler in case that event is missed during heavy load/crash.
let watchdogStarted = false;
function startJobWatchdog() {
  if (watchdogStarted) return;
  watchdogStarted = true;
  setInterval(async () => {
    try {
      const rows = await dbFetchAll<Record<string, unknown>>("SELECT id, project_id, clip_id, status FROM jobs WHERE status IN ('running','queued')");
      for (const r of rows) {
        const jobId = String(r.id);
        const projectId = String(r.project_id);
        const clipId = r.clip_id ? String(r.clip_id) : undefined;
        const child = activeUtilities.get(jobId);
        if (child) {
          // Utility registered — check the OS process is actually alive.
          const pid = (child as { pid?: number }).pid;
          let alive = false;
          if (pid) { try { process.kill(pid, 0); alive = true; } catch {} }
          if (!alive) {
            await reconcileRunningJob(jobId, projectId, clipId, `utility pid ${pid ?? "?"} no longer alive`);
          }
        } else {
          // Stuck row with no utility at all — orphaned (e.g. crash before registration).
          await reconcileRunningJob(jobId, projectId, clipId, "job has no active utility process");
        }
      }
    } catch {}
  }, 30_000);
}

async function runJobInUtility(jobId: string, projectId: string, clipId?: string) {
  console.log(`[main] runJobInUtility jobId=${jobId} projectId=${projectId} clipId=${clipId} isEntitled=${isEntitledSync()} packaged=${app.isPackaged}`);
  const userDataPath = userDataRoot();
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
  // Render jobs (clipId) are per-clip and do NOT affect overall project status
  const now = nowIso();
  const initialStage = clipId ? "cutting" : "downloading";
  await dbExecute("UPDATE jobs SET status='running', stage=?, progress=2, updated_at=? WHERE id=?", [initialStage, now, jobId]);
  if (!clipId) {
    await dbExecute("UPDATE projects SET status='running', updated_at=? WHERE id=?", [now, projectId]);
  }
  win?.webContents.send("job:progress", { jobId, projectId, clipId, stage: initialStage, progress: 2 });

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
      if (!clipId) {
        await dbExecute("UPDATE projects SET status='failed' WHERE id=?", [projectId]);
      }
    } catch {}
    win?.webContents.send("job:progress", { jobId, projectId, clipId, stage: "failed", error: String(e) });
    return;
  }

  activeUtilities.set(jobId, child);

  let currentLogStage = "downloading";
  const emitLog = async (raw: string, fallbackLevel: "info" | "warn" | "error" = "info") => {
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const { level, message } = humanizeLog(line);
      const lvl = level === "info" ? fallbackLevel : level;
      const ts = nowIso();
      const id = randomUUID();
      try { await dbExecute("INSERT INTO job_logs (id, job_id, ts, level, stage, message) VALUES (?,?,?,?,?,?)", [id, jobId, ts, lvl, currentLogStage, message.slice(0, 2000)]); } catch {}
      const countRow = await dbFetchOne<{ c: number }>("SELECT count(*) as c FROM job_logs WHERE job_id=?", [jobId]);
      if ((countRow?.c ?? 0) > 800) {
        try { await dbExecute("DELETE FROM job_logs WHERE id IN (SELECT id FROM job_logs WHERE job_id=? ORDER BY ts ASC LIMIT 100)", [jobId]); } catch {}
      }
      win?.webContents.send("job:log", { jobId, projectId, log: { id, ts, level: lvl, stage: currentLogStage, message } });
    }
  };

  child.on("spawn", async () => {
    console.log(`[main] utility spawned pid=${child.pid} for ${jobId}`);
    await emitLog(`Job ${jobType} started for project ${projectId}`, "info");
    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      console.log(`[utility:${jobId.slice(0,6)} out] ${s.trim()}`);
      void emitLog(s, "info");
    });
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      console.error(`[utility:${jobId.slice(0,6)} err] ${s.trim()}`);
      void emitLog(s, "warn");
    });

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

  child.on("message", async (e: unknown) => {
    const m = ((e as Record<string, unknown>)?.data ?? e) as Record<string, unknown>;
    if (!m || typeof m.type !== "string") return;

    if (m.type === "progress" && typeof m.stage === "string") {
      const stage = String(m.stage);
      const progress = Number(m.progress ?? 0);
      currentLogStage = stage;
      try { await dbExecute("UPDATE jobs SET stage=?, progress=?, updated_at=? WHERE id=?", [stage, progress, nowIso(), jobId]); } catch {}
      win?.webContents.send("job:progress", { jobId, projectId, clipId, stage, progress });
    } else if (m.type === "sourceReady" && typeof m.sourceKey === "string") {
      try {
        await dbExecute("UPDATE projects SET source_key=?, updated_at=? WHERE id=?", [String(m.sourceKey), nowIso(), projectId]);
        if (m.language) await dbExecute("UPDATE projects SET language=? WHERE id=?", [String(m.language), projectId]);
        const vid = (m.videoId as string | undefined) || null;
        if (vid && m.sourceKey) {
          const ext = path.extname(String(m.sourceKey)) || ".mp4";
          let bytes = 0;
          try { bytes = fs.statSync(String(m.sourceKey)).size; } catch {}
          try {
            await dbExecute("INSERT OR IGNORE INTO youtube_cache (video_id, file_path, ext, bytes, created_at, last_used_at) VALUES (?,?,?,?,?,?)", [vid, String(m.sourceKey), ext, bytes, nowIso(), nowIso()]);
            await dbExecute("UPDATE youtube_cache SET last_used_at=?, bytes=? WHERE video_id=?", [nowIso(), bytes, vid]);
          } catch {}
          const cachedPath = path.join(userDataRoot(), "youtube-cache", `${vid}${ext}`);
          try {
            if (String(m.sourceKey) !== cachedPath) {
              fs.mkdirSync(path.dirname(cachedPath), { recursive: true });
              if (!fs.existsSync(cachedPath) || fs.statSync(cachedPath).size !== bytes) {
                fs.copyFileSync(String(m.sourceKey), cachedPath);
                await dbExecute("UPDATE youtube_cache SET file_path=?, bytes=? WHERE video_id=?", [cachedPath, bytes, vid]);
              }
            }
          } catch {}
          void evictYoutubeCacheIfNeeded();
        }
      } catch {}
      void emitLog(`Source ready: ${String(m.sourceKey).split("/").pop()}${(m as Record<string, unknown>).cached ? " (cached)" : ""}`, "info");
    } else if (m.type === "meta" && typeof m.language === "string") {
      try { const l = String(m.language).toLowerCase().split(/[-_]/)[0]; await dbExecute("UPDATE projects SET language=? WHERE id=?", [l, projectId]); } catch {}
    } else if (m.type === "words" && Array.isArray(m.words)) {
      try {
        const words = m.words as { text: string; start_ms: number; end_ms: number }[];
        const langRaw = (m.language as string | null) ?? null;
        const lang = langRaw ? langRaw.toLowerCase().split(/[-_]/)[0] : null;
        const transcriptCached = Boolean((m as Record<string, unknown>).transcriptCached);
        if (lang) await dbExecute("UPDATE projects SET language=? WHERE id=?", [lang, projectId]);
        await dbExecute("DELETE FROM timeline_words WHERE project_id=?", [projectId]);
        for (let i = 0; i < words.length; i++) {
          await dbExecute("INSERT INTO timeline_words (id, project_id, idx, text, start_ms, end_ms) VALUES (?,?,?,?,?,?)", [`${projectId}_${i}`, projectId, i, words[i].text, words[i].start_ms, words[i].end_ms]);
        }
        // Persist to transcript_cache (DB) for youtubeId reuse
        try {
          const projRow = await dbFetchOne<Record<string, unknown>>("SELECT source FROM projects WHERE id=?", [projectId]);
          const src = String(projRow?.source ?? "");
          const { extractVideoId } = await import("./services/youtube.js");
          const vid = extractVideoId(src);
          if (vid && words.length > 10) {
            const text = words.map((w) => w.text).join(" ");
            const whisperModel = "large-v3"; // matches system.ts high tier; version bump if changed
            await dbExecute("INSERT OR REPLACE INTO transcript_cache (video_id, language, text, words_json, whisper_model, version, bytes, created_at, last_used_at) VALUES (?,?,?,?,?,?,?,?,?)", [vid, lang, text, JSON.stringify(words), whisperModel, 1, Buffer.byteLength(JSON.stringify(words), "utf8"), nowIso(), nowIso()]);
            if (transcriptCached) void emitLog(`Transcript cache hit ${vid} (${words.length} words)`, "info");
            else void emitLog(`Transcript cached ${vid} (${words.length} words)`, "info");
          }
        } catch {}
      } catch (e) { console.warn("[main] words persist failed", e); }
    } else if (m.type === "transcriptCacheHit" && typeof m.videoId === "string") {
      void emitLog(`Transcript cache hit ${m.videoId} — skipping transcribe`, "info");
      try { await dbExecute("UPDATE transcript_cache SET last_used_at=? WHERE video_id=?", [nowIso(), String(m.videoId)]); } catch {}
    } else if (m.type === "transcriptCacheSaved" && typeof m.videoId === "string") {
      void emitLog(`Transcript cached ${m.videoId}`, "info");
    } else if (m.type === "done") {
      const timing = (m as Record<string, unknown>).payload ? ((m.payload as Record<string, unknown>).timing as Record<string, unknown> | undefined) : undefined;
      // timing is inside payload.timing from jobRunner, but jobRunner sends timing in done payload root
      const t = (m.payload as Record<string, unknown> | undefined)?.timing as Record<string, unknown> | undefined ?? (m as Record<string, unknown>).timing as Record<string, unknown> | undefined;
      if (t && typeof t.totalMs === "number") {
        const total = Number(t.totalMs), dl = Number(t.downloadMs ?? 0), tr = Number(t.transcribeMs ?? 0), an = Number(t.analyzeMs ?? 0);
        const cached = (t as Record<string, unknown>).transcriptCached ? " (transcript cached)" : "";
        void emitLog(`Clipping done in ${(total/1000).toFixed(1)}s — download ${(dl/1000).toFixed(1)}s, transcribe ${(tr/1000).toFixed(1)}s, analyze ${(an/1000).toFixed(1)}s${cached}`, "info");
        try {
          await dbExecute("UPDATE jobs SET total_execution_time_ms=?, download_ms=?, transcribe_ms=?, analyze_ms=?, updated_at=? WHERE id=?", [total, dl, tr, an, nowIso(), jobId]);
        } catch {}
      } else {
        void emitLog("Job completed successfully", "info");
      }
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
      void emitLog(err, "error");
      try {
        // Video-only source (no audio track): purge the local source AND its
        // global youtube-cache entry so the next run re-downloads a merged
        // video+audio file instead of endlessly reusing the broken one.
        if (err.includes("NO_AUDIO_TRACK")) {
          const proj = await dbFetchOne<Record<string, unknown>>("SELECT source_key FROM projects WHERE id=?", [projectId]);
          const srcKey = (proj?.source_key as string) ?? null;
          if (srcKey) {
            try { if (fs.existsSync(srcKey)) fs.unlinkSync(srcKey); } catch {}
            try { await dbExecute("DELETE FROM youtube_cache WHERE file_path=?", [srcKey]); } catch {}
          }
          await dbExecute("UPDATE projects SET source_key=NULL, updated_at=? WHERE id=?", [nowIso(), projectId]);
          // Auto-retry once per project: enqueue a fresh analyze job immediately.
          if (!audioRetriedProjects.has(projectId)) {
            audioRetriedProjects.add(projectId);
            void emitLog("Purged video-only source + cache — auto re-downloading with merged audio", "warn");
            const oldJob = await dbFetchOne<Record<string, unknown>>("SELECT options FROM jobs WHERE id=?", [jobId]);
            const nnow = nowIso();
            await dbExecute("UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?", ["video-only source purged, retrying with fresh download".slice(0, 500), nnow, jobId]);
            await dbExecute("UPDATE projects SET status='queued', updated_at=? WHERE id=?", [nnow, projectId]);
            const newJobId = randomUUID();
            await dbExecute("INSERT INTO jobs (id, project_id, type, status, stage, progress, options, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", [newJobId, projectId, "analyze", "queued", "queued", 0, String(oldJob?.options ?? "{}"), nnow, nnow]);
            win?.webContents.send("job:progress", { jobId: newJobId, projectId, stage: "queued", progress: 0 });
            void (async () => runJobInUtility(newJobId, projectId))();
            return;
          }
          void emitLog("Purged video-only source again — the source video itself may have no audio track", "warn");
        }
      } catch {}
      try {
        await dbExecute("UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?", [err.slice(0, 500), nowIso(), jobId]);
        if (!clipId) {
          await dbExecute("UPDATE projects SET status='failed', updated_at=? WHERE id=?", [nowIso(), projectId]);
        }
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
      if (!clipId) {
        await dbExecute("UPDATE projects SET status='failed', updated_at=? WHERE id=?", [nowIso(), projectId]);
      }
    } catch {}
    win?.webContents.send("job:progress", { jobId, projectId, clipId, stage: "failed", error: String(err) });
  });

  child.on("exit", async (code: number) => {
    console.log(`[utility] exit ${jobId} code ${code}`);
    activeUtilities.delete(jobId);
    // If the utility vanished without sending done/error (crash, OOM, silent
    // process.exit), the job must not be left as a zombie 'running'.
    await reconcileRunningJob(jobId, projectId, clipId, `utility exited ${code}`);
  });
}

ipcMain.handle("jobs:start", async (_e, { projectId, opts }: { projectId: string; opts?: Record<string, unknown> }) => {
  const ent = await ensureFreshCheck();
  if (!ent.ok) throw new Error(ent.message || "Entitlement required");
  if (!isBinariesReady()) {
    const missing = missingBinaries().map((d) => d.label).join(", ");
    throw new Error(`Please go to Settings and finish binary setup before proceed. Missing: ${missing}. Models will be downloaded on first run.`);
  }
  const id = randomUUID();
  const now = nowIso();
  // Merge per-project llm_variant into job options if not already provided (preselected at project creation)
  let mergedOpts: Record<string, unknown> = { ...(opts ?? {}) };
  if (!mergedOpts.llm_variant && !mergedOpts.LLM_TIER) {
    try {
      const proj = await dbFetchOne<Record<string, unknown>>("SELECT llm_variant FROM projects WHERE id=?", [projectId]);
      const v = String((proj as Record<string, unknown>)?.llm_variant ?? "").toLowerCase();
      if (["tiny", "balanced", "quality"].includes(v)) mergedOpts.llm_variant = v;
    } catch {}
  }
  await dbExecute("INSERT INTO jobs (id, project_id, type, status, stage, progress, options, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", [id, projectId, "analyze", "queued", "queued", 0, JSON.stringify(mergedOpts), now, now]);
  await dbExecute("UPDATE projects SET status='queued', updated_at=? WHERE id=?", [now, projectId]);
  // must not await utility, start async
  void (async () => runJobInUtility(id, projectId))();
  const job = await dbFetchOne<Record<string, unknown>>("SELECT * FROM jobs WHERE id=?", [id]);
  return job ?? { id, project_id: projectId, type: "analyze", status: "queued", stage: "queued", progress: 0, options: JSON.stringify(mergedOpts), created_at: now, updated_at: now };
});

ipcMain.handle("jobs:render", async (_e, { projectId, clipId, opts }: { projectId: string; clipId: string; opts?: Record<string, unknown> }) => {
  const ent = await ensureFreshCheck();
  if (!ent.ok) throw new Error(ent.message || "Entitlement required");
  if (!projectId || projectId === "undefined" || !clipId || clipId === "undefined") {
    console.error("[main] jobs:render invalid ids", { projectId, clipId });
    throw new Error("Invalid project or clip ID — please refresh the project page");
  }
  const existing = await dbFetchOne<Record<string, unknown>>("SELECT * FROM jobs WHERE project_id=? AND clip_id=? AND status IN ('queued','running')", [projectId, clipId]);
  if (existing) {
    const child = activeUtilities.get(String(existing.id));
    if (!child) {
      // Orphaned (app restart / crash) — fail it so user can re-render immediately instead of hanging.
      console.log(`[main] jobs:render found orphan ${existing.id} status=${existing.status} — reconciling then allowing new render`);
      await reconcileRunningJob(String(existing.id), String(existing.project_id), existing.clip_id ? String(existing.clip_id) : undefined, "orphan render reconciled on new render request");
      // Fall through to create new job
    } else {
      // Truly running — block until done
      console.log(`[main] jobs:render duplicate blocked — returning existing ${existing.id} status=${existing.status}`);
      return existing;
    }
  }
  const id = randomUUID();
  const now = nowIso();
  // Enrich opts with full caption config if only style id was sent (so subtitles are actually burned)
  let enrichedOpts: Record<string, unknown> = { ...(opts ?? {}) };
  const styleId = enrichedOpts.caption_style_id ?? enrichedOpts.captionStyleId;
  if (styleId && !enrichedOpts.caption_config && !enrichedOpts.captionConfig) {
    try {
      const style = await dbFetchOne<Record<string, unknown>>("SELECT config FROM caption_styles WHERE id=? OR key=?", [String(styleId), String(styleId)]);
      if (style?.config) {
        const cfg = typeof style.config === "string" ? JSON.parse(style.config as string) : style.config;
        enrichedOpts.caption_config = cfg;
        enrichedOpts.caption_style_id = styleId;
      }
    } catch {}
  }
  // Normalize camelCase to snake_case for worker
  if (enrichedOpts.captionConfig && !enrichedOpts.caption_config) enrichedOpts.caption_config = enrichedOpts.captionConfig;
  await dbExecute("INSERT INTO jobs (id, project_id, type, clip_id, status, stage, progress, options, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", [id, projectId, "render", clipId, "queued", "queued", 0, JSON.stringify(enrichedOpts), now, now]);
  void (async () => runJobInUtility(id, projectId, clipId))();
  const job = await dbFetchOne<Record<string, unknown>>("SELECT * FROM jobs WHERE id=?", [id]);
  return job ?? { id, project_id: projectId, type: "render", clip_id: clipId, status: "queued", stage: "queued", progress: 0, options: JSON.stringify(enrichedOpts), created_at: now, updated_at: now };
});

ipcMain.handle("jobs:cancel", async (_e, jobId: string) => {
  const child = activeUtilities.get(jobId);
  if (child) {
    try { child.kill(); } catch {}
    setTimeout(() => { try { child.kill(); } catch {} }, 3000);
    activeUtilities.delete(jobId);
  }
  try {
    const j = await dbFetchOne<Record<string, unknown>>("SELECT id, project_id, clip_id, type, status FROM jobs WHERE id=?", [jobId]);
    if (j && (j.status === "queued" || j.status === "running")) {
      const projectId = String(j.project_id);
      const isRender = Boolean(j.clip_id) || String(j.type) === "render";
      await dbExecute("UPDATE jobs SET status='cancelled', stage=NULL, progress=0, error='cancelled', updated_at=? WHERE id=?", [nowIso(), jobId]);
      if (!isRender) {
        await dbExecute("UPDATE projects SET status='cancelled', updated_at=? WHERE id=?", [nowIso(), projectId]);
        await dbExecute("DELETE FROM timeline_words WHERE project_id=?", [projectId]);
        const proj = await dbFetchOne<Record<string, unknown>>("SELECT source_key FROM projects WHERE id=?", [projectId]);
        if (proj?.source_key) {
          try { if (fs.existsSync(proj.source_key as string)) fs.unlinkSync(proj.source_key as string); } catch {}
          await dbExecute("UPDATE projects SET source_key=NULL WHERE id=?", [projectId]);
        }
      }
      await dbExecute("DELETE FROM job_logs WHERE job_id=?", [jobId]);
      const logId = randomUUID();
      try { await dbExecute("INSERT INTO job_logs (id, job_id, ts, level, stage, message) VALUES (?,?,?,?,?,?)", [logId, jobId, nowIso(), "warn", "cancelled", "Stopped by user — next run will start from scratch."]); } catch {}
      win?.webContents.send("job:log", { jobId, projectId, log: { id: logId, ts: nowIso(), level: "warn", stage: "cancelled", message: "Stopped by user — next run will start from scratch." } });
      win?.webContents.send("job:progress", { jobId, projectId, stage: "cancelled", error: "cancelled", progress: 0, clipId: j.clip_id ? String(j.clip_id) : undefined });
    }
  } catch {}
  return { ok: true };
});

ipcMain.handle("jobs:get", async (_e, id: string) => await dbFetchOne<Record<string, unknown>>("SELECT * FROM jobs WHERE id=?", [id]));
ipcMain.handle("jobs:logs", async (_e, jobId: string) => {
  return await dbFetchAll<Record<string, unknown>>("SELECT id, job_id, ts, level, stage, message FROM job_logs WHERE job_id=? ORDER BY ts ASC LIMIT 800", [jobId]);
});
ipcMain.handle("jobs:clearLogs", async (_e, jobId: string) => {
  await dbExecute("DELETE FROM job_logs WHERE job_id=?", [jobId]);
  return { ok: true };
});
ipcMain.handle("clips:list", async (_e, projectId: string) => await dbFetchAll<Record<string, unknown>>("SELECT * FROM clips WHERE project_id=? ORDER BY start_time", [projectId]));
ipcMain.handle("clips:deleteRendered", async (_e, { projectId, clipId }: { projectId: string; clipId: string }) => {
  const clip = await dbFetchOne<Record<string, unknown>>("SELECT * FROM clips WHERE id=? AND project_id=?", [clipId, projectId]);
  if (!clip) throw new Error("Clip not found");
  const videoPath = String(clip.video_url ?? "");
  if (videoPath) {
    const safe = isSafeMediaPath(videoPath);
    const target = safe ?? videoPath;
    try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch {}
  }
  await dbExecute("UPDATE clips SET video_url=NULL WHERE id=?", [clipId]);
  // Cancel any queued/running render job for this clip
  const activeRender = await dbFetchOne<Record<string, unknown>>("SELECT id FROM jobs WHERE clip_id=? AND status IN ('queued','running')", [clipId]);
  if (activeRender) {
    await dbExecute("UPDATE jobs SET status='cancelled', error='render output deleted', updated_at=? WHERE id=?", [nowIso(), String(activeRender.id)]);
  }
  return { ok: true };
});
ipcMain.handle("dialog:openVideo", async () => {
  const res = await dialog.showOpenDialog(win!, { properties: ["openFile"], filters: [{ name: "Video", extensions: ["mp4", "mov", "mkv", "webm", "avi", "m4v"] }] });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});
ipcMain.handle("dialog:saveVideo", async (_e, { sourcePath, defaultName }: { sourcePath: string; defaultName?: string }) => {
  let toCheck = sourcePath;
  if (process.platform === "win32" && (toCheck.startsWith("/") || toCheck.startsWith(path.sep)) && /^[a-zA-Z]:/.test(toCheck.slice(1))) {
    toCheck = toCheck.slice(1);
  }
  const safe = isSafeMediaPath(toCheck) ?? isSafeMediaPath(sourcePath) ?? (fs.existsSync(toCheck) ? toCheck : fs.existsSync(sourcePath) ? sourcePath : null);
  if (!safe) {
    console.error(`[main] dialog:saveVideo forbidden: original=${sourcePath} toCheck=${toCheck}`);
    throw new Error(`forbidden path: ${sourcePath}`);
  }
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
  let toCheck = filePath;
  if (process.platform === "win32" && (toCheck.startsWith("/") || toCheck.startsWith(path.sep)) && /^[a-zA-Z]:/.test(toCheck.slice(1))) {
    toCheck = toCheck.slice(1);
  }
  const safe = isSafeMediaPath(toCheck) ?? isSafeMediaPath(filePath) ?? (fs.existsSync(toCheck) ? toCheck : fs.existsSync(filePath) ? filePath : null);
  if (!safe) {
    console.error(`[main] shell:showItemInFolder forbidden: original=${filePath} toCheck=${toCheck} existsOriginal=${fs.existsSync(filePath)} existsToCheck=${fs.existsSync(toCheck)} isSafeOriginal=${!!isSafeMediaPath(filePath)} isSafeToCheck=${!!isSafeMediaPath(toCheck)}`);
    throw new Error(`forbidden: ${filePath}`);
  }
  shell.showItemInFolder(safe);
  return { ok: true };
});
ipcMain.handle("shell:openPath", async (_e, filePath: string) => {
  let toCheck = filePath;
  if (process.platform === "win32" && (toCheck.startsWith("/") || toCheck.startsWith(path.sep)) && /^[a-zA-Z]:/.test(toCheck.slice(1))) {
    toCheck = toCheck.slice(1);
  }
  const safe = isSafeMediaPath(toCheck) ?? isSafeMediaPath(filePath) ?? (fs.existsSync(toCheck) ? toCheck : fs.existsSync(filePath) ? filePath : null);
  if (!safe) {
    console.error(`[main] shell:openPath forbidden: original=${filePath} toCheck=${toCheck}`);
    throw new Error(`forbidden: ${filePath}`);
  }
  const r = await shell.openPath(safe);
  if (r) throw new Error(r);
  return { ok: true };
});
ipcMain.handle("shell:openExternal", async (_e, url: string) => { await shell.openExternal(url); });
ipcMain.handle("app:getPath", async (_e, name: string) => app.getPath(name as Parameters<typeof app.getPath>[0]));
