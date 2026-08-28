import type { CaptionWord } from "@/hooks/types";
import type { CaptionConfig } from "@/lib/caption-style-defaults";
import { groupWords, lineCharBudget, scaledFontSize } from "@/lib/caption-grouping";

/**
 * Canvas port of the server's ASS caption burn (backend/core/captions.py)
 * plus the brand watermark (backend/core/cutter.py `_watermark_filter`).
 *
 * Parity rules mirrored exactly:
 * - one Dialogue event per word: the full line shows with only the active
 *   word highlighted; the event window runs from the word's start_ms to the
 *   NEXT word's start_ms (last word ends at its own end_ms), clamped ≥1ms.
 * - between events (gaps spanning a line boundary) nothing is drawn — same
 *   as libass showing no subtitle.
 * - line grouping via the shared width-aware char budget, font size scaled
 *   to output height (reference 1280, clamp [10,511]), MarginV =
 *   round((1-y)*h) clamped [8, h//2], side margins 20px, bottom-center
 *   alignment (ASS \an2).
 */

const REFERENCE_SIDE_MARGIN_PX = 20;

/** Whitelist mirroring core.captions._safe_font_name: style configs are
 * user-editable JSON, so an untrusted `font` must never reach the canvas
 * font shorthand unquoted-token-injected. Invalid names fall back to
 * "Arial", exactly like libass does server-side. */
const FONT_SAFE_RE = /^[A-Za-z0-9 _-]{1,64}$/;

function safeFontName(value: unknown): string {
  const name = String(value ?? "").trim();
  return FONT_SAFE_RE.test(name) ? name : "Arial";
}

/** Finite-number getter: hostile/NaN style values degrade to the same
 * defaults the backend's `.get(...)` chains would produce instead of
 * poisoning ctx.font / margin math with NaN. */
function finite(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function sanitizeWordText(text: string): string {
  let cleaned = String(text);
  for (const ch of ["{", "}", "\\", "\n", "\r"]) {
    cleaned = cleaned.split(ch).join("");
  }
  return cleaned;
}

export type CaptionEvent = {
  startMs: number;
  endMs: number;
  /** Sanitized, display-ready words of the line. */
  words: string[];
  activeIndex: number;
};

/** Build the full event list for a clip — mirrors build_ass's event stream
 * (grouped lines × per-word highlight states). */
export function buildCaptionEvents(
  words: CaptionWord[],
  style: Partial<CaptionConfig>,
  outWidth: number,
  outHeight: number
): CaptionEvent[] {
  if (!words.length) return [];
  const maxChars = lineCharBudget(style, outWidth, outHeight);
  const lines = groupWords(words, maxChars);
  const events: CaptionEvent[] = [];
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const active = line[i];
      const rawEnd = i + 1 < line.length ? line[i + 1].start_ms : active.end_ms;
      const endMs = Math.max(Math.round(rawEnd), Math.round(active.start_ms) + 1);
      events.push({
        startMs: Math.round(active.start_ms),
        endMs,
        words: line.map((w) => sanitizeWordText(w.text)),
        activeIndex: i,
      });
    }
  }
  return events;
}

/** The event visible at `timeMs` (clip-relative), or null — matching libass,
 * which shows nothing between events. */
export function eventAtTime(
  events: CaptionEvent[],
  timeMs: number
): CaptionEvent | null {
  // Events are generated in time order per line but line boundaries can
  // overlap slightly; linear scan is fine (clips have ≤ a few hundred words).
  for (const ev of events) {
    if (timeMs >= ev.startMs && timeMs < ev.endMs) return ev;
  }
  return null;
}

