"use client";

import { useEffect, useState } from "react";
import type { CaptionWord } from "@/hooks/types";

/**
 * Renders a live word-by-word caption overlay on top of a <video>,
 * highlighting the active word as playback advances — the same timing
 * data (`caption_json`) that gets burned into a render, but shown here for
 * free during preview via a CSS overlay driven by `timeupdate`.
 */
export function WordCaptionOverlay({
  videoRef,
  words,
  clipStartSeconds,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  words: CaptionWord[];
  clipStartSeconds: number;
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

  // Show a small rolling window around the active word (previous, active, next)
  const windowStart = Math.max(0, activeIndex - 2);
  const windowEnd = Math.min(words.length, activeIndex + 3);
  const visible = words.slice(windowStart, windowEnd);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[12%] flex justify-center px-6">
      <p className="max-w-[90%] text-center text-lg font-bold leading-tight text-white [text-shadow:_0_0_6px_rgb(0_0_0_/_80%),_0_0_2px_rgb(0_0_0_/_80%)] sm:text-2xl">
        {visible.map((word, i) => {
          const realIndex = windowStart + i;
          return (
            <span
              key={realIndex}
              className={realIndex === activeIndex ? "text-accent" : undefined}
            >
              {word.text}
              {i < visible.length - 1 ? " " : ""}
            </span>
          );
        })}
      </p>
    </div>
  );
}
