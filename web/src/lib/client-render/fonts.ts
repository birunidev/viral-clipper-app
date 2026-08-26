import type { CaptionConfig } from "@/lib/caption-style-defaults";

/**
 * Loads the burn-in fonts (same TTFs the server's libass uses from
 * backend/assets/fonts) into the document via the FontFace API, so canvas
 * draws during client-side rendering use the exact faces the presets name.
 * Must resolve before the first frame draw or canvas falls back to a
 * default font and captions silently diverge from the server render.
 */

const FONT_FILES: Record<string, string> = {
  Anton: "/fonts/Anton-Regular.ttf",
  "Space Grotesk": "/fonts/SpaceGrotesk-Regular.ttf",
};

let loadPromise: Promise<void> | null = null;

function familiesForStyle(style?: Partial<CaptionConfig> | null): string[] {
  const names = new Set<string>(["Space Grotesk"]);
  const font = style?.font;
  if (font && font in FONT_FILES) names.add(font);
  return [...names];
}

/** Idempotently loads the given families (plus the watermark's Space
 * Grotesk). Resolves even if a font fails — drawing proceeds with fallback,
 * matching how the preview degrades. */
export function ensureFontsLoaded(
  style?: Partial<CaptionConfig> | null
): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  if (!loadPromise) {
    loadPromise = Promise.all(
      Object.entries(FONT_FILES).map(([family, url]) => {
        const face = new FontFace(family, `url(${url})`);
        return face
          .load()
          .then((loaded) => document.fonts.add(loaded))
          .catch((err) => {
            console.warn(`client-render: failed to load font ${family}`, err);
          });
      })
    ).then(() => undefined);
  }
  // Wait for every requested face to be ready (FontFace.load already ran in
  // the shared promise; this just yields to its completion).
  const needed = familiesForStyle(style);
  return loadPromise.then(() =>
    Promise.all(needed.map((f) => document.fonts.load(`16px "${f}"`))).then(
      () => undefined
    )
  );
}
