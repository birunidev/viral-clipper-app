import type { CSSProperties } from "react";
import type { CaptionConfig } from "./caption-style-defaults";

/**
 * Turns a caption style config into inline CSS that approximates the ASS
 * style libass burns in at render time (core/captions.py `_style_section`).
 * Shared by the style-picker swatch and the live caption editor/overlay so
 * every caption preview in the app uses the same mapping.
 *
 * Not pixel-perfect (browsers don't render ASS outlines exactly like
 * libass), but the same font, weight, size ratio, colors, and position.
 */
export function captionTextStyle(
  config: Partial<CaptionConfig>,
  options: { sizeScale?: number } = {}
): CSSProperties {
  const font = String(config.font ?? "Arial");
  const size = Number(config.font_size ?? 64);
  const idle = String(config.primary_color ?? "#FFFFFF");
  const outline = String(config.outline_color ?? "#000000");
  const outlineW = Number(config.outline ?? 3);
  const bold = Boolean(config.bold);
  const italic = Boolean(config.italic);
  const boxed = Boolean(config.boxed);
  const boxOpacity = Number(config.box_opacity ?? 0);
  const scale = options.sizeScale ?? 0.35;

  return {
    fontFamily: `"${font}", sans-serif`,
    fontSize: `${Math.max(8, Math.round(size * scale))}px`,
    fontWeight: bold ? 700 : 400,
    fontStyle: italic ? "italic" : "normal",
    color: idle,
    textShadow: [
      `${outlineW}px 0 0 ${outline}`,
      `-${outlineW}px 0 0 ${outline}`,
      `0 ${outlineW}px 0 ${outline}`,
      `0 -${outlineW}px 0 ${outline}`,
    ].join(", "),
    ...(boxed
      ? {
          backgroundColor: `rgba(0,0,0,${boxOpacity})`,
          borderRadius: "8px",
          padding: "2px 10px",
          boxDecorationBreak: "clone" as const,
        }
      : {}),
  };
}
