"use client";

import { useEffect, useState } from "react";
import { Play, Sparkle } from "@phosphor-icons/react";

type Reel = {
  file: string;
  poster: string;
  youtubeId: string | null;
  handle: string;
  hook: string;
  title?: string;
  views: string;
  dur: string;
  tag?: string;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://clipzard.web.id/api/v1";

function YouTubeEmbed({ id }: { id: string }) {
  const src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&showinfo=0&iv_load_policy=3&disablekb=1&fs=0&playsinline=1&loop=1&playlist=${id}&enablejsapi=0&origin=${typeof window !== "undefined" ? window.location.origin : ""}`;
  return (
    <iframe
      src={src}
      title="Hero reel"
      allow="autoplay; encrypted-media"
      loading="eager"
      referrerPolicy="strict-origin-when-cross-origin"
      className="pointer-events-none absolute left-1/2 top-1/2 h-[180%] w-[180%] -translate-x-1/2 -translate-y-1/2 border-0"
    />
  );
}

export function HeroReel() {
  const [reel, setReel] = useState<Reel | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Straightforward: API is the proxy for web/public/reels → R2 presigned URLs.
    // No fallback to /reels/reels.json (local /reels/... paths are 404 in prod).
    fetch(`${API_URL}/reels`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: Reel[]) => {
        if (!cancelled && Array.isArray(data) && data.length > 0) {
          // Pick a standout reel - prefer one with strong hook, not first which may be random
          // Use second reel for variety (first is often used in wall), or random
          const pick = data[Math.floor(Math.random() * Math.min(6, data.length))] || data[0];
          setReel(pick);
        }
      })
      .catch(() => {
        // Keep placeholder display; no local /reels fetch to avoid 404.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fallback placeholder while loading
  const display = reel || {
    file: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
    poster: "https://picsum.photos/seed/hero-reel/360/640",
    youtubeId: null,
    handle: "@clipzard",
    hook: "The hook that made it blow up",
    title: "The hook that made it blow up",
    views: "2.4M",
    dur: "0:31",
    tag: "Hook",
  } as Reel;

  const isYouTube = !!display.youtubeId;

  return (
    <div className="relative mx-auto w-[300px] sm:w-[340px] lg:ml-auto lg:mr-0">
      <div className="rounded-[28px] border border-line bg-surface-1 p-2 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.5)]">
        <div className="overflow-hidden rounded-[20px] border border-line-soft bg-canvas">
          <div className="aspect-[9/16] relative bg-canvas">
            {isYouTube ? (
              <div className="absolute inset-0 overflow-hidden">
                <YouTubeEmbed id={display.youtubeId!} />
              </div>
            ) : (
              <>
                <img src={display.poster} alt="" className="absolute inset-0 h-full w-full object-cover" />
                <video
                  poster={display.poster}
                  src={display.file}
                  muted
                  loop
                  autoPlay
                  playsInline
                  preload="metadata"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              </>
            )}
            <div className="absolute left-3 right-3 top-3 flex items-center justify-between">
              <span className="rounded-full bg-black/60 px-2.5 py-1 text-[10px] font-medium tracking-wide text-white backdrop-blur">
                {(display.tag || "Hook") + " · " + (display.dur || "0:31")}
              </span>
              <span className="rounded-full bg-accent px-2.5 py-1 text-[10px] font-semibold text-accent-ink">9:16 ready</span>
            </div>
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-4 pt-12">
              <p className="text-sm font-medium leading-tight text-white line-clamp-2">{display.hook}</p>
              <p className="mt-1 line-clamp-1 text-xs leading-relaxed text-white/75">{display.title}</p>
              <div className="mt-3 flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-success shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
                <span className="font-mono text-[11px] text-white/70 tabular-nums">
                  {display.views} views · {display.handle}
                </span>
              </div>
            </div>
            <div className="absolute left-1/2 top-1/2 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink shadow-lg backdrop-blur opacity-0 group-hover:opacity-100 transition-opacity">
              <Play size={16} weight="fill" className="ml-0.5" />
            </div>
          </div>
        </div>
      </div>
      <div className="absolute -left-4 bottom-6 hidden rounded-2xl border border-line bg-surface-1 px-4 py-3 shadow-xl md:flex md:items-center md:gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-success-soft text-success">
          <Sparkle size={14} weight="fill" />
        </span>
        <div>
          <p className="font-mono text-xs font-semibold text-ink tabular-nums">30 reels ready</p>
          <p className="text-xs text-ink-muted">from your 4 sources</p>
        </div>
      </div>
      <div className="absolute -right-2 top-8 hidden rounded-full border border-line bg-surface-1 px-3 py-1.5 text-xs font-medium text-ink shadow-lg md:inline-flex md:items-center md:gap-1.5">
        <span className="h-2 w-2 rounded-full bg-accent" /> Transcribed · Analyzed · Cut
      </div>
    </div>
  );
}
