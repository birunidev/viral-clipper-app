"use client";

import { Star } from "@phosphor-icons/react";

type T = {
  quote: string;
  name: string;
  role: string;
  handle: string;
  avatar: string;
  metric: string;
  accent?: boolean;
};

const TESTIMONIALS: T[] = [
  { quote: "Cut 14 clips from one podcast. Three hit 1M+. I used to pay an editor for a week.", name: "Riko Saputra", role: "Podcast host", handle: "@suara.malam", avatar: "https://picsum.photos/seed/av01/96/96", metric: "2.7M total views", accent: true },
  { quote: "9:16 crop actually keeps the speaker centered. No more manual keyframes.", name: "Amara Chen", role: "Creator, 340k", handle: "@amara.cooks", avatar: "https://picsum.photos/seed/av02/96/96", metric: "38 clips this month" },
  { quote: "The hook detector is scary good. It found the cold open I would have skipped.", name: "Daniel Hart", role: "Youtuber", handle: "@hart.edit", avatar: "https://picsum.photos/seed/av03/96/96", metric: "+184% retention" },
  { quote: "We replaced our clip team. One link, 5 minutes, done for the whole week.", name: "Sinta Wijaya", role: "Agency owner", handle: "@kreatif.id", avatar: "https://picsum.photos/seed/av04/96/96", metric: "11 hrs saved / wk" },
  { quote: "Captions burned in with Anton — looks native, not AI. Clients love it.", name: "Jules Park", role: "Short-form editor", handle: "@jules.cuts", avatar: "https://picsum.photos/seed/av05/96/96", metric: "4.9★ client rating" },
  { quote: "Midtrans checkout for ID clients is perfect. GoPay in 2 taps.", name: "Budi Santoso", role: "Solo creator, Jakarta", handle: "@budi.vlog", avatar: "https://picsum.photos/seed/av06/96/96", metric: "Paid via QRIS" },
  { quote: "I upload the 2-hour stream, pick 6 hooks, render only what I like. No waste.", name: "Luna Rivera", role: "Streamer", handle: "@luna.plays", avatar: "https://picsum.photos/seed/av07/96/96", metric: "6 renders / stream" },
  { quote: "Thumbnail is auto-grabbed at the punch frame. Saves me an hour.", name: "Arman Q.", role: "Finance creator", handle: "@uang.pintar", avatar: "https://picsum.photos/seed/av08/96/96", metric: "CTR +22%" },
  { quote: "Private by default sold me. No random cloud training on my footage.", name: "Nadia Lee", role: "Doc filmmaker", handle: "@nadia.lens", avatar: "https://picsum.photos/seed/av09/96/96", metric: "Local mode user" },
  { quote: "The timeline words let me tweak captions word-by-word. No other tool does this.", name: "Eko Tanaka", role: "Editor", handle: "@eko.cuts", avatar: "https://picsum.photos/seed/av10/96/96", metric: "Word-level control" },
  { quote: "From YouTube URL to 9:16 in 3 minutes. My Shorts schedule is full for 10 days.", name: "Priya Nair", role: "Education channel, 520k", handle: "@priya.teaches", avatar: "https://picsum.photos/seed/av11/96/96", metric: "10 day backlog" },
  { quote: "We A/B two hooks per episode. ClipZard gives us both cuts instantly.", name: "Marco D.", role: "Podcast network", handle: "@signal.fm", avatar: "https://picsum.photos/seed/av12/96/96", metric: "A/B every ep" },
  { quote: "Watermark logic is fair — free tier watermarked, paid clean. No dark patterns.", name: "Hana Kim", role: "Student creator", handle: "@hana.makes", avatar: "https://picsum.photos/seed/av13/96/96", metric: "Free → Creator" },
  { quote: "Upload → transcribe → clips. No chasing YouTube re-downloads on preview.", name: "Oskar Berg", role: "Tech reviewer", handle: "@oskar.lab", avatar: "https://picsum.photos/seed/av14/96/96", metric: "Zero re-fetch" },
  { quote: "Pay per minute, not per month. I buy 300 credits and forget about billing.", name: "Dewi Lestari", role: "Lifestyle, 210k", handle: "@dewi.home", avatar: "https://picsum.photos/seed/av15/96/96", metric: "300 credits pack" },
  { quote: "4K render when I need it, 720 on free. Honest tiers.", name: "Jonah Pierce", role: "Studio owner", handle: "@pierce.studio", avatar: "https://picsum.photos/seed/av16/96/96", metric: "Studio tier" },
];

function Card({ t }: { t: T }) {
  return (
    <div
      className={`break-inside-avoid mb-4 rounded-2xl border p-5 ${t.accent ? "border-accent/25 bg-accent-soft" : "border-line bg-surface-1"}`}
    >
      <div className="flex gap-0.5 text-accent">
        {Array.from({ length: 5 }).map((_, i) => (
          <Star key={i} size={12} weight="fill" />
        ))}
      </div>
      <p className="mt-3 text-[14px] leading-relaxed text-ink pretty">“{t.quote}”</p>
      <div className="mt-4 flex items-center gap-3">
        <img src={t.avatar} alt={t.name} width={32} height={32} className="h-8 w-8 rounded-full object-cover ring-1 ring-line" loading="lazy" />
        <div className="min-w-0">
          <p className="text-[13px] font-medium leading-none text-ink">{t.name}</p>
          <p className="mt-1 text-xs leading-none text-ink-tertiary">{t.role} · {t.handle}</p>
        </div>
      </div>
      <p className="mt-3 font-mono text-[11px] tracking-wide text-ink-muted tabular-nums">{t.metric}</p>
    </div>
  );
}

export function TestimonialMasonry() {
  return (
    <div className="columns-1 gap-4 md:columns-2 lg:columns-3">
      {TESTIMONIALS.map((t) => (
        <Card key={t.name} t={t} />
      ))}
    </div>
  );
}

export function TestimonialCount() {
  return TESTIMONIALS.length;
}
