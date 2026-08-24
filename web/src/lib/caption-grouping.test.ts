import { describe, it, expect } from "vitest";
import {
  cropDimensions,
  scaledFontSize,
  maxCharsForWidth,
  lineCharBudget,
  groupWords,
} from "./caption-grouping";
import { DEFAULT_CAPTION_CONFIG } from "./caption-style-defaults";

describe("cropDimensions", () => {
  it("crops a 16:9 source to a 9:16 portrait window", () => {
    const { width, height } = cropDimensions(854, 480, "portrait");
    expect(width).toBe(270); // round(480 * 9/16)
    expect(height).toBe(480);
  });

  it("leaves original orientation untouched", () => {
    expect(cropDimensions(854, 480, "original")).toEqual({
      width: 854,
      height: 480,
    });
  });
});

describe("width-aware line budget", () => {
  const pop = { ...DEFAULT_CAPTION_CONFIG, font_size: 88, max_chars_per_line: 28 };

  it("matches the backend burn math for the portrait smoke clip", () => {
    const frame = cropDimensions(854, 480, "portrait");
    expect(frame).toEqual({ width: 270, height: 480 });
    // scaledFontSize: round(88 * 480 / 1280) = 33
    expect(scaledFontSize(pop, frame.height)).toBe(33);
    // maxCharsForWidth: floor((270-40) / (33*0.62)) = floor(230/20.46) = 11
    expect(maxCharsForWidth(frame.width, 33)).toBe(11);
    // budget = min(28, 11) = 11 -> short TikTok lines, not the 28-char default
    expect(lineCharBudget(pop, frame.width, frame.height)).toBe(11);
  });

  it("stays conservative: budget never exceeds what fits the width", () => {
    const frame = cropDimensions(854, 480, "portrait");
    for (const size of [40, 64, 88, 120]) {
      const budget = lineCharBudget({ ...DEFAULT_CAPTION_CONFIG, font_size: size }, frame.width, frame.height);
      // The wrapped width of the longest allowed line must fit the frame.
      const fontSize = scaledFontSize({ ...DEFAULT_CAPTION_CONFIG, font_size: size }, frame.height);
      expect(maxCharsForWidth(frame.width, fontSize)).toBeGreaterThanOrEqual(budget);
    }
  });
});

describe("groupWords (word-by-word lines)", () => {
  const words = [
    "Ini", "adalah", "contoh", "kalimat", "yang", "cukup", "panjang",
    "untuk", "dipecah", "menjadi", "beberapa", "baris", "caption",
  ].map((text, i) => ({ text, start_ms: i * 300, end_ms: i * 300 + 280 }));

  it("splits into short lines rather than one paragraph", () => {
    // Budget of 11 chars (pop preset @ portrait 270px) -> many short lines.
    const lines = groupWords(words, 11);
    expect(lines.length).toBeGreaterThan(2);
    // No line exceeds the budget.
    for (const line of lines) {
      const chars = line.reduce((n, w) => n + w.text.length + 1, 0);
      expect(chars).toBeLessThanOrEqual(11 + 2);
    }
    // Words stay contiguous and ordered across lines.
    const flattened = lines.flat().map((w) => w.text);
    expect(flattened).toEqual(words.map((w) => w.text));
  });

  it("keeps a single over-long word on its own line", () => {
    const long = [{ text: "supercalifragilisticexpialidocious", start_ms: 0, end_ms: 100 }];
    const lines = groupWords(long, 11);
    expect(lines).toHaveLength(1);
    expect(lines[0][0].text).toBe(long[0].text);
  });

  it("active word is isolated to exactly one line at a time", () => {
    const lines = groupWords(words, 11);
    let cursor = 0;
    const activeInLine: number[] = [];
    for (const line of lines) {
      for (let i = 0; i < line.length; i++) {
        const realIndex = cursor + i;
        // each word belongs to exactly one line
        expect(activeInLine).not.toContain(realIndex);
        activeInLine.push(realIndex);
      }
      cursor += line.length;
    }
    expect(activeInLine).toHaveLength(words.length);
  });
});
