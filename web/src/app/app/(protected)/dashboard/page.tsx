"use client";

import {
  CloudArrowUp,
  Clock,
  FilmReel,
  Plus,
  Trash,
  Warning,
  X,
  YoutubeLogo,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, Skeleton } from "@/components/ui/card";
import { StatusPill } from "@/components/ui/status-pill";
import { SourceTypeIcon } from "@/components/project/source-icon";
import { UpgradeRequired, isPaywall } from "@/components/upgrade-required";
import { useCreateProject, useDeleteProject, usePresignUpload, useProjects } from "@/hooks/use-projects";

export default function DashboardPage() {
  const router = useRouter();
  const projectsQuery = useProjects();
  const createProject = useCreateProject();
  const presignUpload = usePresignUpload();
  const deleteProject = useDeleteProject();

  const [composerOpen, setComposerOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [sourceType, setSourceType] = useState<"youtube" | "upload">("youtube");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [paywallMessage, setPaywallMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  function fail(err: unknown) {
    if (isPaywall(err)) setPaywallMessage(err.message);
    else setError(err instanceof Error ? err.message : "Something went wrong");
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setPaywallMessage("");

    if (sourceType === "youtube") {
      if (!url.trim()) {
        setError("Enter a YouTube URL.");
        return;
      }
      createProject.mutate(
        { title, source: url.trim(), source_type: "youtube" },
        {
          onSuccess: (project) => router.push(`/app/projects/${project.id}`),
          onError: fail,
        }
      );
      return;
    }

    if (!file) {
      setError("Choose a video file.");
      return;
    }

    // 100MB per-user cap (matches backend core/storage.py). The backend
    // enforces this authoritatively too, but failing fast client-side is a
    // better UX than a rejected upload.
    const CAP_BYTES = 100 * 1024 * 1024;
    if (file.size > CAP_BYTES) {
      setError("This file is larger than the 100MB storage limit.");
      return;
    }

    try {
      const { url: putUrl, key } = await presignUpload.mutateAsync({
        file_name: file.name,
        content_type: file.type || "application/octet-stream",
      });

      const uploadRes = await fetch(putUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!uploadRes.ok) throw new Error("Upload failed. Try again.");

      createProject.mutate(
        { title, source: key, source_type: "upload", source_size_bytes: file.size },
        {
          onSuccess: (project) => router.push(`/app/projects/${project.id}`),
          onError: fail,
        }
      );
    } catch (err) {
      fail(err);
    }
  }

  const projects = projectsQuery.data;
  const isUploading = presignUpload.isPending || createProject.isPending;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">Projects</h1>
          <p className="mt-1 text-sm text-ink-tertiary">
            Paste a YouTube link or upload a video — ClipForge finds the moments worth cutting.
          </p>
        </div>
        {!composerOpen && (
          <Button onClick={() => setComposerOpen(true)}>
            <Plus size={16} weight="bold" />
            New project
          </Button>
        )}
      </div>

      {paywallMessage ? (
        <UpgradeRequired message={paywallMessage} />
      ) : composerOpen && (
        <Card className="p-5">
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-ink">New project</p>
              <button
                type="button"
                onClick={() => setComposerOpen(false)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-tertiary hover:bg-surface-2 hover:text-ink"
                aria-label="Close"
              >
                <X size={15} />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setSourceType("youtube")}
                className={`flex items-center gap-2.5 rounded-lg border px-3.5 py-3 text-left text-sm transition-colors ${
                  sourceType === "youtube"
                    ? "border-accent/40 bg-accent-soft text-ink"
                    : "border-line text-ink-secondary hover:border-line-strong"
                }`}
              >
                <YoutubeLogo size={20} weight={sourceType === "youtube" ? "fill" : "regular"} />
                <div>
                  <p className="font-medium leading-tight">YouTube link</p>
                  <p className="text-xs text-ink-tertiary">Paste a public video URL</p>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setSourceType("upload")}
                className={`flex items-center gap-2.5 rounded-lg border px-3.5 py-3 text-left text-sm transition-colors ${
                  sourceType === "upload"
                    ? "border-accent/40 bg-accent-soft text-ink"
                    : "border-line text-ink-secondary hover:border-line-strong"
                }`}
              >
                <CloudArrowUp size={20} weight={sourceType === "upload" ? "fill" : "regular"} />
                <div>
                  <p className="font-medium leading-tight">Upload file</p>
                  <p className="text-xs text-ink-tertiary">MP4, MOV, or MKV</p>
                </div>
              </button>
            </div>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-ink-secondary">Title (optional)</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="My podcast episode"
                className="h-10 rounded-lg border border-line bg-surface-2 px-3 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-accent/50"
              />
            </label>

            {sourceType === "youtube" ? (
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="text-ink-secondary">YouTube URL</span>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=..."
                  className="h-10 rounded-lg border border-line bg-surface-2 px-3 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-accent/50"
                />
              </label>
            ) : (
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="text-ink-secondary">Video file</span>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex h-10 items-center justify-between rounded-lg border border-line bg-surface-2 px-3 text-left text-sm text-ink-tertiary hover:border-line-strong"
                >
                  <span className="truncate text-ink">{file ? file.name : "Choose a file..."}</span>
                  <CloudArrowUp size={16} />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="hidden"
                />
              </label>
            )}

            {error && (
              <p className="flex items-center gap-1.5 text-sm text-danger">
                <Warning size={14} weight="fill" />
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setComposerOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={isUploading} disabled={isUploading}>
                {isUploading ? "Creating..." : "Create project"}
              </Button>
            </div>
          </form>
        </Card>
      )}

      <div className="flex flex-col gap-3">
        {projectsQuery.isLoading && (
          <div className="flex flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="flex items-center gap-4 p-4">
                <Skeleton className="h-10 w-10 shrink-0 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
                <Skeleton className="h-6 w-20 rounded-full" />
              </Card>
            ))}
          </div>
        )}

        {projects?.length === 0 && !composerOpen && (
          <EmptyState
            icon={<FilmReel size={28} />}
            title="No projects yet"
            body="Create your first project and ClipForge will find the moments worth cutting."
            action={
              <Button onClick={() => setComposerOpen(true)}>
                <Plus size={16} weight="bold" />
                New project
              </Button>
            }
          />
        )}

        {projects?.map((p) => (
          <Link key={p.id} href={`/app/projects/${p.id}`}>
            <Card className="group flex items-center gap-4 p-4 transition-colors hover:border-line-strong">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-tertiary">
                <SourceTypeIcon type={p.source_type} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{p.title}</p>
                <p className="mt-0.5 truncate text-xs text-ink-muted">{p.source}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="flex items-center gap-1 text-xs text-ink-tertiary tabular-nums">
                  <Clock size={13} />
                  {p.clip_count} clip{p.clip_count === 1 ? "" : "s"}
                </span>
                <StatusPill status={p.status} />
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!window.confirm(`Delete "${p.title}"? You can't undo this.`)) return;
                    deleteProject.mutate(p.id, { onError: fail });
                  }}
                  disabled={deleteProject.isPending && deleteProject.variables === p.id}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted opacity-0 transition-opacity hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50"
                  aria-label={`Delete project ${p.title}`}
                >
                  <Trash size={15} />
                </button>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
