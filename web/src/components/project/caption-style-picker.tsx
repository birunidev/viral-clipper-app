"use client";

import { CaptionStyle } from "@/hooks/types";
import { Check } from "@phosphor-icons/react";

/**
 * A compact live caption-style preview: renders a few words in the preset's
 * actual styling (font family, weight, color, outline, position) so the user
 * can see what they'll get before rendering. Not a screenshot — real styled
 * text.
 */
function CaptionSwatch({ style }: { style: CaptionStyle }) {
  const c = style.config as Record<string, unknown>;
  const font = String(c.font ?? "sans-serif");
  const size = Number(c.font_size ?? 64);
  const idle = String(c.primary_color ?? "#FFFFFF");
  const highlight = String(c.highlight_color ?? "#FFD60A");
  const outline = String(c.outline_color ?? "#000000");
  const outlineW = Number(c.outline ?? 3);
  const bold = Boolean(c.bold);
  const italic = Boolean(c.italic);
  const boxed = Boolean(c.boxed);
  const y = Number(c.y ?? 0.8);

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-gradient-to-br from-zinc-800 to-zinc-950">
      <div
        className="absolute inset-x-0 px-3 text-center"
        style={{ top: `${y * 100}%`, transform: "translateY(-50%)" }}
      >
        <div
          className="inline-block"
          style={{
            fontFamily: font,
            fontSize: `${Math.round(size * 0.35)}px`,
            fontWeight: bold ? 700 : 400,
            fontStyle: italic ? "italic" : "normal",
            color: idle,
            textShadow: `${outlineW}px 0 0 ${outline}, -${outlineW}px 0 0 ${outline}, 0 ${outlineW}px 0 ${outline}, 0 -${outlineW}px 0 ${outline}`,
            ...(boxed
              ? { backgroundColor: "rgba(0,0,0,0.45)", borderRadius: "8px", padding: "2px 8px" }
              : {}),
          }}
        >
          <span style={{ color: highlight }}>This</span> is a caption
        </div>
      </div>
    </div>
  );
}

/**
 * The render preset picker shown on a clip card: "No captions" plus every
 * built-in/custom caption style. Selecting one renders the clip (or
 * re-renders with that style).
 */
export function CaptionStylePicker({
  styles,
  selectedId,
  onSelect,
  disabled,
}: {
  styles: CaptionStyle[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-ink-tertiary">Captions</p>
      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSelect(null)}
          className={`flex flex-col items-center gap-1 rounded-lg border p-1.5 text-center transition-colors ${
            selectedId === null
              ? "border-accent/50 bg-accent-soft"
              : "border-line hover:border-line-strong"
          } disabled:opacity-50`}
        >
          <span className="flex aspect-video w-full items-center justify-center rounded bg-surface-2 text-[10px] text-ink-muted">
            No captions
          </span>
        </button>
        {styles.map((style) => {
          const active = selectedId === style.id;
          return (
            <button
              key={style.id}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(style.id)}
              className={`relative flex flex-col gap-1 rounded-lg border p-1.5 text-center transition-colors ${
                active
                  ? "border-accent/50 bg-accent-soft"
                  : "border-line hover:border-line-strong"
              } disabled:opacity-50`}
            >
              <CaptionSwatch style={style} />
              <span className="text-[10px] font-medium text-ink-secondary">
                {style.label}
              </span>
              {active && (
                <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-ink">
                  <Check size={10} weight="bold" />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
