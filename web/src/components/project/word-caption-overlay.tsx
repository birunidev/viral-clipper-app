"use client";

import { useEffect, useState } from "react";
import type { CaptionWord } from "@/hooks/types";
import { captionTextStyle } from "@/lib/caption-preview-style";
import type { CaptionConfig } from "@/lib/caption-style-defaults";

/**
 * Groups a rolling window of words into caption "lines" the same way
 * core.captions._group_words does server-side (greedy by character
 * budget), so the preview's line breaks roughly match what gets burned in.
 */
function groupByMaxChars(words: CaptionWord[], maxChars: number): CaptionWord[][] {
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

/**
 * Renders a live word-by-word caption overlay on top of a <video>,
 * highlighting the active word as playback advances — the same timing
 * data (`caption_json`) that gets burned into a render, but shown here for
 * free during preview via a CSS overlay driven by `timeupdate`.
 *
 * When a full ``style`` config is supplied (font/size/colors/position/
 * outline/boxed/word-grouping), the overlay renders with that exact look —
 * used both for previewing a clip's already-selected style and as the
 * live canvas for the caption style editor.
 */
export function WordCaptionOverlay({
  videoRef,
  words,
  clipStartSeconds,
  style,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  words: CaptionWord[];
  clipStartSeconds: number;
  style?: Partial<CaptionConfig>;
}) {
  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || words.length === 0) return;

    function onTimeUpdate() {
      if (!video) return;
      const relativeMs = (video.currentTime - clipStartSeconds) * 1000;
      const idx = words.findIndex(
        (w) => relativeMs >= w.start_ms && relativeMs < w.end_ms
      );
      setActiveIndex(idx);
    }

    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, [videoRef, words, clipStartSeconds]);

  if (words.length === 0 || activeIndex < 0) return null;

  const highlight = style?.highlight_color ?? "#F6403F";
  const yFrac = style?.y ?? 0.88;
  const align = style?.x ?? "center";
  const maxChars = style?.max_chars_per_line ?? 9999;

  // Find which line the active word belongs to (mirrors backend grouping),
  // then show only that line — matches the one-line-at-a-time burned-in look.
  const lines = groupByMaxChars(words, maxChars);
  let cursor = 0;
  let activeLine: CaptionWord[] = [];
  let activeLineStart = 0;
  for (const line of lines) {
    if (activeIndex < cursor + line.length) {
      activeLine = line;
      activeLineStart = cursor;
      break;
    }
    cursor += line.length;
  }
  if (activeLine.length === 0) return null;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 flex px-6"
      style={{
        bottom: `${(1 - yFrac) * 100}%`,
        transform: "translateY(50%)",
        justifyContent: align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center",
      }}
    >
      <p
        className="max-w-[92%] text-center leading-tight"
        style={captionTextStyle(style ?? {}, { sizeScale: 0.5 })}
      >
        {activeLine.map((word, i) => {
          const realIndex = activeLineStart + i;
          return (
            <span
              key={realIndex}
              style={realIndex === activeIndex ? { color: highlight } : undefined}
            >
              {word.text}
              {i < activeLine.length - 1 ? " " : ""}
            </span>
          );
        })}
      </p>
    </div>
  );
}
