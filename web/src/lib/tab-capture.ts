"use client";

// Helpers for getDisplayMedia tab capture + feature detection + optional CropTarget.

export function hasDisplayMediaSupport(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
}

export function isSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // Safari without Chrome/Chromium
  return /Safari/i.test(ua) && !/Chrome|Chromium|Edg/i.test(ua);
}

export function tabAudioLikelyUnsupported(): boolean {
  // Safari does not support tab audio capture via getDisplayMedia
  // https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
  return isSafari();
}

export type TabCaptureStream = MediaStream;

export async function requestTabCaptureStream(): Promise<TabCaptureStream> {
  if (!hasDisplayMediaSupport()) {
    throw new Error("Tab capture not supported in this browser. Use Chrome or Edge on desktop for best results.");
  }
  // Prefer current tab where supported (Chrome 119+). Cast to any for narrow types.
  const opts: any = {
    video: {
      // @ts-ignore – preferCurrentTab is Chrome-specific
      preferCurrentTab: true,
      displaySurface: "browser",
    } as any,
    audio: true,
  };
  // Some types require selfBrowserSurface; include if supported
  try {
    const stream: MediaStream = await navigator.mediaDevices.getDisplayMedia(opts);
    // Verify audio track present (user must enable "Share tab audio")
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      // not fatal – recording will be silent, warn caller via property
      (stream as any)._noAudio = true;
    }
    return stream;
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (msg.includes("Permission denied") || msg.includes("NotAllowedError")) {
      throw new Error("Capture canceled. Please try again and select \"This Tab\" with \"Share tab audio\" enabled.");
    }
    throw e;
  }
}

/**
 * Progressive enhancement: crop captured stream to just the iframe bounding box
 * via Element Capture / CropTarget (Chrome). Falls back to full tab.
 * https://developer.chrome.com/docs/web-platform/region-capture
 */
export async function tryCropToElement(stream: MediaStream, element: HTMLElement): Promise<boolean> {
  try {
    const anyWindow: any = window as any;
    if (!("CropTarget" in anyWindow) || !anyWindow.CropTarget?.fromElement) return false;
    // @ts-ignore
    const cropTarget = await anyWindow.CropTarget.fromElement(element);
    const [videoTrack] = stream.getVideoTracks();
    if (!videoTrack) return false;
    // @ts-ignore – modern Chrome has cropTo
    if (typeof (videoTrack as any).cropTo === "function") {
      await (videoTrack as any).cropTo(cropTarget);
      return true;
    }
    // Older RestrictionTarget API
    // @ts-ignore
    if (typeof (videoTrack as any).restrictTo === "function") {
      await (videoTrack as any).restrictTo(cropTarget);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function stopStream(stream: MediaStream | null) {
  if (!stream) return;
  stream.getTracks().forEach((t) => {
    try { t.stop(); } catch {}
  });
}
