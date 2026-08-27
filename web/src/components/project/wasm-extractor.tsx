"use client";

import { useState, useRef } from "react";
import { Clock, Warning, Download, FilmReel, Check, SpinnerGap } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { extractVideoId } from "@/lib/youtube-client";
import { wasmExtract, wasmMux, isWasmSupported, onWasmLog } from "@/lib/yt-wasm/client";

type Props = {
  youtubeUrl: string;
  onBlobReady: (blob: Blob, title: string) => void;
  onError?: (msg: string) => void;
};

type Phase = "idle" | "booting" | "extracting" | "ready" | "fetching" | "muxing" | "uploading";

export function WasmExtractor({ youtubeUrl, onBlobReady, onError }: Props) {
  const videoId = extractVideoId(youtubeUrl.trim());
  const [phase, setPhase] = useState<Phase>("idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [info, setInfo] = useState<any>(null);
  const [selected, setSelected] = useState<string>(""); // JSON string
  const [error, setError] = useState("");
  const [fetchProgress, setFetchProgress] = useState<number | null>(null);

  const pushLog = (s: string) => setLogs((prev) => [...prev.slice(-80), s]);

  const supported = isWasmSupported();

  async function handleExtract() {
    if (!videoId) {
      setError("Invalid YouTube URL");
      return;
    }
    if (!supported) {
      setError("WASM not supported in this browser. Use Chrome/Edge desktop or try Tab Capture.");
      return;
    }
    setError("");
    setInfo(null);
    setSelected("");
    setLogs([]);
    setPhase("booting");
    onWasmLog(pushLog);
    pushLog("Booting Pyodide + yt-dlp (first visit ~15 MB, cached after)…");
    try {
      setPhase("extracting");
      pushLog("Extracting video info via WASM (your IP, via tiny metadata proxy)…");
      const data = await wasmExtract(youtubeUrl.trim(), pushLog);
      // sanity
      if (!data || !data.formats) throw new Error("No formats returned");
      setInfo(data);
      setPhase("ready");
      pushLog(`Title: ${data.title} – ${data.formats.length} formats`);
      // auto-select best
      const choice = pickDefaultChoice(data);
      if (choice) setSelected(JSON.stringify(choice));
    } catch (e: any) {
      const msg = friendlyExtractError(e?.message || String(e));
      setError(msg);
      onError?.(msg);
      pushLog(`✗ ${msg}`);
      setPhase("idle");
    }
  }

  async function handleFetchAndUpload() {
    if (!info || !selected) {
      setError("Select a format first");
      return;
    }
    const choice = JSON.parse(selected);
    const title: string = info.title || "video";
    setError("");
    setPhase("fetching");
    setFetchProgress(0);
    pushLog(`Fetching ${choice.kind === "dash" ? "DASH video+audio" : "progressive"}…`);
    try {
      let blob: Blob;
      let mime = "video/mp4";
      if (choice.kind === "single") {
        const bytes = await fetchBytes(choice.url, "media", (p) => setFetchProgress(p));
        mime = choice.mime || "video/mp4";
        blob = new Blob([bytes as any], { type: mime });
      } else {
        // DASH
        const onProg = (p: number | null) => {
          if (p !== null) setFetchProgress(p);
        };
        // fetch both in parallel with progress merging (simplified: sequential for progress clarity)
        const videoBytes = await fetchBytes(choice.videoUrl, "video", onProg);
        const audioBytes = await fetchBytes(choice.audioUrl, "audio", onProg);
        setPhase("muxing");
        pushLog("Muxing video+audio via ffmpeg.wasm (copy, no re-encode)…");
        const muxed = await wasmMux(videoBytes, audioBytes);
        blob = new Blob([muxed as any], { type: "video/mp4" });
        mime = "video/mp4";
      }
      pushLog(`Fetched ${ (blob.size/1024/1024).toFixed(1)} MB – uploading…`);
      setPhase("uploading");
      onBlobReady(blob, title);
      // keep phase as uploading until parent navigates; reset to ready for retry
      setPhase("ready");
    } catch (e: any) {
      const msg = e?.message || String(e);
      // expiry retry once
      if (isExpiryError(msg)) {
        pushLog("Signed URL expired – re-extracting once…");
        try {
          const fresh = await wasmExtract(youtubeUrl.trim(), pushLog);
          setInfo(fresh);
          const choice2 = pickDefaultChoice(fresh);
          if (choice2) setSelected(JSON.stringify(choice2));
          setError("URL expired – refreshed. Click Fetch again.");
          pushLog("Re-extract done – please retry fetch.");
        } catch (e2: any) {
          const m2 = friendlyExtractError(e2?.message || String(e2));
          setError(m2);
          pushLog(`✗ re-extract failed: ${m2}`);
        }
        setPhase("ready");
        return;
      }
      setError(msg);
      onError?.(msg);
      pushLog(`✗ ${msg}`);
      setPhase("ready");
    } finally {
      setFetchProgress(null);
    }
  }

  // helpers
  const percentLabel = fetchProgress !== null ? `${Math.round(fetchProgress)}%` : "";

  return (
    <div className="rounded-xl border border-line bg-zinc-950 p-5 text-white">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-sm font-medium">
          <FilmReel size={18} weight="fill" />
          {phase === "booting" ? "Loading WASM engine…" : phase === "extracting" ? "Extracting video info…" : phase === "fetching" ? "Fetching video… " + percentLabel : phase === "muxing" ? "Muxing…" : phase === "ready" && info ? "Select quality" : "WASM Extractor"}
        </p>
        {info?.duration ? <span className="text-xs tabular-nums text-white/60">{Math.floor(info.duration/60)}:{String(Math.floor(info.duration%60)).padStart(2,"0")}</span> : null}
      </div>

      {/* progress bar for fetch */}
      {(phase === "fetching" || phase === "muxing") && (
        <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div className="h-full bg-white transition-all" style={{ width: `${fetchProgress ?? (phase==="muxing"?100:10)}%` }} />
        </div>
      )}

      {/* logs */}
      <div className="mt-4 max-h-[120px] overflow-auto rounded-lg bg-black/40 p-2.5 font-mono text-[11px] leading-relaxed text-white/70">
        {logs.length ? logs.map((l,i)=><div key={i}>{l}</div>) : <span className="text-white/40">Logs appear here… First load downloads Pyodide/yt-dlp wheel (~15 MB) and caches in IndexedDB.</span>}
      </div>

      {!supported && (
        <div className="mt-3 rounded-lg border border-red-400/30 bg-red-400/15 px-3 py-2 text-xs text-red-200">
          WASM not supported. Use a modern desktop browser (Chrome/Edge/Firefox) or try Tab Capture fallback.
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-500/10 p-3">
          <p className="flex gap-1.5 text-xs leading-relaxed text-amber-200"><Warning size={14} weight="fill" className="mt-0.5 shrink-0" /> {error}</p>
          {error.toLowerCase().includes("age-restricted") && (
            <button
              type="button"
              onClick={() => {
                // open the Tab Capture <details> in parent page
                const details = document.querySelector("details") as HTMLDetailsElement | null;
                const all = document.querySelectorAll("details");
                // the first details after WASM is the Tab Capture fallback (inside dashboard)
                // open all details that contain YoutubeCapture
                all.forEach((d) => { (d as HTMLDetailsElement).open = true; });
                details?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
              className="mt-2 inline-flex items-center gap-1 rounded-md bg-amber-400 px-2.5 py-1 text-xs font-medium text-zinc-900 hover:bg-amber-300"
            >
              <FilmReel size={14} weight="fill" /> Try Tab Capture fallback
            </button>
          )}
        </div>
      )}

      {phase === "idle" && (
        <div className="mt-4">
          <Button onClick={handleExtract} disabled={!videoId || !supported}>
            {videoId ? "Extract with WASM" : "Enter a YouTube URL first"}
          </Button>
          <p className="mt-2 text-[11px] text-white/50">Extract runs on your IP (bypasses datacenter block). Tiny metadata via proxy (~20KB), video bytes direct from googlevideo.com.</p>
        </div>
      )}

      {(phase === "booting" || phase === "extracting") && (
        <div className="mt-4 flex items-center gap-2 text-xs text-white/70">
          <SpinnerGap size={14} className="animate-spin" /> {phase === "booting" ? "Booting Pyodide (cached after first visit)…" : "Running yt-dlp inside WASM…"}
        </div>
      )}

      {phase === "ready" && info && (
        <div className="mt-4 space-y-3">
          <div className="flex gap-3">
            {info.thumbnail && <img src={info.thumbnail} alt="" className="h-16 w-28 rounded object-cover" />}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{info.title}</p>
              <p className="text-xs text-white/60">{info.uploader} · {info.duration_string || ""}</p>
            </div>
          </div>

          <label className="block text-xs font-medium text-white/80">Quality</label>
          <select value={selected} onChange={(e)=>setSelected(e.target.value)} className="w-full rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-sm text-white">
            <option value="">Select…</option>
            {buildOptions(info).map((o: any, i:number) => (
              <option key={i} value={JSON.stringify(o.value)}>{o.label}</option>
            ))}
          </select>

          <div className="flex gap-2">
            <Button onClick={handleFetchAndUpload} disabled={!selected}>
              <Download size={16} /> Fetch & Upload
            </Button>
            <Button variant="ghost" onClick={handleExtract}>Re-extract</Button>
          </div>
          <p className="text-[11px] text-white/50">Fetching goes straight to googlevideo.com (your IP). For DASH, video+audio are muxed locally via ffmpeg.wasm (copy). Then we upload the final blob to your server (keeps existing pipeline – server never touches YouTube).</p>
        </div>
      )}

      {/* fallback hint */}
      <p className="mt-4 text-[11px] text-white/40">If extraction fails for this video, try Tab Capture as backup – it records what plays, so it never hits YouTube’s API.</p>
    </div>
  );
}

function fetchBytes(url: string, label: string, onProgress?: (p: number | null) => void): Promise<Uint8Array> {
  return new Promise(async (resolve, reject) => {
    try {
      const res = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
      if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length")) || 0;
      if (!res.body || !total) {
        const buf = await res.arrayBuffer();
        resolve(new Uint8Array(buf));
        return;
      }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      let lastPct = -1;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          received += value.byteLength;
          const pct = Math.floor((received/total)*100);
          if (pct !== lastPct) {
            onProgress?.(pct);
            lastPct = pct;
          }
        }
      }
      const out = new Uint8Array(received);
      let off=0;
      for (const c of chunks){ out.set(c, off); off+=c.byteLength; }
      resolve(out);
    } catch (e) {
      reject(e);
    }
  });
}

function isExpiryError(msg: string): boolean {
  const low = msg.toLowerCase();
  return low.includes("403") || low.includes("401") || low.includes("expired") || low.includes("signature");
}

function friendlyExtractError(msg: string): string {
  const low = msg.toLowerCase();
  if (low.includes("proxy") && low.includes("url")) return "Metadata proxy unreachable – check that /api/v1/yt-wasm/proxy is deployed. Tiny proxy only, not video bytes.";
  if (low.includes("private") || low.includes("login required") || (low.includes("sign in") && !low.includes("age"))) return "Video is private/login-required – even client extraction can't bypass it. Try a public video or use Tab Capture (records what your signed-in tab plays).";
  if (low.includes("age")) return "Age-restricted – sign in required. YouTube age-gate needs a signed-in account with verified age >18. WASM extraction runs anonymously (no cookies) so YouTube blocks it even from your residential IP. Fix: use Tab Capture below – it records the rendered video in your already-signed-in/age-verified browser tab, bypassing the API gate. Open the video in YouTube, verify age, then capture.";
  if (low.includes("region") || low.includes("geo")) return "Region-locked – not available in your country via API. Tab Capture (recording playback) can bypass.";
  if (low.includes("live") && low.includes("not")) return "Live stream not yet ended.";
  if (low.includes("unsupported") || low.includes("not supported")) return "This video/site isn't supported by yt-dlp.";
  if (low.includes("network error") || low.includes("urlerror")) return "Network error during extraction – proxy unreachable or YouTube blocked. Try again or use Tab Capture fallback.";
  if (low.includes("ssl")) return "Pyodide SSL missing – reload and try again (should load ssl package on boot).";
  return msg;
}

// format helpers mirroring worker's main.js
function pickDedup(formats: any[], predicate: (f:any)=>boolean){
  const filtered = formats.filter(predicate);
  const m = new Map();
  for(const f of filtered){
    const h = f.height||0;
    const cur=m.get(h);
    if(!cur || (f.tbr||0)>(cur.tbr||0)) m.set(h,f);
  }
  return [...m.values()].sort((a,b)=>(a.height||0)-(b.height||0));
}

function buildOptions(info: any){
  const formats = info.formats || [];
  const isHttp = (f:any)=> f.protocol==="https" || f.protocol==="http";
  const progressive = pickDedup(formats, (f)=> !!(f.url && f.vcodec && f.vcodec!=="none" && f.acodec && f.acodec!=="none" && isHttp(f)));
  const videoOnly = pickDedup(formats, (f)=> !!(f.url && f.vcodec && f.vcodec!=="none" && (!f.acodec || f.acodec==="none") && isHttp(f)));
  const audioOnly = formats.filter((f:any)=> !!(f.url && f.acodec && f.acodec!=="none" && (!f.vcodec||f.vcodec==="none") && isHttp(f))).sort((a:any,b:any)=>(b.tbr||0)-(a.tbr||0))[0] || null;

  const opts:any[]=[];
  const human = (tbr:number)=> !tbr ? "?" : tbr>=1000 ? `${(tbr/1000).toFixed(1)} Mbps` : `${Math.round(tbr)} kbps`;
  const labelQ = (f:any)=> `${f.height||"?"}p${f.fps && f.fps>30 ? Math.round(f.fps):""}`;

  if(audioOnly && videoOnly.length){
    for(const v of [...videoOnly].reverse()){
      opts.push({ label: `${labelQ(v)} (DASH+mux, ${human((v.tbr||0)+(audioOnly.tbr||0))})`, value: { kind:"dash", videoUrl: v.url, audioUrl: audioOnly.url, videoExt: v.ext, audioExt: audioOnly.ext } });
    }
  }
  for(const f of [...progressive].reverse()){
    opts.push({ label: `Progressive ${labelQ(f)} (${f.ext}, ${human(f.tbr)})`, value: { kind:"single", url: f.url, ext: f.ext, mime: f.ext==="mp4"?"video/mp4": f.ext==="webm"?"video/webm":"video/mp4" } });
  }
  if(audioOnly) opts.push({ label: `Audio only (${audioOnly.ext}, ${human(audioOnly.tbr)})`, value: { kind:"single", url: audioOnly.url, ext: audioOnly.ext, mime: "audio/mp4"} });
  return opts;
}

function pickDefaultChoice(info:any){
  const opts = buildOptions(info);
  return opts[0]?.value || null;
}
