"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { BillingStatus } from "./types";

export const billingKey = ["billing", "status"] as const;

/** The browser's IANA timezone — Indonesian zones route to Midtrans. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

/** The user's current plan, entitlements & usage meters. */
export function useBilling() {
  return useQuery<BillingStatus>({
    queryKey: billingKey,
    queryFn: () => api.get<BillingStatus>("/billing/status"),
    // Entitlements change when a payment lands / a webhook syncs; keep it
    // reasonably fresh so a new plan shows up without a full reload.
    refetchInterval: 30_000,
  });
}

/**
 * Start a one-time checkout for a credit pack. The backend picks the gateway
 * from the browser timezone:
 * - `paddle`   → open `url` (hosted redirect; global Merchant of Record).
 * - `midtrans` → load `snap_js_url`, then `snap.pay(token)` with
 *   `client_key` (Snap popup; GoPay/OVO/QRIS/VA/cards).
 */
export type CheckoutResult = {
  provider: "paddle" | "midtrans";
  url?: string | null;
  token?: string | null;
  client_key?: string | null;
  snap_js_url?: string | null;
};

export function useCheckout() {
  return useMutation({
    mutationFn: (packKey: string) =>
      api.post<CheckoutResult>("/billing/checkout", {
        plan_key: packKey,
        timezone: browserTimezone(),
      }),
  });
}

/** Refetch billing status after a payment/webhook sync. */
export function useInvalidateBilling() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: billingKey });
}

// ------------------------------------------------------------------ snap.js

let snapPromise: Promise<void> | null = null;

/** Dynamically loads Midtrans's snap.js once (idempotent) and sets the
 * client key. Resolves when window.snap is available. */
export function loadSnap(snapJsUrl: string, clientKey: string): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  const w = window as unknown as { snap?: { pay: (...args: unknown[]) => void } };
  if (w.snap) return Promise.resolve();
  if (snapPromise) return snapPromise;

  snapPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = snapJsUrl;
    script.dataset.clientKey = clientKey;
    script.onload = () => resolve();
    script.onerror = () => {
      snapPromise = null;
      reject(new Error("Could not load Midtrans Snap."));
    };
    document.body.appendChild(script);
  });
  return snapPromise;
}
