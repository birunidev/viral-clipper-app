import { useEffect, useRef } from "react";
import { WordCaptionOverlay } from "@/components/project/word-caption-overlay";
import { DEFAULT_CAPTION_CONFIG } from "@/lib/caption-style-defaults";

export function BigBox({
  sourceUrl,
  thumbnail,
  start,
  end,
  captionWords,
  aspect = "9:16",
  onTimeUpdate,
}: {
  sourceUrl: string;
  thumbnail: string | null;
  start: number;
  end: number;
  captionWords: { text: string; start_ms: number; end_ms: number }[];
  aspect?: string;
  onTimeUpdate?: (t: number) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onLoaded = () => {
      video.currentTime = start;
      void video.play();
    };
    const onTime = () => {
      onTimeUpdate?.(video.currentTime);
      if (video.currentTime >= end) video.pause();
    };
    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("timeupdate", onTime);
    return () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("timeupdate", onTime);
    };
  }, [start, end, onTimeUpdate]);

  const aspectClass = aspect === "4:5" ? "aspect-[4/5]" : aspect === "1:1" ? "aspect-square" : aspect === "16:9" ? "aspect-video" : "aspect-[9/16]";

  return (
    <div className="flex flex-col items-center">
      <div className={`relative w-full max-w-[420px] overflow-hidden rounded-xl border border-line bg-black shadow-xl ${aspectClass}`}>
        <video ref={videoRef} src={sourceUrl} poster={thumbnail ?? undefined} controls className="h-full w-full bg-black object-cover" />
        {captionWords.length > 0 && (
          <WordCaptionOverlay videoRef={videoRef} words={captionWords} clipStartSeconds={start} style={DEFAULT_CAPTION_CONFIG} />
        )}
        {/* CropFrame overlay — ratio-locked handles placeholder */}
        <div className="pointer-events-none absolute inset-0 rounded-xl border border-white/30" />
      </div>
      <p className="mt-2 text-[11px] text-ink-muted">{aspect} · {captionWords.length} words</p>
    </div>
  );
}
