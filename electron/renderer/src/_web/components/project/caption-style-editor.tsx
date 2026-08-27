"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, CircleNotch, FloppyDisk } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useCreateCaptionStyle } from "@/hooks/use-projects";
import type { CaptionWord } from "@/hooks/types";
import { WordCaptionOverlay } from "@/components/project/word-caption-overlay";
import {
  CAPTION_FONT_OPTIONS,
  CaptionConfig,
  DEFAULT_CAPTION_CONFIG,
} from "@/lib/caption-style-defaults";

/**
 * A field row: label on top, control below. Keeps the editor's controls
 * visually consistent without a heavier form library.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-xs">
      <span className="font-medium text-ink-secondary">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  "h-9 rounded-lg border border-line bg-surface-2 px-2.5 text-sm text-ink outline-none focus:border-accent/50";
const colorSwatchClass =
  "h-9 w-full cursor-pointer rounded-lg border border-line bg-surface-2 p-1 outline-none focus:border-accent/50";

/**
 * Full caption style editor: live-previews every change against the
 * clip's actual video + word timings (via `WordCaptionOverlay`, using the
 * same config shape `core/captions.py` builds ASS styles from), then lets
 * the user save the result as a reusable caption style and immediately
 * render the clip with it.
 *
 * Starts from an existing style's config when editing/duplicating one, or
 * from `DEFAULT_CAPTION_CONFIG` when creating from scratch.
 */
export function CaptionStyleEditor({
  sourceVideoUrl,
  thumbnail,
  clipStart,
  clipEnd,
  captionWords,
  initialConfig,
  initialLabel,
  onCancel,
  onSaveAndRender,
  isRendering,
}: {
  sourceVideoUrl: string;
  thumbnail: string | null;
  clipStart: number;
  clipEnd: number;
  captionWords: CaptionWord[];
  initialConfig?: Partial<CaptionConfig>;
  initialLabel?: string;
  onCancel: () => void;
  onSaveAndRender: (styleId: string) => void;
  isRendering?: boolean;
}) {
  const [config, setConfig] = useState<CaptionConfig>({
    ...DEFAULT_CAPTION_CONFIG,
    ...initialConfig,
  });
  const [label, setLabel] = useState(initialLabel ?? "");
  const [error, setError] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const createStyle = useCreateCaptionStyle();

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onLoaded = () => {
      video.currentTime = clipStart;
      void video.play();
    };
    const onTimeUpdate = () => {
      if (video.currentTime >= clipEnd) {
        video.currentTime = clipStart;
      }
    };
    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [clipStart, clipEnd]);

  function update<K extends keyof CaptionConfig>(key: K, value: CaptionConfig[K]) {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }

  function handleReset() {
    setConfig({ ...DEFAULT_CAPTION_CONFIG, ...initialConfig });
    setError("");
  }

  async function handleSaveAndRender() {
    setError("");
    if (!label.trim()) {
      setError("Give this style a name before saving.");
      return;
    }
    try {
      const saved = await createStyle.mutateAsync({ label: label.trim(), config });
      onSaveAndRender(saved.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save style");
    }
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* Live preview */}
      <div className="relative aspect-[9/16] w-full max-w-[280px] shrink-0 overflow-hidden rounded-xl border border-line bg-black lg:mx-0">
        <video
          ref={videoRef}
          src={sourceVideoUrl}
          poster={thumbnail ?? undefined}
          muted
          playsInline
          loop
          className="h-full w-full object-cover"
        />
        <WordCaptionOverlay
          videoRef={videoRef}
          words={captionWords}
          clipStartSeconds={clipStart}
          style={config}
        />
      </div>

      {/* Controls */}
      <div className="flex flex-1 flex-col gap-4">
        <Field label="Style name">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. My bold yellow captions"
            className={inputClass}
            maxLength={100}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Font">
            <select
              value={config.font}
              onChange={(e) => update("font", e.target.value)}
              className={inputClass}
            >
              {CAPTION_FONT_OPTIONS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label={`Size (${config.font_size}px)`}>
            <input
              type="range"
              min={32}
              max={120}
              step={2}
              value={config.font_size}
              onChange={(e) => update("font_size", Number(e.target.value))}
              className="mt-2 h-9 accent-accent"
            />
          </Field>

          <Field label="Position">
            <select
              value={config.x}
              onChange={(e) => update("x", e.target.value as CaptionConfig["x"])}
              className={inputClass}
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </Field>

          <Field label={`Vertical (${Math.round(config.y * 100)}%)`}>
            <input
              type="range"
              min={0.5}
              max={0.95}
              step={0.01}
              value={config.y}
              onChange={(e) => update("y", Number(e.target.value))}
              className="mt-2 h-9 accent-accent"
            />
          </Field>

          <Field label="Text color">
            <input
              type="color"
              value={config.primary_color}
              onChange={(e) => update("primary_color", e.target.value)}
              className={colorSwatchClass}
            />
          </Field>

          <Field label="Highlight color">
            <input
              type="color"
              value={config.highlight_color}
              onChange={(e) => update("highlight_color", e.target.value)}
              className={colorSwatchClass}
            />
          </Field>

          <Field label="Outline color">
            <input
              type="color"
              value={config.outline_color}
              onChange={(e) => update("outline_color", e.target.value)}
              className={colorSwatchClass}
            />
          </Field>

          <Field label={`Outline width (${config.outline}px)`}>
            <input
              type="range"
              min={0}
              max={8}
              step={1}
              value={config.outline}
              onChange={(e) => update("outline", Number(e.target.value))}
              className="mt-2 h-9 accent-accent"
            />
          </Field>

          <Field label={`Words per line (${config.words_per_line})`}>
            <input
              type="range"
              min={1}
              max={8}
              step={1}
              value={config.words_per_line}
              onChange={(e) => {
                const words = Number(e.target.value);
                update("words_per_line", words);
                // Keep max_chars_per_line roughly proportional so the
                // width-aware wrap in core/captions.py still respects the
                // editor's word-count intent as an upper bound.
                update("max_chars_per_line", Math.max(12, words * 8));
              }}
              className="mt-2 h-9 accent-accent"
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-ink-secondary">
            <input
              type="checkbox"
              checked={config.bold}
              onChange={(e) => update("bold", e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
            Bold
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-secondary">
            <input
              type="checkbox"
              checked={config.italic}
              onChange={(e) => update("italic", e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
            Italic
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-secondary">
            <input
              type="checkbox"
              checked={config.boxed}
              onChange={(e) => update("boxed", e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
            Background box
          </label>
          {config.boxed && (
            <Field label={`Box opacity (${Math.round(config.box_opacity * 100)}%)`}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={config.box_opacity}
                onChange={(e) => update("box_opacity", Number(e.target.value))}
                className="h-9 w-32 accent-accent"
              />
            </Field>
          )}
        </div>

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="mt-1 flex items-center gap-2 border-t border-line-soft pt-3">
          <Button variant="ghost" size="sm" onClick={handleReset} type="button">
            <ArrowCounterClockwise size={13} />
            Reset
          </Button>
          <Button variant="secondary" size="sm" onClick={onCancel} type="button" className="ml-auto">
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSaveAndRender}
            loading={createStyle.isPending || isRendering}
            disabled={createStyle.isPending || isRendering}
            type="button"
          >
            {isRendering ? (
              <>
                <CircleNotch size={13} className="animate-spin" />
                Rendering…
              </>
            ) : (
              <>
                <FloppyDisk size={13} />
                Save & render
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
