"use client";

import { Check, Coins, Cube, Database, Lightning, Warning } from "@phosphor-icons/react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  loadSnap,
  useBilling,
  useCheckout,
  useInvalidateBilling,
  useTransactions,
} from "@/hooks/use-billing";
import type { BillingStatus, CreditPack, EntitlementLimits, TopUpPack, Transaction } from "@/hooks/types";

type SnapWindow = Window & {
  snap?: {
    pay: (
      token: string,
      options?: {
        onSuccess?: (result: unknown) => void;
        onPending?: (result: unknown) => void;
        onError?: (result: unknown) => void;
        onClose?: () => void;
      }
    ) => void;
  };
};

export default function BillingPage() {
  const billing = useBilling();
  const checkout = useCheckout();
  const invalidateBilling = useInvalidateBilling();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const status = billing.data;

  function buy(packKey: string) {
    setError("");
    setNotice("");
    checkout.mutate(packKey as never, {
      onSuccess: (data) => {
        if (data.provider !== "midtrans" && data.url) {
          window.location.href = data.url;
          return;
        }
        void openMidtrans(data);
      },
      onError: (err) => setError(err.message),
    });
  }

  /** Opens the Midtrans Snap popup and syncs entitlements on completion. */
  async function openMidtrans(data: {
    token?: string | null;
    client_key?: string | null;
    snap_js_url?: string | null;
  }) {
    try {
      await loadSnap(data.snap_js_url ?? "", data.client_key ?? "");
      const snap = (window as SnapWindow).snap;
      if (!snap || !data.token) throw new Error("Midtrans Snap unavailable.");
      snap.pay(data.token, {
        onSuccess: () => {
          setNotice("Payment received — your credits are ready.");
          invalidateBilling();
        },
        onPending: () =>
          setNotice(
            "Payment pending. Complete it (e.g. bank transfer / QRIS) — your credits are added as soon as it settles."
          ),
        onError: () => setError("Payment failed. Try again or pick another method."),
        onClose: () =>
          setNotice("Payment window closed before completing — no charge was made."),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start payment.");
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Credits &amp; packs</h1>
        <p className="mt-1 text-sm text-ink-tertiary">
          Pay per clip — no subscriptions. Each credit is one minute of source video;
          1 credit = 1 analyzed minute of your video.
        </p>
      </div>

      {status && <CurrentTier status={status} />}

      {status && <CreditBalance status={status} />}

      {status && <UsageMeters status={status} />}

      {error && (
        <p className="flex items-center gap-1.5 text-sm text-danger">
          <Warning size={14} weight="fill" />
          {error}
        </p>
      )}
      {!error && notice && (
        <p className="flex items-center gap-1.5 text-sm text-success">
          <Check size={14} weight="bold" />
          {notice}
        </p>
      )}

      <PackPicker
        packs={status?.packs ?? []}
        onSelect={buy}
        busy={checkout.isPending}
      />

      <TopUpPicker topups={status?.topups ?? []} onSelect={buy} busy={checkout.isPending} />

      <TransactionHistory />

      <p className="text-xs text-ink-muted">
        Buying any pack permanently unlocks its storage/projects/resolution and removes the
        watermark — the bigger the pack you&apos;ve ever bought, the better your limits, forever.
        {status?.byok_enabled && (
          <>
            {" "}
            Bring your own API keys under{" "}
            <Link href="/app/settings" className="text-ink-tertiary hover:text-ink underline-offset-2 hover:underline">
              Settings
            </Link>
            .
          </>
        )}
      </p>
    </div>
  );
}

function CurrentTier({ status }: { status: BillingStatus }) {
  return (
    <Card className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-xs uppercase tracking-wider text-ink-tertiary">Current tier</p>
        <p className="mt-1 flex items-center gap-2">
          <span className="inline-flex items-center rounded-full bg-accent px-2.5 py-0.5 text-xs font-semibold text-accent-ink">{status.tier_name}</span>
          <span className="text-xs text-ink-tertiary">{status.tier}</span>
        </p>
        <p className="mt-2 text-xs text-ink-tertiary">
          {status.limits.max_resolution ? `Up to ${status.limits.max_resolution}p` : "Source resolution"} · {status.limits.max_projects == null ? "Unlimited projects" : `${status.limits.max_projects} projects`} · {fmtBytes(status.limits.storage_cap_bytes)} storage · {status.limits.watermark ? "Watermark" : "No watermark"}
        </p>
      </div>
      <div className="text-xs text-ink-muted">Permanent — never downgrades</div>
    </Card>
  );
}

function CreditBalance({ status }: { status: BillingStatus }) {
  return (
    <Card className="flex items-center justify-between gap-4 p-5">
      <div>
        <p className="text-xs uppercase tracking-wider text-ink-tertiary">Credit balance</p>
        <p className="mt-1 flex items-baseline gap-1.5">
          <span className="text-3xl font-semibold tracking-tight text-ink tabular-nums">
            {fmtCredits(status.credits)}
          </span>
          <span className="text-sm text-ink-tertiary">min {fmtHours(status.credits)}</span>
        </p>
      </div>
      <Coins size={32} className="text-accent" weight="duotone" />
    </Card>
  );
}

/** Two meters driven straight off the /billing/status usage payload. */
function UsageMeters({ status }: { status: BillingStatus }) {
  const { usage, limits } = status;
  const storagePct =
    limits.storage_cap_bytes > 0 ? (usage.storage_used_bytes / limits.storage_cap_bytes) * 100 : 0;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Meter
        icon={<Database size={16} weight="fill" />}
        label="Storage"
        used={`${fmtBytes(usage.storage_used_bytes)} / ${fmtBytes(limits.storage_cap_bytes)}`}
        pct={Math.min(100, storagePct)}
        warn={storagePct >= 90}
      />
      <Meter
        icon={<Cube size={16} weight="fill" />}
        label="Projects"
        used={
          limits.max_projects == null
            ? `${usage.projects} / ∞`
            : `${usage.projects} / ${limits.max_projects}`
        }
        pct={
          limits.max_projects == null
            ? 0
            : Math.min(100, (usage.projects / limits.max_projects) * 100)
        }
        warn={limits.max_projects != null && usage.projects >= limits.max_projects}
      />
    </div>
  );
}

function Meter({
  icon,
  label,
  used,
  pct,
  warn,
}: {
  icon: React.ReactNode;
  label: string;
  used: string;
  pct: number;
  warn: boolean;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-ink">
        <span className="text-accent">{icon}</span>
        {label}
      </div>
      <p className="mt-1 text-xs text-ink-tertiary tabular-nums">{used}</p>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ease-out ${warn ? "bg-danger" : "bg-accent"}`}
          style={{ width: `${Math.max(pct, pct > 0 ? 2 : 0)}%` }}
        />
      </div>
    </Card>
  );
}

function PackPicker({
  packs,
  onSelect,
  busy,
}: {
  packs: CreditPack[];
  onSelect: (key: string) => void;
  busy: boolean;
}) {
  const idr = Intl.DateTimeFormat().resolvedOptions().timeZone?.startsWith("Asia/");
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {packs.map((pack) => {
        return (
          <Card key={pack.key} className="flex flex-col gap-4 p-5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                  <Lightning size={14} weight="fill" className="text-accent" />
                  {pack.name}
                </p>
                <p className="mt-0.5 text-xs text-ink-tertiary">{fmtCredits(pack.credits)} credits · {fmtHours(pack.credits)}</p>
              </div>
              <span className="shrink-0 text-xl font-semibold tracking-tight text-ink tabular-nums">
                {idr ? `Rp${(pack.price_idr ?? 0).toLocaleString("id-ID")}` : `$${fmtUSD(pack.price_usd_cents ?? Math.round(pack.price_usd * 100))}`}
              </span>
            </div>

            <FeatureList limits={pack.limits} credits={pack.credits} />

            <Button className="mt-auto" variant="primary" disabled={busy} onClick={() => onSelect(pack.key)}>
              {busy ? "Opening checkout…" : "Buy pack"}
            </Button>
          </Card>
        );
      })}
    </div>
  );
}

function TopUpPicker({
  topups,
  onSelect,
  busy,
}: {
  topups: TopUpPack[];
  onSelect: (key: string) => void;
  busy: boolean;
}) {
  const idr = Intl.DateTimeFormat().resolvedOptions().timeZone?.startsWith("Asia/");
  if (!topups.length) return null;
  return (
    <div>
      <h2 className="text-sm font-semibold text-ink">Top up minutes</h2>
      <p className="mt-1 text-xs text-ink-tertiary">Add credits without changing your tier — pay as you go.</p>
      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
        {topups.map((t) => (
          <Card key={t.key} className="flex flex-col gap-3 p-4">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-ink">{t.name}</p>
              <span className="text-sm font-semibold tabular-nums text-ink">
                {idr ? `Rp${(t.price_idr ?? 0).toLocaleString("id-ID")}` : `$${fmtUSD(t.price_usd_cents ?? Math.round(t.price_usd * 100))}`}
              </span>
            </div>
            <p className="text-xs text-ink-tertiary">+{fmtCredits(t.credits)} min {fmtHours(t.credits)}</p>
            <Button className="mt-auto" variant="secondary" disabled={busy} onClick={() => onSelect(t.key)}>
              {busy ? "Opening…" : "Top up"}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}

function FeatureList({ limits, credits }: { limits: EntitlementLimits; credits: number }) {
  return (
    <ul className="flex flex-col gap-1.5 text-sm text-ink-secondary">
      <Feature done>{fmtCredits(credits)} prepaid minutes {fmtHours(credits) !== "" ? `(${fmtHours(credits).trim()})` : ""}</Feature>
      <Feature done>No watermark on exports</Feature>
      <Feature done>
        {limits.max_resolution ? `Up to ${limits.max_resolution}p` : "Source resolution"}
      </Feature>
      <Feature done>
        {limits.max_projects == null
          ? "Unlimited projects"
          : `${limits.max_projects} projects`}
      </Feature>
      <Feature>{fmtBytes(limits.storage_cap_bytes)} storage</Feature>
    </ul>
  );
}

function Feature({ done, children }: { done?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      {done ? (
        <Check size={14} weight="bold" className="text-accent" />
      ) : (
        <span className="h-2 w-2 rounded-full bg-surface-2" />
      )}
      <span>{children}</span>
    </li>
  );
}

function TransactionHistory() {
  const { data, isLoading } = useTransactions();
  if (isLoading) return <Card className="p-4 text-sm text-ink-tertiary">Loading transactions…</Card>;
  if (!data || data.length === 0) {
    return (
      <Card className="p-5">
        <h2 className="text-sm font-semibold text-ink">Transaction history</h2>
        <p className="mt-1 text-sm text-ink-tertiary">No transactions yet — your purchases will appear here.</p>
      </Card>
    );
  }
  return (
    <Card className="overflow-hidden p-0">
      <div className="border-b border-line px-5 py-3">
        <h2 className="text-sm font-semibold text-ink">Transaction history</h2>
        <p className="text-xs text-ink-tertiary">All your credit purchases — packs and top-ups.</p>
      </div>
      <div className="divide-y divide-line">
        {data.map((t) => (
          <div key={t.order_id} className="flex items-center justify-between gap-4 px-5 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink truncate">{t.plan_name}</p>
              <p className="text-xs text-ink-tertiary">{t.created_at ? new Date(t.created_at).toLocaleString() : ""} · {t.provider === "midtrans" ? "Midtrans" : "Paddle"} · +{fmtCredits(t.credits)} min</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm font-semibold tabular-nums text-ink">{t.currency === "IDR" ? `Rp${Number(t.gross_amount).toLocaleString("id-ID")}` : `$${fmtUSD(Number(t.gross_amount))}`}</p>
              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${t.status === "settled" ? "bg-success/10 text-success" : t.status === "pending" ? "bg-amber-500/10 text-amber-600" : "bg-surface-2 text-ink-tertiary"}`}>{t.status}</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function fmtUSD(cents: number): string {
  const d = Math.trunc(cents / 100);
  const c = Math.abs(cents % 100);
  return `${d}.${String(c).padStart(2, "0")}`;
}

function fmtCredits(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtHours(mins: number): string {
  if (mins < 60) return "";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (m === 0) return `· ${h}h`;
  return `· ${h}h ${m}m`;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(0)}GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}