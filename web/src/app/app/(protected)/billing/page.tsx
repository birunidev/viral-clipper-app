"use client";

import { Check, Coins, Key, Warning } from "@phosphor-icons/react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useSession } from "@/hooks/use-auth";
import {
  loadSnap,
  useBilling,
  useCheckout,
  useInvalidateBilling,
  useTransactions,
} from "@/hooks/use-billing";
import type { BillingStatus, TopUpPack } from "@/hooks/types";

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
  const session = useSession();
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

  const isLicensed = session.data?.has_license ?? false;
  const userTier = session.data?.license_tier ?? null;
  const maxDevices = session.data?.max_devices ?? 0;
  const currentDevices = session.data?.current_device_count ?? 0;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Billing</h1>
        <p className="mt-1 text-sm text-ink-tertiary">
          Your desktop license is free for every account. Top up cloud credits for
          the AI transcriber &amp; analyser — one-time payment, no expiration, pay as you go.
        </p>
      </div>

      <DesktopLicenseCard
        isLicensed={isLicensed}
        tier={userTier}
        maxDevices={maxDevices}
        currentDevices={currentDevices}
      />

      {status && <CreditBalance status={status} />}

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

      <TopUpPicker topups={status?.topups ?? []} onSelect={buy} busy={checkout.isPending} />

      <TransactionHistory />

      <p className="text-xs text-ink-muted">
        Every new account starts with 100 free minutes. Clips and source files stay on
        your device — no storage or project limits. Credits are only for cloud
        transcription &amp; analysis.
        {status?.byok_enabled && (
          <>
            {" "}
            Bring your own API keys under{" "}
            <Link href="/app/licenses" className="text-ink-tertiary hover:text-ink underline-offset-2 hover:underline">
              Settings
            </Link>
            .
          </>
        )}
      </p>
    </div>
  );
}

/** Desktop license — auto-granted on signup, 3 devices, free. */
function DesktopLicenseCard({
  isLicensed,
  tier,
  maxDevices,
  currentDevices,
}: {
  isLicensed: boolean;
  tier: string | null;
  maxDevices: number;
  currentDevices: number;
}) {
  return (
    <Card className="p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <Key size={14} weight="fill" className="text-accent" />
            Desktop license
          </p>
          <p className="mt-2 text-sm text-ink-secondary">
            {isLicensed
              ? <>Your <span className="font-medium capitalize text-ink">{tier ?? "licensed"}</span> license is active — up to {maxDevices || 3} devices ({currentDevices} active). Download the desktop app and sign in.</>
              : "Your free desktop license will be created automatically when you sign up."}
          </p>
        </div>
        <Link
          href="/app/licenses"
          className="inline-flex h-9 items-center justify-center rounded-lg border border-line bg-surface-2 px-4 text-sm text-ink hover:bg-surface-3"
        >
          Manage devices →
        </Link>
      </div>
    </Card>
  );
}

function CreditBalance({ status }: { status: BillingStatus }) {
  return (
    <Card className="flex items-center justify-between gap-4 p-5">
      <div>
        <p className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-ink-tertiary">
          <Coins size={12} weight="fill" className="text-accent" />
          Cloud credit balance
        </p>
        <p className="mt-1 flex items-baseline gap-1.5">
          <span className="text-3xl font-semibold tracking-tight text-ink tabular-nums">
            {fmtCredits(status.credits)}
          </span>
          <span className="text-sm text-ink-tertiary">min {fmtHours(status.credits)}</span>
        </p>
        <p className="mt-1 text-xs text-ink-tertiary">1 credit = 1 minute · no expiration · one-time top-ups only</p>
      </div>
      <Coins size={32} className="text-accent" weight="duotone" />
    </Card>
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
      <h2 className="text-sm font-semibold text-ink">Top up cloud minutes</h2>
      <p className="mt-1 text-xs text-ink-tertiary">Pay once, never expires. Unlimited projects &amp; storage — credits only for cloud AI.</p>
      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
        {topups.map((t) => (
          <Card key={t.key} className="flex flex-col gap-3 p-4">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-ink">{t.name}</p>
              <span className="text-sm font-semibold tabular-nums text-ink">
                {idr ? `Rp${(t.price_idr ?? 0).toLocaleString("id-ID")}` : `$${fmtUSD(t.price_usd_cents ?? Math.round(t.price_usd * 100))}`}
              </span>
            </div>
            <p className="text-xs text-ink-tertiary">+{fmtCredits(t.credits)} min {fmtHours(t.credits)} · one-time</p>
            <Button className="mt-auto" variant="secondary" disabled={busy} onClick={() => onSelect(t.key)}>
              {busy ? "Opening…" : "Top up"}
            </Button>
          </Card>
        ))}
      </div>
    </div>
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