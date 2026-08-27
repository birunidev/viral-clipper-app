"use client";

import { useEffect, useRef, useState } from "react";
import type { CaptionWord } from "@/hooks/types";
import { captionTextStyle } from "@/lib/caption-preview-style";
import type { CaptionConfig } from "@/lib/caption-style-defaults";
import { cropDimensions, groupWords, lineCharBudget } from "@/lib/caption-grouping";

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
 *
 * Line grouping reproduces the backend's width-aware math
 * (lib/caption-grouping.ts) from the source video's intrinsic dimensions +
 * orientation, so the preview's short lines match the burned output exactly.
 */
export function WordCaptionOverlay({
  videoRef,
  words,
  clipStartSeconds,
  style,
  orientation = "portrait",
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  words: CaptionWord[];
  clipStartSeconds: number;
  style?: Partial<CaptionConfig>;
  orientation?: "portrait" | "landscape" | "original";
}) {
  const [activeIndex, setActiveIndex] = useState(-1);
  // Holds the last matched word through inter-word gaps: real transcripts
  // have silence between words, and a strict [start,end) match used to blank
  // the whole caption during every gap instead of holding the current word.
  const lastIndexRef = useRef(-1);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || words.length === 0) return;

    lastIndexRef.current = -1;

    function onTimeUpdate() {
      if (!video) return;
      const relativeMs = (video.currentTime - clipStartSeconds) * 1000;
      const idx = words.findIndex(
        (w) => relativeMs >= w.start_ms && relativeMs < w.end_ms
      );
      if (idx >= 0) {
        lastIndexRef.current = idx;
        setActiveIndex(idx);
        return;
      }
      // Inside a gap: keep the previous word visible while playback is
      // still within the captioned span; hide only before the first word.
      const held = lastIndexRef.current;
      const firstStart = words[0].start_ms;
      const lastEnd = words[words.length - 1].end_ms;
      setActiveIndex(
        held >= 0 && relativeMs >= firstStart && relativeMs < lastEnd ? held : -1
      );
    }

    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, [videoRef, words, clipStartSeconds]);

  if (words.length === 0 || activeIndex < 0) return null;

  const highlight = style?.highlight_color ?? "#F6403F";
  const yFrac = style?.y ?? 0.88;
  const align = style?.x ?? "center";

  // Compute the width-aware line budget from the source video's intrinsic
  // dimensions + orientation — identical math to the burn. Falls back to the
  // style's max_chars_per_line when dimensions aren't known yet (pre-metadata).
  const video = videoRef.current;
  let maxChars = Number(style?.max_chars_per_line ?? 32);
  if (video && video.videoWidth > 0 && video.videoHeight > 0) {
    const frame = cropDimensions(video.videoWidth, video.videoHeight, orientation);
    maxChars = lineCharBudget(style ?? {}, frame.width, frame.height);
  }

  // Find which line the active word belongs to, then show only that line —
  // matches the one-line-at-a-time burned-in look.
  const lines = groupWords(words, maxChars);
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

