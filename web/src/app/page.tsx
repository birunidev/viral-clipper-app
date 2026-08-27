import { ArrowRight, Check, Lightning, Play, Scissors, Sparkle, Star, Waveform } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { HeroReel } from "@/components/landing/hero-reel";
import { ReelsWall } from "@/components/landing/reels-wall";
import { TestimonialMasonry } from "@/components/landing/testimonial-masonry";

function PricingTier({
  name,
  price,
  sub,
  features,
  cta,
  highlight,
}: {
  name: string;
  price: string;
  sub: string;
  features: string[];
  cta: string;
  highlight: boolean;
}) {
  return (
    <div
      className={`flex flex-col rounded-[20px] border p-6 text-left ${
        highlight
          ? "border-accent/30 bg-surface-1 shadow-[0_0_0_1px_rgba(246,64,63,0.08),0_12px_40px_-16px_rgba(0,0,0,0.35)]"
          : "border-line bg-surface-1/60"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-ink">{name}</p>
          <p className="mt-1 text-xs text-ink-muted">{sub}</p>
        </div>
        <p className="text-right tabular-nums">
          <span className="text-2xl font-semibold tracking-tight text-ink">{price}</span>
          {price !== "$0" && <span className="ml-1 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium tracking-wide text-accent">one-time purchase</span>}
        </p>
      </div>
      <ul className="mt-6 flex flex-1 flex-col gap-2.5">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-sm leading-relaxed text-ink-tertiary">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
              <Check size={11} weight="bold" />
            </span>
            {f}
          </li>
        ))}
      </ul>
      <Link
        href="/app/register"
        className={`mt-6 inline-flex h-10 items-center justify-center gap-1.5 rounded-full text-sm font-medium transition-[transform,background-color] active:scale-[0.98] ${
          highlight
            ? "bg-accent text-accent-ink hover:bg-accent-strong"
            : "border border-line bg-surface-2 text-ink hover:bg-surface-1"
        }`}
      >
        {cta} <ArrowRight size={14} />
      </Link>
    </div>
  );
}



export default function HomePage() {
  return (
    <main className="grain flex flex-1 flex-col">
      {/* Nav */}
      <header className="sticky top-0 z-20 border-b border-line/60 bg-canvas/80 backdrop-blur supports-[backdrop-filter]:bg-canvas/60">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6 py-4 md:px-10">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-accent-ink">
              <Scissors size={15} weight="bold" />
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-ink">SnapClip</span>
          </Link>
          <nav className="flex items-center gap-2">
            <Link href="/terms" className="hidden rounded-full px-3.5 py-2 text-sm text-ink-tertiary transition-colors hover:text-ink md:inline-flex">
              Terms
            </Link>
            <Link href="/app/login" className="rounded-full px-3.5 py-2 text-sm text-ink-tertiary transition-colors hover:text-ink">
              Sign in
            </Link>
            <Link href="/app/register" className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-strong">
              Get started
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero — split: copy left, phone right */}
      <section className="mx-auto grid w-full max-w-[1400px] items-center gap-10 px-6 pb-12 pt-10 md:px-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12 lg:pt-14">
        <div className="flex flex-col gap-6">
          <p className="inline-flex w-fit items-center gap-2 rounded-full border border-line bg-surface-1 px-3 py-1 text-xs text-ink-tertiary">
            <Waveform size={13} className="text-accent" />
            Built for long-form → short-form
            <span className="hidden items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] text-accent sm:inline-flex">9:16 · 16:9 · original</span>
          </p>
          <h1 className="max-w-[18ch] text-4xl font-semibold leading-[1.02] tracking-tighter text-ink balance sm:text-5xl lg:text-6xl">
            Long videos in.
            <br />
            <span className="text-ink-tertiary">Viral clips out.</span>
          </h1>
          <p className="max-w-[48ch] text-base leading-relaxed text-ink-tertiary pretty">
            Paste a YouTube link or upload a file. SnapClip transcribes, finds the hooks, and cuts ready-to-post 9:16 clips — captioned if you want.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/app/register" className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-accent px-6 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-strong">
              Start clipping <ArrowRight size={14} />
            </Link>
            <Link href="/app/login" className="inline-flex h-11 items-center justify-center rounded-full border border-line bg-surface-1 px-6 text-sm font-medium text-ink-secondary transition-colors hover:bg-surface-2 hover:text-ink">
              Sign in
            </Link>
            <span className="text-xs text-ink-muted">No credit card · 5 free credits</span>
          </div>
          <div className="flex items-center gap-3 pt-1 text-xs text-ink-muted">
            <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-success" /> Pay per minute, not per month</span>
            <span className="h-3 w-px bg-line" />
            <span>Private by default · runs locally</span>
          </div>
        </div>
        <HeroReel />
      </section>

      {/* Reels wall — the proof, auto-scrolling 9:16 */}
      <section className="border-t border-line bg-surface-1/40 px-6 py-14 md:px-10">
        <div className="mx-auto max-w-[1400px]">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-1 px-3 py-1 font-mono text-[10.5px] uppercase tracking-[0.18em] text-ink-tertiary">Real outputs · 9:16</p>
              <h2 className="mt-3 max-w-[22ch] text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Customer results, straight from the pipeline.</h2>
              <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-ink-tertiary pretty">Every card is a generated clip — cropped, captioned, and ready to post. Auto-scrolling so you feel the volume. Hover to pause.</p>
            </div>
            <div className="flex items-center gap-2 text-xs text-ink-muted">
              <Play size={12} weight="fill" className="text-accent" /> muted autoplay · hover to pause
            </div>
          </div>
          <div className="mt-8">
            <ReelsWall />
          </div>
          <p className="mt-4 text-center font-mono text-[11px] tracking-wide text-ink-muted tabular-nums">12 examples · hundreds more inside · 720p preview, render to 4K on paid packs</p>
        </div>
      </section>

      {/* How it works — bento, not 3 equal cards */}
      <section className="border-t border-line bg-surface-1 px-6 py-14 md:px-10">
        <div className="mx-auto grid max-w-[1400px] gap-5 lg:grid-cols-[1.35fr_0.85fr]">
          {/* large tile */}
          <div className="rounded-[20px] border border-line bg-canvas p-6 md:p-8">
            <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-muted"><span className="h-1.5 w-1.5 rounded-full bg-accent" /> Pipeline</div>
            <h3 className="mt-3 text-xl font-semibold tracking-tight text-ink">Three steps. No timeline scrubbing.</h3>
            <div className="mt-6 grid gap-6 md:grid-cols-3">
              {[
                { icon: Waveform, step: "01", title: "Transcribe", body: "Every word timestamped. AssemblyAI or local whisper." },
                { icon: Lightning, step: "02", title: "Analyze", body: "Model finds hook, payoff, cold open — not just highlights." },
                { icon: Scissors, step: "03", title: "Cut", body: "Cropped to 9:16, captioned if you want. One tap render." },
              ].map(({ icon: Icon, step, title, body }) => (
                <div key={step} className="flex flex-col gap-2 border-t border-line-soft pt-4">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-ink-muted tabular-nums">{step}</span>
                    <Icon size={14} className="text-accent" />
                  </div>
                  <p className="text-sm font-semibold text-ink">{title}</p>
                  <p className="text-sm leading-relaxed text-ink-tertiary pretty">{body}</p>
                </div>
              ))}
            </div>
            <div className="mt-7 flex flex-wrap gap-2 font-mono text-xs">
              <span className="rounded-full border border-line bg-surface-1 px-3 py-1 text-ink-tertiary">yt-dlp capped at 1080p</span>
              <span className="rounded-full border border-line bg-surface-1 px-3 py-1 text-ink-tertiary">ffmpeg smart crop</span>
              <span className="rounded-full border border-line bg-surface-1 px-3 py-1 text-ink-tertiary">presigned R2 uploads</span>
            </div>
          </div>
          {/* stacked side tiles */}
          <div className="flex flex-col gap-5">
            <div className="rounded-[20px] border border-line bg-canvas p-6">
              <p className="flex items-center gap-2 text-sm font-semibold text-ink"><Sparkle size={14} className="text-accent" /> Captions that pop</p>
              <p className="mt-2 text-sm leading-relaxed text-ink-tertiary pretty">Word-level timing → burnt-in with your style (Anton, Space Grotesk, or custom). Preview instantly, render when ready.</p>
              <div className="mt-4 flex gap-2">
                <span className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-ink">Anton</span>
                <span className="rounded-full border border-line bg-surface-1 px-3 py-1 text-xs text-ink-tertiary">Space Grotesk</span>
              </div>
            </div>
            <div className="rounded-[20px] border border-line bg-canvas p-6">
              <p className="text-sm font-semibold text-ink">You keep the source</p>
              <p className="mt-2 text-sm leading-relaxed text-ink-tertiary pretty">We store the canonical source in R2. Previews seek it; renders cut from it. No re-downloading YouTube on every clip.</p>
              <p className="mt-3 font-mono text-xs text-ink-muted tabular-nums">200MB free · 5GB Creator · 20GB Studio</p>
            </div>
          </div>
        </div>
      </section>

      {/* Testimonials — masonry, lots */}
      <section className="border-t border-line px-6 py-14 md:px-10">
        <div className="mx-auto max-w-[1400px]">
          <div className="mx-auto max-w-2xl text-center">
            <p className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-1 px-3 py-1 font-mono text-[10.5px] uppercase tracking-[0.18em] text-ink-tertiary">Wall of love</p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Loved by podcasters, editors, and teams who live on Shorts.</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-tertiary pretty">16 real-world outcomes. Not the 3-card carousel every AI landing ships. Skim the wall — every card is a different workflow.</p>
          </div>
          <div className="mt-8">
            <TestimonialMasonry />
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2 font-mono text-[11px] text-ink-muted">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-1 px-3 py-1"><Star size={11} weight="fill" className="text-accent" /> 4.8 avg from early users</span>
            <span className="hidden h-3 w-px bg-line sm:block" />
            <span>Private feedback · no paid placements</span>
          </div>
        </div>
      </section>

      {/* Logo marquee — single per page */}
      <section className="overflow-hidden border-y border-line bg-surface-1 py-5">
        <div className="flex animate-marquee-x gap-8 whitespace-nowrap will-change-transform">
          {[...Array(2)].map((_, dup) => (
            <div key={dup} className="flex items-center gap-8 pr-8">
              {["Podvault", "KreatifID", "Signal.fm", "Suara Malam", "Hart Edit", "Nadia Lens", "Priya Teaches", "Oskar Lab", "Dewi Home", "FitWithLara", "Uang Pintar"].map((brand) => (
                <span key={`${dup}-${brand}`} className="inline-flex items-center gap-2 text-sm font-medium tracking-tight text-ink-tertiary">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full border border-line bg-canvas text-[10px] font-semibold text-ink-muted">{brand[0]}</span>
                  {brand}
                </span>
              ))}
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section className="border-t border-line bg-surface-1/40 px-6 py-14 md:px-10">
        <div className="mx-auto max-w-[1400px]">
          <div className="mx-auto max-w-2xl text-center">
            <p className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-1 px-3 py-1 text-xs text-ink-tertiary">Pay per clip — no monthly plans</p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Buy credits once. Cut as much as you want.</h2>
            <p className="mt-2 text-sm text-ink-tertiary">1 credit = 1 minute of source video. Packs never expire.</p>
          </div>
          <div className="mx-auto mt-10 grid max-w-4xl gap-5 md:grid-cols-3">
            <PricingTier name="Free" price="$0" sub="Start free, watermarked 720p" features={["5 free credits to start", "200MB storage", "Up to 3 projects", "720p + watermark"]} cta="Start free" highlight={false} />
            <PricingTier name="Creator" price="$12.90" sub="Most popular — clean 1080p" features={["300 credits one-time", "5GB storage", "Unlimited projects", "1080p, no watermark"]} cta="Buy Creator" highlight={true} />
            <PricingTier name="Studio" price="$39" sub="For teams & heavy uploaders" features={["1,200 credits one-time", "20GB storage", "Unlimited projects", "Up to 4K, no watermark"]} cta="Buy Studio" highlight={false} />
          </div>
          <p className="mx-auto mt-8 max-w-2xl text-center text-xs leading-relaxed text-ink-muted pretty">
            Credits never expire and bigger packs permanently unlock more storage, resolution, and project slots. In Indonesia? Pay in rupiah with GoPay, QRIS, bank transfer, or card.
          </p>
        </div>
      </section>

      {/* Final CTA */}
      <section className="px-6 py-12 md:px-10">
        <div className="mx-auto flex max-w-[1400px] flex-col items-center justify-between gap-6 rounded-[24px] border border-line bg-surface-1 p-8 md:flex-row md:p-10">
          <div>
            <h3 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Paste a link. Get clips.</h3>
            <p className="mt-1 max-w-[50ch] text-sm leading-relaxed text-ink-tertiary pretty">YouTube or upload. We transcribe, find the hooks, and cut them to 9:16 — captioned if you want.</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <Link href="/app/register" className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-accent px-6 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-strong">
              Start clipping <ArrowRight size={14} />
            </Link>
            <Link href="/terms" className="hidden text-xs text-ink-muted underline underline-offset-4 hover:text-ink md:inline">
              Terms apply
            </Link>
          </div>
        </div>
      </section>

      <footer className="flex flex-col gap-3 border-t border-line px-6 py-6 md:flex-row md:items-center md:justify-between md:px-10">
        <span className="text-xs leading-relaxed text-ink-muted">SnapClip — private by default, runs locally. © 2026 BiruniDev. <Link href="mailto:hello@birunidev.com" className="underline underline-offset-4 hover:text-ink">hello@birunidev.com</Link></span>
        <nav className="flex items-center gap-4 text-xs">
          <Link href="/terms" className="text-ink-tertiary hover:text-ink">Terms</Link>
          <Link href="/privacy" className="text-ink-tertiary hover:text-ink">Privacy</Link>
          <Link href="/app/login" className="text-ink-tertiary hover:text-ink">Sign in</Link>
        </nav>
      </footer>
    </main>
  );
}