function cssColor(hex: string, opacity = 1): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return opacity < 1 ? `rgba(255,255,255,${opacity})` : "#FFFFFF";
  const v = m[1];
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return opacity >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${opacity})`;
}

function fontFamily(style: Partial<CaptionConfig>): string {
  // Name is whitelisted above, so quoting is safe.
  return `"${safeFontName(style.font)}", Arial, sans-serif`;
}

function applyFont(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  style: Partial<CaptionConfig>,
  fontSize: number
) {
  const italic = style.italic ? "italic " : "";
  const bold = style.bold ? "bold " : "";
  ctx.font = `${italic}${bold}${fontSize}px ${fontFamily(style)}`;
}

/** Draw one caption line (single row, bottom-aligned like ASS \an2). */
export function drawCaptionEvent(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  event: CaptionEvent,
  style: Partial<CaptionConfig>,
  width: number,
  height: number
) {
  const fontSize = scaledFontSize(style, height);
  applyFont(ctx, style, fontSize);

  const primary = cssColor(String(style.primary_color ?? "#FFFFFF"));
  const highlight = cssColor(String(style.highlight_color ?? "#FFD60A"));
  const outlineColor = String(style.outline_color ?? "#000000");
  const outline = finite(style.outline, 3);
  const shadow = Math.max(0, finite(style.shadow, 0));
  const boxed = Boolean(style.boxed);
  const boxPadding = boxed ? Math.min(outline, 2) : 0;

  // Vertical position: MarginV up from the bottom edge (ASS alignment 2).
  const yFrac = finite(style.y, 0.8);
  const marginV = Math.max(8, Math.min(Math.round((1 - yFrac) * height), Math.floor(height / 2)));
  const baselineY = height - marginV;

  // Horizontal run of words starting from the alignment anchor.
  const align = style.x ?? "center";
  const spaceWidth = ctx.measureText(" ").width;
  const words = event.words;
  const wordWidths = words.map((w) => ctx.measureText(w).width);
  const totalWidth =
    wordWidths.reduce((sum, wd) => sum + wd, 0) + spaceWidth * (words.length - 1);

  let startX: number;
  if (align === "left") startX = REFERENCE_SIDE_MARGIN_PX;
  else if (align === "right") startX = width - REFERENCE_SIDE_MARGIN_PX - totalWidth;
  else startX = (width - totalWidth) / 2;
  startX = Math.max(0, startX);

  if (boxed) {
    const opacity = Math.max(0, Math.min(1, finite(style.box_opacity, 0)));
    if (opacity > 0) {
      const boxTop = baselineY - fontSize - boxPadding;
      const boxHeight = fontSize + boxPadding * 2;
      // Approximate ascent/descent split: libass boxes span roughly 1em
      // around the baseline; pad generously to cover descenders.
      ctx.fillStyle = cssColor("#000000", opacity);
      ctx.fillRect(
        startX - boxPadding,
        boxTop,
        totalWidth + boxPadding * 2,
        boxHeight + fontSize * 0.2
      );
    }
  }

  if (!boxed && outline > 0) {
    ctx.strokeStyle = cssColor(outlineColor);
    ctx.lineWidth = outline * 2; // stroke centers on path; double for outward border
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
  }
  if (shadow > 0) {
    ctx.shadowColor = cssColor("#000000");
    ctx.shadowOffsetX = shadow;
    ctx.shadowOffsetY = shadow;
  }

  let x = startX;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.length > 0) {
      ctx.fillStyle = i === event.activeIndex ? highlight : primary;
      if (!boxed && outline > 0) ctx.strokeText(word, x, baselineY);
      ctx.fillText(word, x, baselineY);
    }
    x += wordWidths[i] + spaceWidth;
  }

  ctx.shadowColor = "transparent";
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

/** Brand watermark — mirrors cutter._watermark_filter: "SnapClip", Space
 * Grotesk regular 26px @35% opacity, 24px from the right/bottom edges.
 * Fixed pixel size at final output resolution, like the ffmpeg filter. */
export function drawWatermark(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number
) {
  ctx.save();
  ctx.font = `26px "Space Grotesk", Arial, sans-serif`;
  ctx.fillStyle = cssColor("#FFFFFF", 0.35);
  ctx.textAlign = "right";
  ctx.fillText("SnapClip", width - 24, height - 24);
  ctx.restore();
}
