const TONES = {
  idle: "bg-surface-2 text-ink-tertiary border-line",
  queued: "bg-warning-soft text-warning border-warning/20",
  running: "bg-warning-soft text-warning border-warning/20",
  completed: "bg-success-soft text-success border-success/20",
  failed: "bg-danger-soft text-danger border-danger/20",
} as const;

type Tone = keyof typeof TONES;

const LABELS: Record<Tone, string> = {
  idle: "Idle",
  queued: "Queued",
  running: "Processing",
  completed: "Completed",
  failed: "Failed",
};

export function StatusPill({ status }: { status: string }) {
  const tone = (status in TONES ? status : "idle") as Tone;
  const isLive = tone === "running" || tone === "queued";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-wide ${TONES[tone]}`}
    >
      {isLive && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      )}
      {LABELS[tone]}
    </span>
  );
}
