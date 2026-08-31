import { ThumbCell } from "./ThumbCell";

export function HorizontalThumbStrip({
  clips,
  selectedId,
  onSelect,
}: {
  clips: { id: string; title: string; start_time: number; end_time: number; signed_thumbnail_url: string | null; viral_hook?: string | null }[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}) {
  if (!clips.length) return <p className="text-xs text-ink-tertiary">No clips yet — run Find viral moments.</p>;
  return (
    <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory scroll-smooth pb-2 scrollbar-thin">
      {clips.map((clip) => (
        <ThumbCell key={clip.id} clip={clip} active={selectedId === clip.id} onSelect={() => onSelect?.(clip.id)} />
      ))}
    </div>
  );
}
