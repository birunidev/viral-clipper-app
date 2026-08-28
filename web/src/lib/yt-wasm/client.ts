"use client";

import { API_URL } from "@/lib/api";

let worker: Worker | null = null;
let pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
let nextId = 1;
let readyPromise: Promise<void> | null = null;
let ready = false;
let logCb: ((s: string) => void) | null = null;

function getProxyBase() {
  // backend proxy base: `${API_URL}/yt-wasm`  (worker appends /proxy?url=)
  // API_URL is like https://clipzard.web.id/api/v1
  // ensure no trailing slash duplication
  const base = API_URL.replace(/\/$/, "");
  // if API_URL already ends with /api/v1, keep that, worker will do /proxy?url=
  // Our backend router is /api/v1/yt-wasm/proxy
  // So base is `${base}/yt-wasm`
  if (base.endsWith("/yt-wasm")) return base;
  return `${base}/yt-wasm`;
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker("/yt-wasm/worker.js");
  worker.onmessage = (e: MessageEvent) => {
    const { id, type, payload } = e.data;
    if (type === "log") {
      if (logCb) logCb(String(payload));
      // also console
      // console.log("[yt-wasm]", payload);
      return;
    }
    if (type === "ready") {
      ready = true;
      return;
    }
    const h = pending.get(id);
    if (!h) return;
    pending.delete(id);
    if (type === "result") h.resolve(payload);
    else h.reject(new Error(String(payload)));
  };
  worker.onerror = (e) => {
    console.error("[yt-wasm worker error]", e);
  };
  // configure with proxy
  const proxyBase = getProxyBase();
  worker.postMessage({ id: 0, method: "configure", args: { metadataProxy: proxyBase } });
  return worker;
}

function call(method: string, args: any, transfer?: Transferable[]): Promise<any> {
  const w = ensureWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, method, args }, transfer || []);
  });
}

export function onWasmLog(cb: (s: string) => void) {
  logCb = cb;
}

export async function ensureWasmReady(onLog?: (s: string) => void): Promise<void> {
  if (onLog) logCb = onLog;
  ensureWorker();
  if (ready) return;
  if (readyPromise) return readyPromise;
  readyPromise = new Promise<void>((resolve, reject) => {
    const iv = setInterval(() => {
      if (ready) {
        clearInterval(iv);
        resolve();
      }
    }, 100);
    // also listen for ready via worker's postMessage already sets ready flag
    // fallback timeout
    setTimeout(() => {
      if (!ready) {
        // still not ready, but we consider boot started; wait longer
      }
    }, 30000);
    // also reject on worker error after 60s
  });
  // wait until boot completes – poll until pyExtract available via dummy extract check
  // simpler: wait for ready flag up to 60s
  let waited = 0;
  while (!ready && waited < 60000) {
    await new Promise((r) => setTimeout(r, 200));
    waited += 200;
  }
  if (!ready) throw new Error("Pyodide boot timeout");
  return readyPromise;
}

export async function wasmExtract(url: string, onLog?: (s: string) => void): Promise<any> {
  if (onLog) logCb = onLog;
  ensureWorker();
  // ensure boot
  if (!ready) {
    await ensureWasmReady(onLog);
  }
  return call("extract", { url });
}

export async function wasmMux(video: Uint8Array, audio: Uint8Array): Promise<Uint8Array> {
  const res = await call("mux", { video, audio }, [video.buffer, audio.buffer]);
  // res is { bytes: Uint8Array }
  if (res.bytes) return res.bytes as Uint8Array;
  return res as Uint8Array;
}

export function isWasmSupported(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return typeof Worker !== "undefined" && typeof indexedDB !== "undefined" && typeof WebAssembly !== "undefined";
  } catch {
    return false;
  }
}
