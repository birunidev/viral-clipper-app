import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BufferTarget,
  canEncodeAudio,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  UrlSource,
} from "mediabunny";
import type { CaptionWord } from "@/hooks/types";
import type { CaptionConfig } from "@/lib/caption-style-defaults";
import { buildCaptionEvents, drawCaptionEvent, drawWatermark, eventAtTime } from "./draw";
import { ensureFontsLoaded } from "./fonts";

/**
 * Client-side clip renderer: decodes the stored source video straight in the
 * browser (mediabunny streams it over range requests — no full download),
 * crops to the chosen orientation, burns captions + watermark onto every
 * frame via canvas, encodes H.264/AAC and returns an MP4 blob.
 *
 * Mirrors backend/core/cutter.py: center crop (fit:"cover"), plan
 * max_resolution downscale, ASS-equivalent captions, optional watermark.
 * Any thrown error aborts the whole render — the caller falls back to the
 * server queue (never half-fail silently).
 */

export type ClientRenderOptions = {
  /** Presigned/signed GET URL of the source video. */
  sourceUrl: string;
  /** Same-origin proxy fallback (e.g. /api/v1/projects/{id}/source/stream). */
  fallbackUrl?: string | null;
  clipStartSeconds: number;
  clipEndSeconds: number;
  orientation: "portrait" | "landscape" | "original";
  /** Clip-relative word timings; captions burn only when style is given. */
  captionWords?: CaptionWord[] | null;
  captionStyle?: Partial<CaptionConfig> | null;
  watermark?: boolean;
  /** Plan cap on the longest output side (downscale only). */
  maxResolution?: number | null;
  onProgress?: (fraction: number) => void;
};

export class ClientRenderUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientRenderUnsupportedError";
  }
}

