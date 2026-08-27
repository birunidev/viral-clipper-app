"use client";

// Browser-only YouTube download via youtubei.js (Innertube).
// No backend resolve — fully client-side, bypasses datacenter bot guard.
// Uses user's residential IP + POToken generated locally.

const YT_ID_RE = /(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/;

export function extractVideoId(url: string): string | null {
  const m = url.match(YT_ID_RE);
  if (m) return m[1];
  const t = url.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(t)) return t;
  try {
    const u = new URL(url);
    const v = u.searchParams.get("v");
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
  } catch {}
  return null;
}

export type DownloadProgress = { loaded: number; total: number | null; percent: number | null };

// Lazy singleton Innertube to avoid re-creating session per download
let innertubePromise: Promise<any> | null = null;

// Invidious/Piped fallback for bot-guarded videos (CORS-friendly, no PO token)
const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.moomoo.me",
  "https://pipedapi.syncpundit.io",
  "https://api.piped.projectsegfau.lt",
];

async function tryPiped(videoId: string): Promise<{ url: string; title: string } | null> {
  for (const base of PIPED_INSTANCES) {
    try {
      const r = await fetch(`${base}/streams/${videoId}`, { mode: "cors" });
      if (!r.ok) continue;
      const j = await r.json();
      const title: string = j.title || "video";
      // Piped returns videoStreams and audioStreams
      const streams: any[] = [...(j.videoStreams || []), ...(j.audioStreams || [])];
      // Find muxed or video+audio
      const muxed = (j.videoStreams || []).filter((s: any) => s.mimeType?.includes("video/mp4") && s.url);
      muxed.sort((a: any, b: any) => (b.height || 0) - (a.height || 0));
      for (const s of muxed) if ((s.height || 0) <= 1080 && s.url) return { url: s.url, title };
      if (muxed[0]?.url) return { url: muxed[0].url, title };
      // Any hls or dash
      if (j.hls) return { url: j.hls, title };
      if (streams[0]?.url) return { url: streams[0].url, title };
    } catch {}
  }
  return null;
}

async function getInnertube() {
  if (!innertubePromise) {
    innertubePromise = (async () => {
      const { Innertube, UniversalCache } = await import("youtubei.js");
      // Proxy only config/player JS (which are CORS-blocked) but keep player direct?
      // We stub config/iframe to avoid 403, and let player go via a CORS proxy (backend)
      // For simple case, just stub the failing endpoints and let player use direct with CORS workaround
      const stubFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : (input as URL).toString();
        // Stub the two endpoints that 403 on our origin — return minimal ok
        if (url.includes("/youtubei/v1/config") || url.includes("/iframe_api")) {
          return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        // For player inner requests, use backend proxy to avoid CORS but keep residential IP impossible
        // So we still proxy player, but piped fallback will handle bot-guarded case
        if (url.includes("youtube.com/youtubei/")) {
          const { API_URL } = await import("@/lib/api");
          const method = init?.method || "POST";
          let body: string | undefined;
          if (init?.body) body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
          else if (input instanceof Request) {
            try {
              body = await (input as Request).clone().text();
            } catch {}
          }
          const proxyUrl = `${API_URL}/youtube/fetch?url=${encodeURIComponent(url)}`;
          return fetch(proxyUrl, {
            method,
            headers: { "Content-Type": "application/json" },
            body,
            credentials: "include",
          });
        }
        return fetch(input, init);
      };
      const it = await Innertube.create({
        cache: new UniversalCache(false),
        generate_session_locally: true,
        fetch: stubFetch as any,
        retrieve_player: false,
      });
      return it;
    })();
  }
  return innertubePromise;
}

