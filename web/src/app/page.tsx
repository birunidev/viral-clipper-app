import { Lightning, Play, Scissors, Waveform } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

function ClipPreview() {
  // A real mini-UI specimen rendered inline — the ClipForge signature:
  // timestamp-forward clip cards + pipeline stages. Not a fake screenshot.
  const clips = [
    { t: "0:42 – 1:18", dur: "36s", title: "The hook that changed everything", hook: "This one sentence is why the video blew up." },
    { t: "2:05 – 2:51", dur: "46s", title: "The payoff", hook: "Everything clicks into place here." },
    { t: "4:12 – 4:30", dur: "18s", title: "Cold open", hook: "Straight into it — no intro." },
  ];
  return (
    <div className="w-full max-w-lg rounded-xl border border-line bg-surface-1 p-4">
      <div className="flex items-center justify-between border-b border-line-soft pb-3">
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-accent text-accent-ink">
            <Scissors size={11} weight="bold" />
          </span>
          <span className="text-xs font-medium text-ink">Podcast episode 42</span>
        </div>
        <span className="rounded-full border border-success/25 bg-success-soft px-2 py-0.5 text-[10px] font-medium text-success">
          Completed
        </span>
      </div>
      <div className="flex flex-col divide-y divide-line-soft">
        {clips.map((c) => (
          <div key={c.title} className="flex items-center gap-3 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-ink-tertiary">
              <Play size={13} weight="fill" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-ink">{c.title}</p>
              <p className="truncate text-xs text-ink-muted">{c.hook}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="font-mono text-xs text-ink tabular-nums">{c.t}</p>
              <p className="text-[10px] text-ink-muted tabular-nums">{c.dur}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <main className="grain flex flex-1 flex-col">
      {/* Nav */}
      <header className="flex items-center justify-between px-6 py-5 md:px-10">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-accent-ink">
            <Scissors size={15} weight="bold" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-ink">ClipForge</span>
        </Link>
        <nav className="flex items-center gap-2">
          <Link
            href="/app/login"
            className="rounded-lg px-3.5 py-2 text-sm text-ink-tertiary transition-colors hover:text-ink"
          >
            Sign in
          </Link>
          <Link
            href="/app/register"
            className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-strong"
          >
            Get started
          </Link>
        </nav>
      </header>

      {/* Hero — asymmetric: left copy, right live product preview */}
      <section className="grid flex-1 items-center gap-12 px-6 pb-20 pt-10 md:px-10 lg:grid-cols-[1fr_1.1fr] lg:pt-16">
        <div className="flex flex-col gap-6">
          <p className="inline-flex w-fit items-center gap-2 rounded-full border border-line px-3 py-1 text-xs text-ink-tertiary">
            <Waveform size={13} className="text-accent" />
            Built for long-form → short-form
          </p>
          <h1 className="max-w-xl text-4xl font-semibold leading-[1.05] tracking-tighter text-ink balance sm:text-5xl md:text-6xl">
            Long videos in.
            <br />
            <span className="text-ink-tertiary">Viral clips out.</span>
          </h1>
          <p className="max-w-md text-base leading-relaxed text-ink-tertiary pretty">
            Paste a YouTube link or upload a file. ClipForge transcribes it,
            finds the moments that hook, and cuts them to 9:16 — automatically.
          </p>
          <div className="flex items-center gap-3">
            <Link
              href="/app/register"
              className="inline-flex h-11 items-center justify-center rounded-lg bg-accent px-5 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-strong"
            >
              Start clipping
            </Link>
            <Link
              href="/app/login"
              className="inline-flex h-11 items-center justify-center rounded-lg border border-line px-5 text-sm font-medium text-ink-secondary transition-colors hover:bg-surface-1 hover:text-ink"
            >
              Sign in
            </Link>
          </div>
        </div>

        <div className="flex justify-center lg:justify-end">
          <ClipPreview />
        </div>
      </section>

      {/* Pipeline strip — the signature, as its own section */}
      <section className="border-t border-line bg-surface-1 px-6 py-14 md:px-10">
        <div className="mx-auto grid max-w-5xl gap-8 md:grid-cols-3">
          {[
            { icon: Waveform, step: "01", title: "Transcribe", body: "Every word of the source, timestamped." },
            { icon: Lightning, step: "02", title: "Analyze", body: "The hook, the payoff, the cold open — found by the model." },
            { icon: Scissors, step: "03", title: "Cut", body: "9:16, 16:9, or original. Ready to post." },
          ].map(({ icon: Icon, step, title, body }) => (
            <div key={step} className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-ink-muted tabular-nums">{step}</span>
                <Icon size={15} className="text-accent" />
              </div>
              <p className="text-base font-semibold text-ink">{title}</p>
              <p className="text-sm leading-relaxed text-ink-tertiary pretty">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="flex items-center justify-between border-t border-line px-6 py-5 md:px-10">
        <span className="text-xs text-ink-muted">ClipForge — private by default, runs locally.</span>
        <Link href="/app/login" className="text-xs text-ink-tertiary hover:text-ink">
          Sign in
        </Link>
      </footer>
    </main>
  );
}
