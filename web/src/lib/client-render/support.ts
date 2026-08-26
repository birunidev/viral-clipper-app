import { canEncodeVideo } from "mediabunny";
import type { BillingStatus } from "@/hooks/types";

/**
 * Feature detection for client-side (WebCodecs) clip rendering. The browser
 * must decode + encode H.264 and provide OffscreenCanvas; the account must
 * have the server's CLIENT_RENDER flag on.
 */

export function clientRenderSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "VideoEncoder" in window &&
    "VideoDecoder" in window &&
    typeof OffscreenCanvas !== "undefined"
  );
}

/** Both halves of the gate: browser capability AND backend feature flag
 * (surfaced as `client_render` in GET /billing/status). */
export function clientRenderEnabled(billing: BillingStatus | undefined): boolean {
  return Boolean(billing?.client_render) && clientRenderSupported();
}

/** H.264 encoding support at portrait output size — checked lazily since it
 * is async. False → caller falls back to the server render path. */
export async function canEncodeH264(width = 720, height = 1280): Promise<boolean> {
  try {
    return await canEncodeVideo("avc", { width, height });
  } catch {
    return false;
  }
}
