"use client";

import { useEffect, useRef, useState } from "react";
import { Play } from "@phosphor-icons/react";

type Reel = {
  file: string;
  poster: string;
  youtubeId: string | null;
  handle: string;
  hook: string;
  views: string;
  dur: string;
  tag: string;
  title?: string;
};

const FALLBACK_REELS: Reel[] = [
  {
    file: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
    poster: "https://picsum.photos/seed/reel01/360/640",
    youtubeId: null,
    handle: "@maya.cooks",
    hook: "The 6s hook that doubled saves",
    views: "2.4M",
    dur: "0:28",
    tag: "Hook",
  },
  {
    file: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
    poster: "https://picsum.photos/seed/reel02/360/640",
    youtubeId: null,
    handle: "@podvault",
    hook: "Cold open — no intro, straight punch",
    views: "1.1M",
    dur: "0:36",
    tag: "Cold open",
  },
  {
    file: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
    poster: "https://picsum.photos/seed/reel03/360/640",
    youtubeId: null,
    handle: "@fitwithlara",
    hook: "Payoff at 0:19 — watch till end",
    views: "3.7M",
    dur: "0:42",
    tag: "Payoff",
  },
  {
    file: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
    poster: "https://picsum.photos/seed/reel04/360/640",
    youtubeId: null,
    handle: "@indie_devlog",
    hook: "One sentence that made it viral",
    views: "892K",
    dur: "0:33",
    tag: "Viral line",
  },
  {
    file: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
    poster: "https://picsum.photos/seed/reel05/360/640",
    youtubeId: null,
    handle: "@travel.juno",
    hook: "Punch-in + captions burned perfectly",
    views: "1.8M",
    dur: "0:24",
    tag: "Captions",
  },
  {
    file: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
    poster: "https://picsum.photos/seed/reel06/360/640",
    youtubeId: null,
    handle: "@finance.bro",
    hook: "Hook → story → CTA in 29s",
    views: "4.2M",
    dur: "0:29",
    tag: "Structure",
  },
];

/* Chromeless YouTube: hide all UI, auto-mute loop, no related, no branding */
function YouTubeEmbed({ id, poster }: { id: string; poster: string }) {
  // Use youtube-nocookie with all UI disabled. Loop requires playlist param.
  const src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&showinfo=0&iv_load_policy=3&disablekb=1&fs=0&playsinline=1&loop=1&playlist=${id}&enablejsapi=0&origin=${typeof window !== "undefined" ? window.location.origin : ""}`;
  return (
    <div className="absolute inset-0 h-full w-full overflow-hidden bg-canvas">
      <iframe
        src={src}
        title="YouTube reel"
        allow="autoplay; encrypted-media"
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
        className="pointer-events-none absolute left-1/2 top-1/2 h-[180%] w-[180%] -translate-x-1/2 -translate-y-1/2 border-0 object-cover"
        style={{ border: 0 }}
      />
      {/* poster fallback while iframe loads, and extra grain to soften YouTube compression */}
      <img src={poster} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-0" aria-hidden />
    </div>
  );
}

function ReelCard({ r }: { r: Reel }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (r.youtubeId) return; // YouTube handles autoplay
    const v = ref.current;
    if (!v) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) v.play().catch(() => {});
          else v.pause();
        });
      },
      { threshold: 0.25 }
    );
    io.observe(v);
    return () => io.disconnect();
  }, [r.youtubeId]);

  // Resolve src: prefer youtube if present, else local file
  const isYouTube = !!r.youtubeId;

  return (
    <div className="group relative w-[172px] shrink-0 overflow-hidden rounded-[18px] border border-line bg-surface-1 sm:w-[200px] md:w-[220px]">
      <div className="aspect-[9/16] relative bg-canvas">
        {isYouTube ? (
          <YouTubeEmbed id={r.youtubeId!} poster={r.poster} />
        ) : (
          <video
            ref={ref}
            poster={r.poster}
            src={r.file}
            muted
            loop
            playsInline
            preload="metadata"
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.06] mix-blend-overlay"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E")`,
          }}
        />
        {/* block YouTube interaction, keep card clickable for pause */}
        {isYouTube && <div className="absolute inset-0" aria-hidden />}
        <div className="absolute left-2 right-2 top-2 flex items-center justify-between">
          <span className="rounded-full bg-black/55 px-2 py-1 text-[10px] font-medium tracking-wide text-white backdrop-blur">
            {r.tag}
          </span>
          <span className="rounded-full bg-black/55 px-2 py-1 font-mono text-[10px] text-white backdrop-blur tabular-nums">
            {r.dur}
          </span>
        </div>
        <div className="absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink opacity-0 shadow-lg backdrop-blur transition-opacity group-hover:opacity-100">
          <Play size={12} weight="fill" className="ml-0.5" />
        </div>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/30 to-transparent p-2.5 pt-8">
          <p className="text-[12px] font-medium leading-tight text-white line-clamp-2">{r.hook}</p>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="truncate text-[11px] text-white/80">{r.handle}</span>
            <span className="shrink-0 font-mono text-[10px] text-white/70 tabular-nums">{r.views}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ items, reverse }: { items: Reel[]; reverse?: boolean }) {
  const doubled = [...items, ...items];
  return (
    <div className="overflow-hidden">
      <div className={`flex w-max gap-4 ${reverse ? "animate-marquee-x-reverse" : "animate-marquee-x"}`}>
        {doubled.map((r, i) => (
          <ReelCard key={`${r.handle}-${r.hook}-${i}`} r={r} />
        ))}
      </div>
    </div>
  );
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://clipzard.web.id/api/v1";

export function ReelsWall() {
  const [reels, setReels] = useState<Reel[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Prefer presigned R2 URLs from backend (fresh 7-day signatures), fallback to static json
    fetch(`${API_URL}/reels`, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("no backend reels");
        return res.json();
      })
      .then((data: Reel[]) => {
        if (!cancelled && Array.isArray(data) && data.length > 0) {
          setReels(data);
          return;
        }
        throw new Error("empty");
      })
      .catch(() => {
        // Fallback to static public folder
        fetch("/reels/reels.json", { cache: "no-store" })
          .then((res) => {
            if (!res.ok) throw new Error("no reels.json");
            return res.json();
          })
          .then((data: Reel[]) => {
            if (!cancelled && Array.isArray(data) && data.length > 0) setReels(data);
          })
          .catch(() => {});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const data = reels && reels.length > 0 ? reels : FALLBACK_REELS;
  // Split into two rows for horizontal marquee (random already shuffled)
  const mid = Math.ceil(data.length / 2);
  const row1 = data.slice(0, mid);
  const row2 = data.slice(mid);

  // If we have <6 per row, duplicate to fill marquee length
  return (
    <div className="relative flex flex-col gap-4">
      <Row items={row1} />
      <Row items={row2.length > 0 ? row2 : row1} reverse />
      <div className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-canvas to-transparent md:w-16" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-canvas to-transparent md:w-16" />
    </div>
  );
}
