/**
 * Defaults + options for the in-app caption style editor. Mirrors the
 * built-in preset shape (backend/app/caption_presets.py) so a custom style
 * saved from the editor is structurally identical to a built-in one.
 */

export const CAPTION_FONT_OPTIONS = [
  { value: "Anton", label: "Anton" },
  { value: "Space Grotesk", label: "Space Grotesk" },
  { value: "Arial", label: "Arial (system)" },
] as const;

export type CaptionConfig = {
  font: string;
  font_size: number;
  x: "left" | "center" | "right";
  y: number;
  bold: boolean;
  italic: boolean;
  primary_color: string;
  highlight_color: string;
  outline_color: string;
  outline: number;
  shadow: number;
  words_per_line: number;
  max_chars_per_line: number;
  boxed: boolean;
  box_opacity: number;
};

export const DEFAULT_CAPTION_CONFIG: CaptionConfig = {
  font: "Anton",
  font_size: 72,
  x: "center",
  y: 0.8,
  bold: true,
  italic: false,
  primary_color: "#FFFFFF",
  highlight_color: "#FFD60A",
  outline_color: "#000000",
  outline: 4,
  shadow: 0,
  words_per_line: 4,
  max_chars_per_line: 32,
  boxed: false,
  box_opacity: 0.0,
};
