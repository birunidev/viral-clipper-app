"use client";

import {
  Check,
  CircleNotch,
  ClosedCaptioning,
  Download,
  FilmReel,
  Lightning,
  Play,
  Scissors,
  SlidersHorizontal,
  Warning,
  Waveform,
  X,
} from "@phosphor-icons/react";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Card, EmptyState, Skeleton } from "@/components/ui/card";
import { StatusPill } from "@/components/ui/status-pill";
import { Timestamp, fmtDuration } from "@/components/ui/timestamp";
import { SourceTypeIcon } from "@/components/project/source-icon";
import {
  useCaptionStyles,
  useJob,
  useProject,
  useRefreshProjectOnJobDone,
  useRenderClip,
  useStartJob,
} from "@/hooks/use-projects";
import type { Clip, ProjectDetail } from "@/hooks/types";
import { Button } from "@/components/ui/button";
import { CaptionStylePicker } from "@/components/project/caption-style-picker";
import { CaptionStyleEditor } from "@/components/project/caption-style-editor";
import { WordCaptionOverlay } from "@/components/project/word-caption-overlay";

const STAGE_LABEL: Record<string, string> = {
  downloading: "Downloading source",
  transcribing: "Transcribing audio",
  analyzing: "Finding viral moments",
};

const STAGE_ORDER = ["downloading", "transcribing", "analyzing"] as const;

