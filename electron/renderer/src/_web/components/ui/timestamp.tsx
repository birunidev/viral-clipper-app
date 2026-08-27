/**
 * Formats a seconds value as a timestamp (e.g. 83.4 -> "1:23").
 * Mono + tabular-nums is the ClipForge signature — time is the primary
 * identity of a clip, so it gets the strongest numeric treatment.
 */

export function fmtTime(seconds: number, showHundredths = false): string {
  if (!Number.isFinite(seconds)) return "--:--";
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const rem = Math.round((s - Math.floor(s)) * 100);

  const parts = h > 0
    ? `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`
    : `${m}:${sec.toString().padStart(2, "0")}`;

  return showHundredths ? `${parts}.${rem.toString().padStart(2, "0")}` : parts;
}

export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

export function Timestamp({ seconds, className = "" }: { seconds: number; className?: string }) {
  return (
    <span
      className={`tabular-nums font-mono ${className}`}
      aria-label={`${fmtTime(seconds)} (${fmtDuration(seconds)})`}
    >
      {fmtTime(seconds)}
    </span>
  );
}