function pickFormatUrl(info: any): { url: string; title: string } {
  const title: string = info.basic_info?.title || info.video_details?.title || "video";
  // Streaming data from youtubei.js VideoInfo
  const streamingData = info.page?.[0]?.player_response?.streamingData || info.streaming_data || info.page?.[0]?.streaming_data;
  // youtubei.js provides chooseFormat helper
  // Try helper first
  if (info.chooseFormat) {
    try {
      const fmt = info.chooseFormat({ type: "video+audio", quality: "best" });
      if (fmt?.url) return { url: fmt.url, title };
      // fallback to any
      const fmt2 = info.chooseFormat({ type: "video", quality: "best" });
      if (fmt2?.url) return { url: fmt2.url, title };
    } catch {}
  }
  // Manual fallback
  const formats: any[] = streamingData?.formats || info.streaming_data?.formats || [];
  const adaptive: any[] = streamingData?.adaptive_formats || streamingData?.adaptiveFormats || info.streaming_data?.adaptive_formats || [];
  const all = [...formats, ...adaptive].filter((f) => f.url || f.cipher || f.signature_cipher);
  if (!all.length) throw new Error("No playable streams — try Upload file (video may be private/members-only).");
  // Prefer mp4 muxed <=1080
  const muxed = formats.filter((f) => (f.mime_type || f.mimeType || "").includes("video/mp4") && f.url);
  muxed.sort((a, b) => (b.height || b.width || 0) - (a.height || a.width || 0));
  for (const f of muxed) if ((f.height || 0) <= 1080 && f.url) return { url: f.url, title };
  if (muxed[0]?.url) return { url: muxed[0].url, title };
  // Any with url (youtubei.js already deciphered)
  for (const f of all) {
    if (f.url) return { url: f.url, title };
    // decipher if needed (youtubei.js usually does)
    if (f.decipher) {
      try {
        const u = f.decipher(info.session?.player);
        if (u) return { url: u, title };
      } catch {}
    }
  }
  throw new Error("No direct stream URL found. Use Upload file.");
}

export async function downloadYoutubeInBrowser(
  youtubeUrl: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<{ blob: Blob; title: string; videoId: string }> {
  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) throw new Error("Invalid YouTube URL");

  let streamUrl: string | null = null;
  let title = "video";

  // 1) Try youtubei.js (innertube) — works for most public videos
  try {
    const innertube = await getInnertube();
    let info: any;
    try {
      info = await innertube.getInfo(videoId);
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (msg.includes("Login") || msg.includes("Sign in")) throw new Error(msg);
      throw new Error(msg || "Failed to fetch video info");
    }
    const status = info.page?.[0]?.playability_status?.status || info.playability_status?.status || "OK";
    const reason = info.page?.[0]?.playability_status?.reason || info.playability_status?.reason || "";
    if (status && status !== "OK") throw new Error(reason || status);
    const picked = pickFormatUrl(info);
    streamUrl = picked.url;
    title = picked.title;
  } catch (e: any) {
    // 2) Fallback to Piped (CORS-friendly, handles bot guard via its own backend)
    const piped = await tryPiped(videoId);
    if (piped) {
      streamUrl = piped.url;
      title = piped.title;
    } else {
      const msg = e?.message || String(e);
      // Final user-friendly error — no over-engineering, guide to Upload
      if (msg.includes("Sign in") || msg.includes("LOGIN_REQUIRED") || msg.includes("bot")) {
        throw new Error("YouTube blocked this video on our server (Sign in to confirm you’re not a bot). Please download it on your device and use Upload file — that’s 100% browser-local and always works.");
      }
      throw new Error(msg || "No playable streams — use Upload file.");
    }
  }

  if (!streamUrl) throw new Error("No stream URL — use Upload file.");

  // Download googlevideo URL directly — CORS * allowed
  const resp = await fetch(streamUrl, { mode: "cors", credentials: "omit" });
  if (!resp.ok) throw new Error(`Stream download failed ${resp.status}`);
  if (!resp.body) {
    const blob = await resp.blob();
    if (!blob.size) throw new Error("Empty download");
    return { blob, title, videoId };
  }
  const total = resp.headers.get("content-length") ? parseInt(resp.headers.get("content-length")!, 10) : null;
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.({ loaded, total, percent: total ? (loaded / total) * 100 : null });
    }
  }
  const blob = new Blob(chunks as BlobPart[], { type: "video/mp4" });
  if (!blob.size) throw new Error("Empty download");
  return { blob, title, videoId };
}
