import type { Metadata } from "next";
import Link from "next/link";
import { DownloadSimple, WindowsLogo, AppleLogo, LinuxLogo, Check, Warning } from "@phosphor-icons/react/dist/ssr";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Download ClipZard Desktop",
  description: "Download ClipZard Desktop for Windows, macOS, and Linux — free, auto-licensed on sign-up.",
  alternates: { canonical: "/download" },
};

type Release = {
  platform: string;
  arch: string;
  version: string;
  size_bytes: number;
  sha512: string;
  release_notes: string;
  download_url: string;
  is_beta: boolean;
  created_at: string | null;
};

async function getReleases(): Promise<Release[]> {
  const base = process.env.NEXT_PUBLIC_API_URL ?? "https://clipzard.web.id/api/v1";
  const url = base.replace(/\/api\/v1.*/, "") + "/api/v1/update/releases";
  try {
    const res = await fetch(url, { next: { revalidate: 300 } });
    if (!res.ok) return [];
    return (await res.json()) as Release[];
  } catch {
    return [];
  }
}

function fmtMB(bytes: number): string {
  if (!bytes) return "—";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function platformLabel(p: string, a: string): string {
  const plat = p === "win32" ? "Windows" : p === "darwin" ? "macOS" : "Linux";
  return `${plat} (${a})`;
}

function PlatformIcon({ platform }: { platform: string }) {
  if (platform === "win32") return <WindowsLogo size={18} weight="fill" />;
  if (platform === "darwin") return <AppleLogo size={18} weight="fill" />;
  return <LinuxLogo size={18} weight="fill" />;
}

export default async function DownloadPage() {
  const releases = await getReleases();
  // Prefer x64 stable builds for display order
  const order = ["win32:x64", "darwin:arm64", "darwin:x64", "linux:x64"];
  const sorted = [...releases].sort((a, b) => {
    const ka = `${a.platform}:${a.arch}`;
    const ba = `${b.platform}:${b.arch}`;
    const ia = order.indexOf(ka);
    const ib = order.indexOf(ba);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  return (
    <main className="grain flex flex-1 flex-col">
      <header className="sticky top-0 z-20 border-b border-line/60 bg-canvas/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1100px] items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <img src="/logo-with-text.png" alt="ClipZard" className="h-8 w-auto object-contain" />
          </Link>
          <Link href="/app/login" className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:bg-accent-strong">
            Sign in
          </Link>
        </div>
      </header>

      <section className="mx-auto w-full max-w-[1100px] px-6 py-10 md:py-14">
        <div className="mx-auto max-w-2xl text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">Download ClipZard Desktop</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-tertiary">
            Free for every account — sign up and your desktop license is auto-created (up to 3 devices, 100 free cloud minutes). Builds are fully local; credits only for cloud AI.
          </p>
          <p className="mt-2 text-xs text-ink-muted">One-time top-ups, no expiration, unlimited local projects &amp; storage.</p>
        </div>

        {sorted.length === 0 ? (
          <Card className="mx-auto mt-10 max-w-2xl p-6 text-center">
            <Warning size={20} className="mx-auto text-warning" weight="fill" />
            <p className="mt-2 text-sm font-medium text-ink">No builds published yet</p>
            <p className="mt-1 text-xs text-ink-tertiary">The team hasn&apos;t published a release for your platform. Check back soon or contact support.</p>
          </Card>
        ) : (
          <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {sorted.map((r) => (
              <Card key={`${r.platform}:${r.arch}:${r.version}`} className="flex flex-col gap-4 p-5">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-surface-2 text-ink">
                    <PlatformIcon platform={r.platform} />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-ink">{platformLabel(r.platform, r.arch)}</p>
                    <p className="text-xs text-ink-tertiary">v{r.version} · {fmtMB(r.size_bytes)}</p>
                  </div>
                  <span className="ml-auto rounded-full bg-success-soft px-2 py-0.5 text-[10px] font-medium text-success">stable</span>
                </div>
                {r.release_notes && (
                  <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2/50 px-3 py-2 text-xs text-ink-secondary">
                    {r.release_notes}
                  </pre>
                )}
                <div className="flex items-center gap-2 text-[11px] text-ink-muted">
                  <span>sha512 {r.sha512.slice(0, 12)}…</span>
                  {r.created_at && <span>· {new Date(r.created_at).toLocaleDateString()}</span>}
                </div>
                <a href={r.download_url} className="mt-auto inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink hover:bg-accent-strong">
                  <DownloadSimple size={16} weight="bold" />
                  Download
                </a>
              </Card>
            ))}
          </div>
        )}

        <Card className="mx-auto mt-8 max-w-2xl p-5">
          <p className="flex items-center gap-2 text-sm font-medium text-ink">
            <Check size={14} weight="bold" className="text-success" />
            How it works
          </p>
          <ol className="mt-3 flex list-decimal flex-col gap-1.5 pl-5 text-sm text-ink-secondary">
            <li>
              <Link href="/app/register" className="font-medium text-accent hover:underline">
                Create your free account
              </Link>{" "}
              — license auto-granted, 100 minutes included.
            </li>
            <li>Download and install the app for your OS above.</li>
            <li>Open the app and sign in — it validates via <code className="rounded bg-surface-2 px-1 py-0.5 text-xs">/entitlement/check</code> (up to 3 devices).</li>
            <li>Need more cloud minutes? Top up at <Link href="/app/billing" className="font-medium text-accent hover:underline">Billing</Link> — pay once, never expires.</li>
          </ol>
        </Card>
      </section>
    </main>
  );
}
