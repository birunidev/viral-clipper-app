import { FilmReel, Play } from "@phosphor-icons/react";
import { Timestamp, fmtDuration } from "@/components/ui/timestamp";

export function ThumbCell({
  clip,
  active,
  onSelect,
  onRename,
}: {
  clip: { id: string; title: string; start_time: number; end_time: number; signed_thumbnail_url: string | null; viral_hook?: string | null };
  active?: boolean;
  onSelect?: () => void;
  onRename?: (label: string) => void;
}) {
  return (
    <div className="shrink-0 w-[108px] snap-start">
      <button
        type="button"
        onClick={onSelect}
        className={`group relative flex w-full aspect-[9/16] overflow-hidden rounded-xl border bg-surface-2 shadow-sm transition ${active ? "border-accent ring-2 ring-accent ring-offset-2 ring-offset-surface-1" : "border-line hover:border-line-strong"}`}
      >
        {clip.signed_thumbnail_url ? (
          <img src={clip.signed_thumbnail_url} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-black text-ink-muted">
            <FilmReel size={20} />
          </div>
        )}
        <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition group-hover:opacity-100">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/90 text-ink transition-transform group-hover:scale-105">
            <Play size={14} weight="fill" />
          </span>
        </span>
      </button>
      <div className="mt-1.5">
        <p className="truncate text-xs font-medium text-ink" title={clip.title} onDoubleClick={() => { const v = prompt("Rename clip", clip.title); if (v !== null) onRename?.(v); }}>
          {clip.title}
        </p>
        <p className="flex items-center gap-1 text-[10px] text-ink-tertiary tabular-nums">
          <Timestamp seconds={clip.start_time} /> – <Timestamp seconds={clip.end_time} /> · {fmtDuration(clip.end_time - clip.start_time)}
        </p>
      </div>
    </div>
  );
}