function PipelineStages({ stage }: { stage: string | null }) {
  const idx = stage ? STAGE_ORDER.indexOf(stage as (typeof STAGE_ORDER)[number]) : -1;
  const labels = STAGE_LABEL;

  return (
    <ol className="flex items-center gap-2">
      {STAGE_ORDER.map((key, i) => {
        const done = idx > i;
        const active = idx === i;
        const Icon = key === "downloading" ? FilmReel : key === "transcribing" ? Waveform : Lightning;
        return (
          <li key={key} className="flex items-center gap-2">
            <div
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                done
                  ? "border-success/30 bg-success-soft text-success"
                  : active
                    ? "border-accent/40 bg-accent-soft text-accent-strong"
                    : "border-line text-ink-muted"
              }`}
            >
              {done ? <Check size={13} weight="bold" /> : <Icon size={13} />}
              {labels[key]}
            </div>
            {i < STAGE_ORDER.length - 1 && (
              <span className={`h-px w-4 ${done ? "bg-success/40" : "bg-line"}`} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export default function ProjectPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const projectQuery = useProject(id);
  const project = projectQuery.data;

  const [orientation, setOrientation] = useState("portrait");
  const [maxClips, setMaxClips] = useState(10);
  const [error, setError] = useState("");

  const activeJobFromProject = project?.jobs.find(
    (j) => j.type === "analyze" && (j.status === "queued" || j.status === "running")
  );
  const jobQuery = useJob(activeJobFromProject?.id ?? "");
  const job = jobQuery.data ?? activeJobFromProject;
  const isActive = job?.status === "queued" || job?.status === "running";

  useRefreshProjectOnJobDone(id, jobQuery.data);

  const startJob = useStartJob(id);

  function onStart() {
    setError("");
    startJob.mutate(
      { orientation, max_clips: maxClips },
      { onError: (err) => setError(err.message) }
    );
  }

  const lastJob = project?.jobs.find((j) => j.type === "analyze");
  const clips = project?.clips ?? [];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-ink-muted">
            <SourceTypeIcon type={project?.source_type ?? "youtube"} />
            <span className="truncate">{project?.source}</span>
          </div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-ink balance">
            {project?.title ?? "Loading..."}
          </h1>
        </div>
        <StatusPill status={project?.status ?? "idle"} />
      </div>

      {/* Pipeline control */}
      <Card className="p-5">
        {isActive && job ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm font-medium text-ink">
                {STAGE_LABEL[job.stage ?? ""] ?? "Working"}
              </p>
              <span className="text-xs text-ink-tertiary tabular-nums">{job.progress}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
                style={{ width: `${Math.max(job.progress, 4)}%` }}
              />
            </div>
            <PipelineStages stage={job.stage} />
          </div>
        ) : (
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div className="flex flex-wrap items-end gap-6">
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="text-ink-secondary">Orientation</span>
                <select
                  value={orientation}
                  onChange={(e) => setOrientation(e.target.value)}
                  className="h-10 rounded-lg border border-line bg-surface-2 px-3 text-sm text-ink outline-none focus:border-accent/50"
                >
                  <option value="portrait">9:16 — Portrait</option>
                  <option value="landscape">16:9 — Landscape</option>
                  <option value="original">Original ratio</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="text-ink-secondary">Max clips</span>
                <select
                  value={maxClips}
                  onChange={(e) => setMaxClips(Number(e.target.value))}
                  className="h-10 rounded-lg border border-line bg-surface-2 px-3 text-sm text-ink outline-none focus:border-accent/50"
                >
                  <option value={5}>5</option>
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                </select>
              </label>
            </div>
            <Button onClick={onStart} loading={startJob.isPending} disabled={startJob.isPending}>
              <Play size={14} weight="fill" />
              Find viral moments
            </Button>
          </div>
        )}

        {error && (
          <p className="mt-4 flex items-center gap-1.5 text-sm text-danger">
            <Warning size={14} weight="fill" />
            {error}
          </p>
        )}

        {lastJob?.status === "failed" && (
          <p className="mt-4 flex items-center gap-2 rounded-lg border border-danger/20 bg-danger-soft px-3 py-2.5 text-sm text-danger">
            <Warning size={15} weight="fill" />
            {lastJob.error}
          </p>
        )}
      </Card>

      {/* Clips */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">Clips</h2>
          <span className="text-xs text-ink-tertiary tabular-nums">
            {clips.length} found
          </span>
        </div>

        {projectQuery.isLoading && (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="overflow-hidden">
                <Skeleton className="aspect-video w-full rounded-none" />
                <div className="space-y-2 p-4">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </Card>
            ))}
          </div>
        )}

        {clips.length === 0 && !projectQuery.isLoading && (
          <EmptyState
            icon={<FilmReel size={28} />}
            title="No clips yet"
            body={isActive ? "The pipeline is running — clips will appear here." : "Run the pipeline to find the best moments."}
          />
        )}

        {project && (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {clips.map((clip) => (
              <ClipCard key={clip.id} clip={clip} project={project} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A clip card. Previews by seeking the project's source video to the
 * clip's [start_time, end_time] — no ffmpeg involved. A separate render
 * action (with an optional caption style) enqueues a render job; the
 * resulting file is uploaded to S3 and can be downloaded immediately or
 * later.
 */
function ClipCard({ clip, project }: { clip: Clip; project: ProjectDetail }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [captionsOpen, setCaptionsOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [selectedStyleId, setSelectedStyleId] = useState<string | null>(
    clip.caption_style_id
  );
  const captionStylesQuery = useCaptionStyles();
  const renderClip = useRenderClip(project.id);
  const renderJobId = clip.render_job?.id;
  const renderJobQuery = useJob(renderJobId ?? "");
  const renderJob = renderJobQuery.data ?? clip.render_job;
  const isRendering = renderJob?.status === "queued" || renderJob?.status === "running";

  useRefreshProjectOnJobDone(project.id, renderJobQuery.data);

  const duration = clip.end_time - clip.start_time;
  const canPreview = Boolean(project.source_video_url);
  const canDownload = Boolean(clip.signed_video_url);
  const hasCaptionWords = Boolean(clip.caption_json?.length);
  const filename = `${clip.title.replace(/[^\w]+/g, "-").toLowerCase() || "clip"}.mp4`;

  function handleRender(styleId: string | null) {
    setSelectedStyleId(styleId);
    setCaptionsOpen(false);
    renderClip.mutate(
      { clipId: clip.id, orientation: "portrait", captionStyleId: styleId },
      { onError: () => {} }
    );
  }

  function handleSaveAndRenderFromEditor(styleId: string) {
    setEditorOpen(false);
    handleRender(styleId);
  }

  return (
    <>
      <Card className="group flex flex-col overflow-hidden">
        {/* Thumbnail / preview trigger */}
        <button
          type="button"
          onClick={() => canPreview && setPreviewOpen(true)}
          disabled={!canPreview}
          className="relative block aspect-video w-full bg-black disabled:cursor-not-allowed"
          aria-label={`Preview ${clip.title}`}
        >
          {clip.signed_thumbnail_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={clip.signed_thumbnail_url}
              alt=""
              className="h-full w-full object-cover opacity-80"
            />
          ) : (
            <div className="flex h-full items-center justify-center bg-surface-2 text-ink-muted">
              <FilmReel size={22} />
            </div>
          )}
          {canPreview && (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur transition-transform group-hover:scale-105">
                <Play size={20} weight="fill" />
              </span>
            </span>
          )}
          {clip.caption_style_id && (
            <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur">
              <ClosedCaptioning size={11} weight="fill" />
              Captioned
            </span>
          )}
        </button>

        <div className="flex flex-col gap-2 p-4">
          <p className="font-medium leading-tight text-ink balance">{clip.title}</p>
          {clip.viral_hook && (
            <p className="text-sm italic text-ink-tertiary pretty">&ldquo;{clip.viral_hook}&rdquo;</p>
          )}
          <div className="mt-1 flex items-center gap-1.5 border-t border-line-soft pt-2.5 text-xs text-ink-tertiary">
            <span className="font-mono text-ink tabular-nums">
              <Timestamp seconds={clip.start_time} />
            </span>
            <span className="text-ink-muted">–</span>
            <span className="font-mono text-ink tabular-nums">
              <Timestamp seconds={clip.end_time} />
            </span>
            <span className="ml-auto rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary tabular-nums">
              {fmtDuration(duration)}
            </span>
          </div>

          <div className="mt-2 flex items-center gap-2">
            {isRendering ? (
              <div className="flex flex-1 items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs text-ink-secondary">
                <CircleNotch size={13} className="animate-spin" />
                Rendering… {renderJob?.progress ?? 0}%
              </div>
            ) : (
              <>
                {canDownload && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="flex-1"
                    onClick={() => {
                      const a = document.createElement("a");
                      a.href = clip.signed_video_url!;
                      a.download = filename;
                      a.target = "_blank";
                      a.rel = "noopener";
                      a.click();
                    }}
                  >
                    <Download size={13} />
                    Download
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={canDownload ? "ghost" : "secondary"}
                  className={canDownload ? "" : "flex-1"}
                  onClick={() => setCaptionsOpen((v) => !v)}
                  loading={renderClip.isPending}
                >
                  <Scissors size={13} />
                  {canDownload ? "Change captions" : "Render for download"}
                </Button>
              </>
            )}
          </div>

          {captionsOpen && !isRendering && (
            <div className="mt-1 rounded-lg border border-line bg-surface-2 p-3">
              {captionStylesQuery.isLoading ? (
                <p className="text-xs text-ink-tertiary">Loading styles…</p>
              ) : (
                <>
                  <CaptionStylePicker
                    styles={captionStylesQuery.data ?? []}
                    selectedId={selectedStyleId}
                    onSelect={handleRender}
                    disabled={renderClip.isPending}
                  />
                  {hasCaptionWords && canPreview && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-2 w-full"
                      onClick={() => {
                        setCaptionsOpen(false);
                        setEditorOpen(true);
                      }}
                      disabled={renderClip.isPending}
                    >
                      <SlidersHorizontal size={13} />
                      Customize captions
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </Card>

      {previewOpen && canPreview && (
        <SeekPreview
          sourceUrl={project.source_video_url!}
          thumbnail={clip.signed_thumbnail_url}
          start={clip.start_time}
          end={clip.end_time}
          title={clip.title}
          captionWords={hasCaptionWords ? clip.caption_json! : []}
          onClose={() => setPreviewOpen(false)}
        />
      )}

      {editorOpen && canPreview && hasCaptionWords && (
        <CaptionEditorModal
          title={clip.title}
          onClose={() => setEditorOpen(false)}
        >
          <CaptionStyleEditor
            sourceVideoUrl={project.source_video_url!}
            thumbnail={clip.signed_thumbnail_url}
            clipStart={clip.start_time}
            clipEnd={clip.end_time}
            captionWords={clip.caption_json!}
            initialConfig={
              selectedStyleId
                ? (captionStylesQuery.data?.find((s) => s.id === selectedStyleId)
                    ?.config as Record<string, unknown> | undefined)
                : undefined
            }
            onCancel={() => setEditorOpen(false)}
            onSaveAndRender={handleSaveAndRenderFromEditor}
            isRendering={renderClip.isPending}
          />
        </CaptionEditorModal>
      )}
    </>
  );
}

/**
 * Modal shell for the caption style editor — same overlay/scroll-lock
 * pattern as `SeekPreview`, sized wider to fit the live preview + controls
 * side by side on desktop.
 */
function CaptionEditorModal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Customize captions: ${title}`}
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl overflow-hidden rounded-xl border border-line bg-surface-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-ink">
            <SlidersHorizontal size={14} className="text-accent" />
            Customize captions
            <span className="ml-1 text-xs text-ink-tertiary">{title}</span>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-tertiary hover:bg-surface-2 hover:text-ink"
            aria-label="Close editor"
          >
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[80vh] overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

/**
 * Plays the clip by seeking the source video to [start, end] and pausing
 * at end. This is the entire point of the split pipeline: previews never
 * render anything.
 */
function SeekPreview({
  sourceUrl,
  thumbnail,
  start,
  end,
  title,
  captionWords,
  onClose,
}: {
  sourceUrl: string;
  thumbnail: string | null;
  start: number;
  end: number;
  title: string;
  captionWords: { text: string; start_ms: number; end_ms: number }[];
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onLoaded = () => {
      video.currentTime = start;
      void video.play();
    };
    const onTimeUpdate = () => {
      if (video.currentTime >= end) {
        video.pause();
      }
    };
    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [start, end]);

  // Lock scroll while the modal is open.
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview: ${title}`}
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-line bg-surface-1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-ink">
            <Play size={14} weight="fill" className="text-accent" />
            {title}
            <span className="ml-1 font-mono text-xs text-ink-tertiary tabular-nums">
              <Timestamp seconds={start} /> – <Timestamp seconds={end} /> · {fmtDuration(end - start)}
            </span>
            {captionWords.length > 0 && (
              <span className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-tertiary">
                <ClosedCaptioning size={11} />
                Captions
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-tertiary hover:bg-surface-2 hover:text-ink"
            aria-label="Close preview"
          >
            <X size={16} />
          </button>
        </div>
        <div className="relative">
          <video
            ref={videoRef}
            src={sourceUrl}
            poster={thumbnail ?? undefined}
            controls
            className="aspect-video w-full bg-black"
          />
          {captionWords.length > 0 && (
            <WordCaptionOverlay
              videoRef={videoRef}
              words={captionWords}
              clipStartSeconds={start}
            />
          )}
        </div>
      </div>
    </div>
  );
}
