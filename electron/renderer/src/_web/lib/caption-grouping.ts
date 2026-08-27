import type { CaptionConfig } from "./caption-style-defaults";
import type { CaptionWord } from "@/hooks/types";

/**
 * Mirrors the backend's width-aware caption line grouping
 * (backend/core/captions.py) so the preview wraps words into the same short
 * TikTok-style lines that get burned into the rendered video.
 *
 * The backend sizes captions against the *cropped output frame* in ASS
 * pixel space: font_size is scaled to the output height (reference 1280),
 * then a conservative glyph-width estimate derives how many characters fit
 * across the output width (minus side margins). The preview plays the source
 * video at its intrinsic resolution, so we reproduce that exact math from the
 * source dimensions + orientation — the resulting char budget is identical to
 * the burn regardless of on-screen display scaling.
 */

export const REFERENCE_HEIGHT = 1280;
export const AVG_CHAR_WIDTH_RATIO = 0.62;
export const LINE_HORIZONTAL_MARGIN_PX = 40;

/** Output frame dimensions after the cutter's crop for `orientation`
 * (mirrors core.captions.crop_dimensions, including round()-to-nearest). */
export function cropDimensions(
  srcWidth: number,
  srcHeight: number,
  orientation?: string
): { width: number; height: number } {
  const w = Math.max(1, Math.round(srcWidth));
  const h = Math.max(1, Math.round(srcHeight));
  if (orientation === "landscape") {
    return { width: w, height: Math.min(h, Math.round((w * 9) / 16)) };
  }
  if (orientation === "original") {
    return { width: w, height: h };
  }
  // portrait (default)
  return { width: Math.min(w, Math.round((h * 9) / 16)), height: h };
}

/** Scale a preset's reference font size to the actual output height
 * (mirrors core.captions._scaled_font_size). Non-finite style values fall
 * back to the defaults so a hostile config can't poison the math with NaN. */
export function scaledFontSize(style: Partial<CaptionConfig>, height: number): number {
  const raw = Number(style.font_size);
  const font = Number.isFinite(raw) ? raw : 64;
  return Math.max(10, Math.min(Math.round((font * height) / REFERENCE_HEIGHT), 511));
}

/** Estimate how many characters fit on one line at `fontSize` within
 * `width` pixels, after accounting for side margins (mirrors
 * core.captions._max_chars_for_width). */
export function maxCharsForWidth(width: number, fontSize: number): number {
  const available = Math.max(10, width - LINE_HORIZONTAL_MARGIN_PX);
  const charWidth = Math.max(1, fontSize * AVG_CHAR_WIDTH_RATIO);
  return Math.max(4, Math.floor(available / charWidth));
}

/** Effective per-line character budget for a style at a given output frame
 * (mirrors build_ass's `min(preset_max_chars, width_max_chars)`). */
export function lineCharBudget(
  style: Partial<CaptionConfig>,
  outWidth: number,
  outHeight: number
): number {
  const rawMax = Number(style.max_chars_per_line);
  const presetMax = Number.isFinite(rawMax) ? rawMax : 32;
  const fontSize = scaledFontSize(style, outHeight);
  const widthMax = maxCharsForWidth(outWidth, fontSize);
  return Math.min(presetMax, widthMax);
}

/** Greedily group words into caption lines by a character budget — mirrors
 * core.captions._group_words (contiguous runs, a single over-long word keeps
 * its own line). */
export function groupWords(
  words: CaptionWord[],
  maxChars: number
): CaptionWord[][] {
  const lines: CaptionWord[][] = [];
  let current: CaptionWord[] = [];
  let currentChars = 0;
  for (const word of words) {
    const length = word.text.length;
    if (current.length > 0 && currentChars + length + 1 > maxChars) {
      lines.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(word);
    currentChars += length + 1;
  }
  if (current.length > 0) lines.push(current);
  return lines;
}
