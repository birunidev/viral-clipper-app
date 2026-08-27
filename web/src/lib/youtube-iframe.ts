"use client";

// YouTube IFrame Player API loader + helpers.
// Uses official JS API (https://www.youtube.com/iframe_api) so we can listen
// to onStateChange and control playback precisely. Not a raw <iframe src>.

const YT_IFRAME_SRC = "https://www.youtube.com/iframe_api";

let loadPromise: Promise<void> | null = null;

export function loadYouTubeIframeAPI(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("No window"));
  // already loaded
  if ((window as any).YT?.Player) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[src="${YT_IFRAME_SRC}"]`);
    if (!existing) {
      const tag = document.createElement("script");
      tag.src = YT_IFRAME_SRC;
      tag.async = true;
      tag.onerror = () => reject(new Error("Failed to load YouTube IFrame API"));
      document.head.appendChild(tag);
    }
    const prev = (window as any).onYouTubeIframeAPIReady;
    (window as any).onYouTubeIframeAPIReady = () => {
      if (prev) try { prev(); } catch {}
      resolve();
    };
    // fallback poll if callback already fired before we set it
    let tries = 0;
    const iv = setInterval(() => {
      if ((window as any).YT?.Player) {
        clearInterval(iv);
        resolve();
      }
      if (++tries > 100) {
        clearInterval(iv);
        // let the callback resolve it
      }
    }, 50);
  });
  return loadPromise;
}

export type YTPlayer = any; // YT.Player

export function createYouTubePlayer(
  containerId: string,
  videoId: string,
  events: {
    onReady?: (e: any) => void;
    onStateChange?: (e: any) => void;
    onError?: (e: any) => void;
  }
): YTPlayer {
  const YT = (window as any).YT;
  if (!YT?.Player) throw new Error("YT.Player not ready – call loadYouTubeIframeAPI first");
  return new YT.Player(containerId, {
    videoId,
    width: "100%",
    height: "100%",
    playerVars: {
      enablejsapi: 1,
      origin: typeof window !== "undefined" ? window.location.origin : undefined,
      modestbranding: 1,
      rel: 0,
      playsinline: 1,
      controls: 1,
    },
    events: {
      onReady: events.onReady,
      onStateChange: events.onStateChange,
      onError: events.onError,
    },
  });
}

export function parseYouTubeError(code: number): string {
  // https://developers.google.com/youtube/iframe_api_reference#onError
  switch (code) {
    case 2: return "Invalid YouTube URL.";
    case 5: return "HTML5 player error – try another browser.";
    case 100: return "Video not found or removed.";
    case 101:
    case 150: return "Embedding disabled by video owner – use Upload file with a local copy.";
    default: return `YouTube player error (${code}). Try another video or use Upload.`;
  }
}

export { extractVideoId } from "./youtube-client";