function evenDown(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/** Output dimensions mirroring cutter's crop + scale cap exactly
 * (core.captions.crop_dimensions): the cropped frame at source resolution,
 * downscaled ONLY when the plan's max_resolution cap demands it. Always
 * even (H.264 requirement). `sourceWidth`/`sourceHeight` must be the
 * display-orientation dimensions (see rotation note in renderClipInBrowser). */
export function outputDimensions(
  orientation: "portrait" | "landscape" | "original",
  sourceWidth: number,
  sourceHeight: number,
  maxResolution?: number | null
): { width: number; height: number } {
  const srcW = Math.max(1, Math.round(sourceWidth));
  const srcH = Math.max(1, Math.round(sourceHeight));
  let width: number;
  let height: number;
  if (orientation === "landscape") {
    width = srcW;
    height = Math.min(srcH, Math.round((srcW * 9) / 16));
  } else if (orientation === "original") {
    width = srcW;
    height = srcH;
  } else {
    // portrait (default)
    width = Math.min(srcW, Math.round((srcH * 9) / 16));
    height = srcH;
  }
  const cap = maxResolution && maxResolution > 0 ? maxResolution : null;
  if (cap) {
    const longest = Math.max(width, height);
    if (longest > cap) {
      const scale = cap / longest;
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
  }
  return { width: evenDown(width), height: evenDown(height) };
}

/** Render one clip fully in the browser. Resolves with the finished MP4. */
export async function renderClipInBrowser(
  opts: ClientRenderOptions
): Promise<Blob> {
  const start = Math.max(0, opts.clipStartSeconds);
  const end = Math.max(start + 0.1, opts.clipEndSeconds);

  await ensureFontsLoaded(opts.captionStyle);

  async function openInput(url: string, withCredentials = false) {
    const input = new Input({
      formats: ALL_FORMATS,
      source: new UrlSource(url, withCredentials ? { requestInit: { credentials: "include" } } : undefined),
    });
    try {
      const track = await input.getPrimaryVideoTrack();
      return { input, track };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("CORS")) {
        throw new ClientRenderUnsupportedError(`Cannot fetch source (CORS/network): ${msg}`);
      }
      throw e;
    }
  }

  let input: Input;
  let videoTrack: Awaited<ReturnType<Input["getPrimaryVideoTrack"]>>;
  try {
    const r = await openInput(opts.sourceUrl, false);
    input = r.input;
    videoTrack = r.track;
  } catch (e) {
    if (opts.fallbackUrl && e instanceof ClientRenderUnsupportedError) {
      const r2 = await openInput(opts.fallbackUrl, true);
      input = r2.input;
      videoTrack = r2.track;
    } else {
      throw e;
    }
  }
  if (!videoTrack) {
    throw new ClientRenderUnsupportedError("Source video has no video track");
  }
  if (!(await videoTrack.canDecode())) {
    throw new ClientRenderUnsupportedError(
      `Browser cannot decode ${videoTrack.codec} video`
    );
  }

  const audioTrack = await input.getPrimaryAudioTrack();
  if (audioTrack && !(await audioTrack.canDecode())) {
    // Audio we can't decode shouldn't sink the whole render; proceed muted
    // only if the track genuinely can't be handled — but for parity with
    // server renders, bail out so the server path produces a full result.
    throw new ClientRenderUnsupportedError(
      `Browser cannot decode ${audioTrack.codec} audio`
    );
  }

  // displayWidth/Height are documented as pre-rotation; swap them for
  // quarter-turn rotations so the crop math sees what ffmpeg's autorotate
  // sees. (CanvasSink applies rotation internally when producing frames.)
  let displayWidth = videoTrack.displayWidth;
  let displayHeight = videoTrack.displayHeight;
  const rotation = Math.abs(videoTrack.rotation);
  if (rotation === 90 || rotation === 270) {
    [displayWidth, displayHeight] = [displayHeight, displayWidth];
  }

  const { width, height } = outputDimensions(
    opts.orientation,
    displayWidth,
    displayHeight,
    opts.maxResolution
  );

  const events =
    opts.captionWords?.length && opts.captionStyle
      ? buildCaptionEvents(opts.captionWords, opts.captionStyle, width, height)
      : [];

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not acquire 2D context for rendering");

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target: new BufferTarget(),
  });

  const canvasSource = new CanvasSource(canvas, {
    codec: "avc",
    bitrate: 8_000_000,
  });
  output.addVideoTrack(canvasSource);

  let audioSource: AudioBufferSource | null = null;
  let audioCodec: "aac" | "opus" | "pcm-s16" | null = null;
  if (audioTrack) {
    try {
      const sr = (audioTrack as unknown as { sampleRate?: number }).sampleRate ?? 48000;
      const ch = (audioTrack as unknown as { numberOfChannels?: number }).numberOfChannels ?? 2;
      const tryCodec = async (codec: "aac" | "opus" | "pcm-s16") => {
        try { return await canEncodeAudio(codec, { sampleRate: sr, numberOfChannels: ch }); } catch { return false; }
      };
      if (await tryCodec("aac")) audioCodec = "aac";
      else if (await tryCodec("opus")) audioCodec = "opus";
      else if (await tryCodec("pcm-s16")) audioCodec = "pcm-s16";
      if (!audioCodec) {
        throw new ClientRenderUnsupportedError(`Browser cannot encode audio (${ch}ch ${sr}Hz) — falling back to server`);
      }
      const cfg: { codec: typeof audioCodec; bitrate?: number } = audioCodec === "pcm-s16" ? { codec: audioCodec } : { codec: audioCodec, bitrate: 128_000 };
      audioSource = new AudioBufferSource(cfg as never);
      output.addAudioTrack(audioSource);
    } catch (e) {
      if (e instanceof ClientRenderUnsupportedError) throw e;
      throw new ClientRenderUnsupportedError(`Audio encoder unsupported: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  try {
    await output.start();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("not supported") || msg.includes("encoder")) {
      if (audioSource) {
        try {
          output as unknown as { removeAudioTrack?: (s: unknown) => void };
        } catch {}
        throw new ClientRenderUnsupportedError(msg);
      }
      throw new ClientRenderUnsupportedError(msg);
    }
    throw e;
  }

  const duration = end - start;

  if (audioTrack && audioSource) {
    try {
      const audioSink = new AudioBufferSink(audioTrack);
      for await (const wrapped of audioSink.buffers(start, end)) {
        await audioSource.add(wrapped.buffer);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("not supported") || msg.includes("mp4a") || msg.includes("encoder") || msg.includes("AudioEncoder")) {
        throw new ClientRenderUnsupportedError(`Audio encode failed: ${msg}`);
      }
      throw e;
    }
  }

  const sink = new CanvasSink(videoTrack, {
    width,
    height,
    fit: "cover",
    poolSize: 2,
  });
  for await (const frame of sink.canvases(start, end)) {
    ctx.drawImage(frame.canvas as CanvasImageSource, 0, 0, width, height);
    if (events.length > 0) {
      const tMs = (frame.timestamp - start) * 1000;
      const event = eventAtTime(events, tMs);
      if (event) drawCaptionEvent(ctx, event, opts.captionStyle!, width, height);
    }
    if (opts.watermark) drawWatermark(ctx, width, height);
    await canvasSource.add(frame.timestamp - start, frame.duration);
    opts.onProgress?.(Math.min(1, (frame.timestamp - start) / duration));
  }

  await output.finalize();

  const buffer = output.target.buffer;
  if (!buffer) throw new Error("Renderer produced no output");
  opts.onProgress?.(1);
  return new Blob([buffer], { type: "video/mp4" });
}
