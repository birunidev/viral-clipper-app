"use client";

import { useEffect, useRef } from "react";
import { Play } from "@phosphor-icons/react";

type Reel = {
  poster: string;
  src: string;
  handle: string;
  hook: string;
  views: string;
  dur: string;
  tag: string;
};

const REELS: Reel[] = [
  {
    poster: "https://picsum.photos/seed/reel01/360/640",
    src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
    handle: "@maya.cooks",
    hook: "The 6s hook that doubled saves",
    views: "2.4M",
    dur: "0:28",
    tag: "Hook",
  },
  {
    poster: "https://picsum.photos/seed/reel02/360/640",
    src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
    handle: "@podvault",
    hook: "Cold open — no intro, straight punch",
    views: "1.1M",
    dur: "0:36",
    tag: "Cold open",
  },
  {
    poster: "https://picsum.photos/seed/reel03/360/640",
    src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
    handle: "@fitwithlara",
    hook: "Payoff at 0:19 — watch till end",
    views: "3.7M",
    dur: "0:42",
    tag: "Payoff",
  },
  {
    poster: "https://picsum.photos/seed/reel04/360/640",
    src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
    handle: "@indie_devlog",
    hook: "One sentence that made it viral",
    views: "892K",
    dur: "0:33",
    tag: "Viral line",
  },
  {
    poster: "https://picsum.photos/seed/reel05/360/640",
    src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
    handle: "@travel.juno",
    hook: "Punch-in + captions burned perfectly",
    views: "1.8M",
    dur: "0:24",
    tag: "Captions",
  },
  {
    poster: "https://picsum.photos/seed/reel06/360/640",
    src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
    handle: "@finance.bro",
    hook: "Hook → story → CTA in 29s",
    views: "4.2M",
    dur: "0:29",
    tag: "Structure",
  },
  {
    poster: "https://picsum.photos/seed/reel07/360/640",
    src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
    handle: "@chef.ali",
    hook: "9:16 crop kept the hands in frame",
    views: "967K",
    dur: "0:31",
    tag: "Crop",
  },
  {
    poster: "https://picsum.photos/seed/reel08/360/640",
    src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
    handle: "@yoga.with.nia",
    hook: "Whisper hook + hard cut",
    views: "1.5M",
    dur: "0:26",
    tag: "Cut",
  },
  {
    poster: "https://picsum.photos/seed/reel09/360/640",
    src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
    handle: "@gamer.tales",
    hook: "Comment bait at 0:22",
    views: "2.9M",
    dur: "0:38",
    tag: "Comment bait",
  },
  {
    poster: "https://picsum.photos/seed/reel10/360/640",
    src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
    handle: "@plant.mama",
    hook: "Before/after — retention spike",
    views: "1.3M",
    dur: "0:27",
    tag: "Retention",
  },
  {
    poster: "https://picsum.photos/seed/reel11/360/640",
    src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
    handle: "@dance.crew.id",
    hook: "Beat-synced cuts hit different",
    views: "5.1M",
    dur: "0:21",
    tag: "Sync",
  },
  {
    poster: "https://picsum.photos/seed/reel12/360/640",
    src: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
    handle: "@tech unpacked",
    hook: "Caption style that stops the scroll",
    views: "876K",
    dur: "0:34",
    tag: "Style",
  },
];

function ReelCard({ r }: { r: Reel }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) v.play().catch(() => {});
          else v.pause();
        });
      },
      { threshold: 0.35 }
    );
    io.observe(v);
    return () => io.disconnect();
  }, []);

  return (
    <div className="group relative overflow-hidden rounded-[20px] border border-line bg-surface-1">
      <div className="aspect-[9/16] relative bg-canvas">
        <video
          ref={ref}
          poster={r.poster}
          src={r.src}
          muted
          loop
          playsInline
          preload="metadata"
          className="absolute inset-0 h-full w-full object-cover"
        />
        {/* soft film grain over video */}
        <div className="pointer-events-none absolute inset-0 opacity-[0.06] mix-blend-overlay" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E")` }} />
        {/* top bar */}
        <div className="absolute left-2 right-2 top-2 flex items-center justify-between">
          <span className="rounded-full bg-black/55 px-2.5 py-1 text-[10px] font-medium tracking-wide text-white backdrop-blur">
            {r.tag}
          </span>
          <span className="rounded-full bg-black/55 px-2 py-1 font-mono text-[10px] text-white backdrop-blur tabular-nums">
            {r.dur}
          </span>
        </div>
        {/* play hint */}
        <div className="absolute left-1/2 top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-ink opacity-0 shadow-lg backdrop-blur transition-opacity group-hover:opacity-100">
          <Play size={14} weight="fill" className="ml-0.5" />
        </div>
        {/* bottom scrim */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/30 to-transparent p-3 pt-10">
          <p className="text-[13px] font-medium leading-tight text-white">{r.hook}</p>
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-xs text-white/80">{r.handle}</span>
            <span className="font-mono text-[11px] text-white/70 tabular-nums">{r.views} views</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Column({ items, variant }: { items: Reel[]; variant: "up" | "down" }) {
  const doubled = [...items, ...items];
  return (
    <div className="relative overflow-hidden">
      <div
        className={`flex flex-col gap-4 ${variant === "up" ? "animate-marquee-up" : "animate-marquee-down"}`}
      >
        {doubled.map((r, i) => (
          <ReelCard key={`${r.handle}-${i}`} r={r} />
        ))}
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-canvas to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-canvas to-transparent" />
    </div>
  );
}

export function ReelsWall() {
  const col1 = REELS.slice(0, 4);
  const col2 = REELS.slice(4, 8);
  const col3 = REELS.slice(8, 12);
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 md:gap-5">
      <Column items={col1} variant="up" />
      <Column items={col2} variant="down" />
      <div className="hidden md:block">
        <Column items={col3} variant="up" />
      </div>
    </div>
  );
}
