const REFERENCE_HEIGHT = 1280;
const AVG_CHAR_WIDTH_RATIO = 0.62;
const LINE_HORIZONTAL_MARGIN_PX = 40;
const HEX_RE = /^#?([0-9a-fA-F]{6})$/;
const FONT_SAFE_RE = /^[A-Za-z0-9 _\-]{1,64}$/;

export class CaptionBuildError extends Error {}

export function assColor(hexColor: string): string {
  const m = HEX_RE.exec(hexColor.trim());
  if (!m) throw new CaptionBuildError(`Invalid color: ${hexColor}`);
  const v = m[1];
  return `&H${v.slice(4, 6)}${v.slice(2, 4)}${v.slice(0, 2)}&`;
}

function sanitizeText(t: string): string {
  let c = String(t);
  for (const ch of ["{", "}", "\\", "\n", "\r"]) c = c.replaceAll(ch, "");
  return c;
}

function safeFontName(v: unknown): string {
  const n = String(v ?? "").trim();
  return FONT_SAFE_RE.test(n) ? n : "Arial";
}

function groupWords(words: { text: string; start_ms: number; end_ms: number }[], maxChars: number) {
  const lines: typeof words[] = [];
  let cur: typeof words = [];
  let curChars = 0;
  for (const w of words) {
    const len = w.text.length;
    if (cur.length && curChars + len + 1 > maxChars) {
      lines.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(w);
    curChars += len + 1;
  }
  if (cur.length) lines.push(cur);
  return lines;
}

function lineEvents(line: { text: string; start_ms: number; end_ms: number }[], highlight: string, idle: string) {
  const events: [number, number, string][] = [];
  for (let i = 0; i < line.length; i++) {
    const active = line[i];
    const rawEnd = i + 1 < line.length ? line[i + 1].start_ms : active.end_ms;
    const endMs = Math.max(Number(rawEnd), active.start_ms + 1);
    const rendered = line.map((w, j) => `{\\c${j === i ? highlight : idle}}${sanitizeText(w.text)}`).join(" ");
    events.push([active.start_ms, endMs, rendered]);
  }
  return events;
}

function scaledFontSize(style: Record<string, unknown>, height: number): number {
  const s = Math.round(Number(style.font_size ?? 64) * height / REFERENCE_HEIGHT);
  return Math.max(10, Math.min(s, 511));
}

function maxCharsForWidth(width: number, fontSize: number): number {
  const avail = Math.max(10, width - LINE_HORIZONTAL_MARGIN_PX);
  return Math.max(4, Math.floor(avail / Math.max(1, fontSize * AVG_CHAR_WIDTH_RATIO)));
}

function styleSection(style: Record<string, unknown>, width: number, height: number): string {
  const fontSize = scaledFontSize(style, height);
  const bold = style.bold ? -1 : 0;
  const italic = style.italic ? -1 : 0;
  const outline = Number(style.outline ?? 3);
  const shadow = Number(style.shadow ?? 0);
  const idle = assColor(String(style.primary_color ?? "#FFFFFF"));
  const outlineColor = assColor(String(style.outline_color ?? "#000000"));
  let backColor = "&H00000000&";
  let borderStyle = 1;
  let outlineW = outline;
  if (style.boxed) {
    borderStyle = 3;
    const opacity = Math.max(0, Math.min(1, Number(style.box_opacity ?? 0)));
    backColor = `&H${Math.round((1 - opacity) * 255).toString(16).padStart(2, "0").toUpperCase()}000000&`;
    outlineW = Math.min(outline, 2);
  }
  const yFrac = Number(style.y ?? 0.8);
  const marginV = Math.max(8, Math.min(Math.round((1 - yFrac) * height), Math.floor(height / 2)));
  const header = "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding";
  const line = `Style: Caption,${safeFontName(style.font ?? "Arial")},${fontSize},${idle},${idle},${outlineColor},${backColor},${bold},${italic},0,0,100,100,0,0,${borderStyle},${outlineW},${shadow},2,20,20,${marginV},1`;
  return `[V4+ Styles]\n${header}\n${line}`;
}

function assTime(ms: number): string {
  const totalCs = Math.round(Math.max(0, ms) / 10);
  const h = Math.floor(totalCs / 360000);
  let rem = totalCs % 360000;
  const m = Math.floor(rem / 6000);
  rem %= 6000;
  const s = Math.floor(rem / 100);
  const cs = rem % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function buildAss(words: { text: string; start_ms: number; end_ms: number }[], style: Record<string, unknown>, width: number, height: number): string {
  if (!words.length) throw new CaptionBuildError("no words");
  if (!style) throw new CaptionBuildError("no style");
  const presetMax = Number(style.max_chars_per_line ?? 32);
  const fontSize = scaledFontSize(style, height);
  const maxChars = Math.min(presetMax, maxCharsForWidth(width, fontSize));
  const highlight = assColor(String(style.highlight_color ?? "#FFD60A"));
  const idle = assColor(String(style.primary_color ?? "#FFFFFF"));
  const scriptInfo = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nScaledBorderAndShadow: yes\nWrapStyle: 0`;
  const stylesSection = styleSection(style, width, height);
  const lines = groupWords(words, maxChars);
  const events: string[] = ["[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"];
  for (const line of lines) for (const [s, e, t] of lineEvents(line, highlight, idle)) events.push(`Dialogue: 0,${assTime(s)},${assTime(e)},Caption,,0,0,0,,${t}`);
  return [scriptInfo, stylesSection, events.join("\n")].join("\n\n") + "\n";
}

export function cropDimensions(srcW: number, srcH: number, orientation: string): [number, number] {
  srcW = Math.max(1, srcW); srcH = Math.max(1, srcH);
  if (orientation === "landscape") return [srcW, Math.min(srcH, Math.round(srcW * 9 / 16))];
  if (orientation === "original" || !orientation) return [srcW, srcH];
  return [Math.min(srcW, Math.round(srcH * 9 / 16)), srcH];
}
