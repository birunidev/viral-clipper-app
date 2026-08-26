"use client";

import {
  ArrowCounterClockwise,
  ArrowLeft,
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
import { useCreateProject, useDeleteProject, usePurgeProject, usePresignUpload, useProjects, useRestoreProject, useTrashProjects } from "@/hooks/use-projects";

const TRASH_RETENTION_DAYS = 30;

function daysLeft(deletedAt: string): number {
  const deleted = new Date(deletedAt).getTime();
  const elapsed = Date.now() - deleted;
  const remaining = TRASH_RETENTION_DAYS - Math.floor(elapsed / 86_400_000);
  return Math.max(0, remaining);
}

export default function DashboardPage() {
  const router = useRouter();
  const [view, setView] = useState<"active" | "trash">("active");
  const projectsQuery = useProjects();
  const trashQuery = useTrashProjects();
  const createProject = useCreateProject();
  const presignUpload = usePresignUpload();
  const deleteProject = useDeleteProject();
  const restoreProject = useRestoreProject();
  const purgeProject = usePurgeProject();

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
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">
            {view === "trash" ? "Trash" : "Projects"}
          </h1>
          <p className="mt-1 text-sm text-ink-tertiary">
            {view === "trash"
              ? `Deleted projects are permanently removed after ${TRASH_RETENTION_DAYS} days.`
              : "Paste a YouTube link or upload a video — SnapClip finds the moments worth cutting."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {view === "trash" ? (
            <Button variant="ghost" onClick={() => setView("active")}>
              <ArrowLeft size={16} weight="bold" />
              Back
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setView("trash")}>
                <Trash size={16} />
                Trash
              </Button>
              {!composerOpen && (
                <Button onClick={() => setComposerOpen(true)}>
                  <Plus size={16} weight="bold" />
                  New project
                </Button>
              )}
            </>
          )}
        </div>
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
        {view === "trash" ? (
          <>
            {trashQuery.isLoading && (
              <Card className="p-4">
                <Skeleton className="h-4 w-1/3" />
              </Card>
            )}
            {trashQuery.data?.length === 0 && (
              <EmptyState
                icon={<Trash size={28} />}
                title="Trash is empty"
                body="Deleted projects stay here and restorable for 30 days."
              />
            )}
            {trashQuery.data?.map((p) => (
              <Card key={p.id} className="group flex items-center gap-4 p-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-tertiary">
                  <SourceTypeIcon type={p.source_type} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{p.title}</p>
                  {(() => {
                    const left = daysLeft(p.deleted_at);
                    const ago = TRASH_RETENTION_DAYS - left;
                    return (
                      <p className="mt-0.5 truncate text-xs text-ink-muted">
                        Deleted {ago} day{ago === 1 ? "" : "s"} ago · permanently removed in {left} day{left === 1 ? "" : "s"}
                      </p>
                    );
                  })()}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => restoreProject.mutate(p.id, { onError: fail })}
                    disabled={restoreProject.isPending}
                    className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
                    aria-label={`Restore project ${p.title}`}
                  >
                    <ArrowCounterClockwise size={14} />
                    Restore
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!window.confirm(`Permanently delete "${p.title}"? This frees its storage and can't be undone.`)) return;
                      purgeProject.mutate(p.id, { onError: fail });
                    }}
                    disabled={purgeProject.isPending}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                    aria-label={`Permanently delete project ${p.title}`}
                  >
                    <X size={15} />
                  </button>
                </div>
              </Card>
            ))}
          </>
        ) : (
          <>
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
            body="Create your first project and SnapClip will find the moments worth cutting."
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
                    if (!window.confirm(`Delete "${p.title}"? It moves to the trash and is restorable for ${TRASH_RETENTION_DAYS} days.`)) return;
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
          </>
        )}
      </div>
    </div>
  );
}
