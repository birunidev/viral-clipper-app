"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { useJob, useProject, useRefreshProjectOnJobDone, useStartJob } from "@/hooks/use-projects";

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const STAGE_LABEL: Record<string, string> = {
  downloading: "Downloading source",
  transcribing: "Transcribing audio",
  analyzing: "Finding viral moments",
  cutting: "Cutting clips",
};

export default function ProjectPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const projectQuery = useProject(id);
  const project = projectQuery.data;

  const [orientation, setOrientation] = useState("portrait");
  const [maxClips, setMaxClips] = useState(10);
  const [error, setError] = useState("");

  const activeJobFromProject = project?.jobs.find(
    (j) => j.status === "queued" || j.status === "running"
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

  const lastJob = project?.jobs[0];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{project?.title ?? "Loading..."}</h1>
          <p className="mt-1 max-w-xl truncate text-sm text-zinc-400">{project?.source}</p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs ${
            project?.status === "completed"
              ? "bg-emerald-900 text-emerald-300"
              : project?.status === "failed"
                ? "bg-red-900 text-red-300"
                : "bg-zinc-800 text-zinc-300"
          }`}
        >
          {project?.status}
        </span>
      </div>

      <div className="flex flex-col gap-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
        <div className="flex flex-wrap items-end gap-6">
          <label className="flex flex-col gap-1 text-sm">
            Orientation
            <select
              value={orientation}
              onChange={(e) => setOrientation(e.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
            >
              <option value="portrait">9:16 (portrait)</option>
              <option value="landscape">16:9 (landscape)</option>
              <option value="original">Original ratio</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Max clips
            <select
              value={maxClips}
              onChange={(e) => setMaxClips(Number(e.target.value))}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
            >
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={20}>20</option>
            </select>
          </label>
          <button
            onClick={onStart}
            disabled={isActive || startJob.isPending}
            className="rounded-lg bg-zinc-100 px-5 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-40"
          >
            {isActive ? "Processing..." : "Start pipeline"}
          </button>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}

        {isActive && job && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-zinc-300">
              {STAGE_LABEL[job.stage ?? ""] ?? "Working"} — {job.progress}%
            </p>
            <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-zinc-100 transition-all"
                style={{ width: `${job.progress}%` }}
              />
            </div>
          </div>
        )}

        {lastJob?.status === "failed" && (
          <p className="rounded-lg bg-red-900/40 p-3 text-sm text-red-300">
            Job failed: {lastJob.error}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Clips ({project?.clips.length ?? 0})</h2>
        {project?.clips.length === 0 && (
          <p className="text-sm text-zinc-500">
            No clips yet. Start the pipeline to generate them.
          </p>
        )}
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {project?.clips.map((clip) => (
            <div
              key={clip.id}
              className="flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900"
            >
              <div className="aspect-video bg-black">
                {clip.signed_video_url ? (
                  <video
                    src={clip.signed_video_url}
                    poster={clip.signed_thumbnail_url ?? undefined}
                    controls
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-zinc-600">
                    video expired — refresh
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1 p-4">
                <p className="font-medium leading-tight">{clip.title}</p>
                {clip.viral_hook && (
                  <p className="text-sm italic text-zinc-400">&ldquo;{clip.viral_hook}&rdquo;</p>
                )}
                <p className="mt-1 text-xs text-zinc-500">
                  {fmtTime(clip.start_time)} – {fmtTime(clip.end_time)} ·{" "}
                  {Math.round(clip.end_time - clip.start_time)}s
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
