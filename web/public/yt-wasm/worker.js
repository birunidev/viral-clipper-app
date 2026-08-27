// Pyodide worker – adapted from https://forgejo.phillippepelzer.me/FiLL/yt-dlp-wasm/worker.js
// Boots Pyodide, installs yt-dlp cached in IndexedDB, applies network_patch via proxy, exposes extract() + mux()

importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js");

const post = (msg) => self.postMessage(msg);
const logToMain = (s) => post({ type: "log", payload: s });

let pyodide;
let pyExtract;
let ffmpeg = null;

let metadataProxy = "";
let bootPromise = null;

const DB_NAME = "ytdlp-wasm-cache";
const STORE = "wheels";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function cacheGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function cachePut(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function installYtDlp() {
  const KEY = "yt-dlp-wheel";
  const cached = await cacheGet(KEY);
  let bytes, version;
  if (cached?.bytes && cached?.version) {
    bytes = cached.bytes;
    version = cached.version;
    logToMain(`Using cached yt-dlp ${version} from IndexedDB`);
  } else {
    logToMain("Looking up latest yt-dlp on PyPI…");
    const meta = await (await fetch("https://pypi.org/pypi/yt-dlp/json")).json();
    version = meta.info.version;
    const wheel = meta.urls.find((u) => u.packagetype === "bdist_wheel" && /py[23]-none-any/.test(u.filename));
    if (!wheel) throw new Error("No yt-dlp wheel on PyPI");
    logToMain(`Downloading yt-dlp ${version} (${(wheel.size / 1e6).toFixed(1)} MB)…`);
    bytes = new Uint8Array(await (await fetch(wheel.url)).arrayBuffer());
    await cachePut(KEY, { bytes, version, url: wheel.url, ts: Date.now() });
    logToMain(`Cached yt-dlp ${version} in IndexedDB`);
  }
  pyodide.FS.writeFile("/tmp/yt_dlp.whl", bytes);
  await pyodide.runPythonAsync(`
import micropip
try:
    await micropip.install("emfs:/tmp/yt_dlp.whl", keep_going=True)
except Exception as e:
    print("emfs install failed, falling back to PyPI:", e)
    await micropip.install("yt-dlp", keep_going=True)
print("yt-dlp ready")
`);
}

async function ensureFfmpeg() {
  if (ffmpeg) return ffmpeg;
  logToMain("Loading ffmpeg.wasm (one-time, ~30 MB)…");
  importScripts("https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js");
  importScripts("https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js");
  const { FFmpeg } = self.FFmpegWASM;
  ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js",
    wasmURL: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm",
  });
  logToMain("ffmpeg.wasm ready");
  return ffmpeg;
}

async function muxToMp4(videoBytes, audioBytes) {
  const ff = await ensureFfmpeg();
  const v = "in_v", a = "in_a", out = "out.mp4";
  await ff.writeFile(v, videoBytes);
  await ff.writeFile(a, audioBytes);
  const code = await ff.exec(["-i", v, "-i", a, "-c", "copy", "-movflags", "faststart", out]);
  if (code !== 0) throw new Error("ffmpeg mux failed (non-zero exit)");
  const data = await ff.readFile(out);
  await Promise.all([v, a, out].map((p) => ff.deleteFile(p).catch(() => {})));
  return data;
}

async function boot() {
  logToMain("Loading Pyodide runtime…");
  pyodide = await loadPyodide({
    indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/",
    stdout: logToMain,
    stderr: logToMain,
  });
  await pyodide.loadPackage(["micropip", "ssl"]);
  await installYtDlp();
  logToMain("Applying network monkey-patch…");
  const patchSrc = await (await fetch("./network_patch.py")).text();
  // worker is served from /yt-wasm/worker.js, so relative path is /yt-wasm/network_patch.py
  // fetch above already correct if worker.js does fetch("./network_patch.py") -> resolves to /yt-wasm/network_patch.py
  pyodide.FS.writeFile("/home/pyodide/network_patch.py", patchSrc);
  if (!metadataProxy) {
    logToMain("WARN: no metadata proxy configured — extraction will fail on CORS-restricted sites.");
  }
  pyodide.globals.set("__PROXY_URL__", metadataProxy || "");
  await pyodide.runPythonAsync(`
import sys
sys.path.insert(0, "/home/pyodide")
import network_patch
network_patch.install(__PROXY_URL__)
`);
  await pyodide.runPythonAsync(`
import json
from yt_dlp import YoutubeDL
# Patch the new yt-dlp networking layer (UrllibRH/RequestDirector) after import
import network_patch
try:
    network_patch.install_yt_dlp(__PROXY_URL__)
except Exception as e:
    print(f"[worker] yt_dlp networking patch deferred: {e}")

def run_extract(url: str) -> str:
    # Try multiple player clients to bypass bot detection (datacenter IP blocks web client)
    # android/ios clients are less strict and often bypass "Sign in to confirm you're not a bot"
    clients_to_try = [
        None,  # default (web)
        ["android"],
        ["ios"],
        ["android", "web"],
        ["web_embedded", "android"],
        ["tv_embedded"],
    ]
    last_err = None
    for client in clients_to_try:
        try:
            opts = {"quiet": True, "no_warnings": True, "noplaylist": True, "skip_download": True}
            if client is not None:
                opts["extractor_args"] = {"youtube": {"player_client": client}}
            with YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
                info = ydl.sanitize_info(info)
            return json.dumps(info)
        except Exception as e:
            msg = str(e)
            # Only retry on bot/PO token errors, otherwise fail fast
            if "Sign in to confirm" in msg or "bot" in msg.lower() or "Failed to extract" in msg or "Unable to extract" in msg:
                print(f"[run_extract] client {client} failed with bot error, trying next: {msg[:200]}")
                last_err = e
                continue
            raise
    # All clients failed, raise last error
    if last_err:
        raise last_err
    raise Exception("No player client succeeded")
`);
  pyExtract = pyodide.globals.get("run_extract");
  post({ type: "ready" });
}

function ensureBooted() {
  if (!bootPromise) {
    bootPromise = boot().catch((err) => {
      logToMain(`Fatal boot error: ${err?.stack || err}`);
      throw err;
    });
  }
  return bootPromise;
}

async function handleConfigure({ metadataProxy: proxyUrl }) {
  metadataProxy = proxyUrl || "";
  ensureBooted();
  return { payload: { ok: true } };
}
async function handleExtract({ url }) {
  await ensureBooted();
  return { payload: JSON.parse(pyExtract(url)) };
}
async function handleMux({ video, audio }) {
  const muxed = await muxToMp4(video, audio);
  return { payload: { bytes: muxed }, transfer: [muxed.buffer] };
}

const methods = {
  configure: handleConfigure,
  extract: handleExtract,
  mux: handleMux,
};

self.onmessage = async (e) => {
  const { id, method, args } = e.data;
  try {
    const fn = methods[method];
    if (!fn) throw new Error(`Unknown method: ${method}`);
    const { payload, transfer } = await fn(args);
    if (id === 0) return;
    self.postMessage({ id, type: "result", payload }, transfer || []);
  } catch (err) {
    if (id === 0) return;
    self.postMessage({ id, type: "error", payload: err?.message || String(err) });
  }
};
