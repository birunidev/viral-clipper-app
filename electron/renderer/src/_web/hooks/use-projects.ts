"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { API_URL, api } from "@/lib/api";
import { renderClipInBrowser } from "@/lib/client-render/renderer";
import { clientRenderEnabled } from "@/lib/client-render/support";
import type {
  BillingStatus,
  CaptionStyle,
  Clip,
  Job,
  ProjectDetail,
  ProjectListItem,
  TrashProject,
} from "./types";
import { settingsKey } from "./use-settings";

/** Above this clip length the browser render gets memory-heavy (one
 * assembled audio buffer + all frames); longer clips go straight to the
 * server queue. */
const MAX_CLIENT_RENDER_SECONDS = 120;

export const projectsKey = ["projects"] as const;
export const projectKey = (id: string) => ["projects", id] as const;
export const jobKey = (id: string) => ["jobs", id] as const;
export const captionStylesKey = ["caption-styles"] as const;

/** Built-in + custom caption presets for the render style picker. Rarely
 * changes, so it's cached for the whole session. */
export function useCaptionStyles() {
  return useQuery<CaptionStyle[]>({
    queryKey: captionStylesKey,
    queryFn: () => api.get<CaptionStyle[]>("/caption-styles"),
    staleTime: Infinity,
  });
}

export function useProjects() {
  return useQuery<ProjectListItem[]>({
    queryKey: projectsKey,
    queryFn: () => api.get<ProjectListItem[]>("/projects"),
  });
}

export function useProject(id: string) {
  return useQuery<ProjectDetail>({
    queryKey: projectKey(id),
    queryFn: () => api.get<ProjectDetail>(`/projects/${id}`),
    enabled: !!id,
  });
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Polls a job's status every 2s while it's queued/running, and stops once
 * it reaches a terminal state. Replaces the manual setInterval from the
 * old Next.js project page. Consumers should call
 * `useProjectInvalidate(projectId, job)` to refresh clips when done.
 */
export function useJob(id: string) {
  return useQuery<Job>({
    queryKey: jobKey(id),
    queryFn: () => api.get<Job>(`/jobs/${id}`),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status && TERMINAL_STATUSES.has(status)) return false;
      return 2_000;
    },
  });
}

/**
 * Invalidates the parent project's query once `job` reaches a terminal
 * state, so new clips/status show up without a manual refresh.
 */
export function useRefreshProjectOnJobDone(projectId: string, job: Job | undefined) {
  const queryClient = useQueryClient();
  const status = job?.status;

  useEffect(() => {
    if (status && TERMINAL_STATUSES.has(status)) {
      queryClient.invalidateQueries({ queryKey: projectKey(projectId) });
      queryClient.invalidateQueries({ queryKey: projectsKey });
    }
  }, [status, projectId, queryClient]);
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      title: string;
      source: string;
      source_type: string;
      source_size_bytes?: number;
      llmVariant?: "tiny" | "balanced" | "quality" | null;
    }) => api.post<ProjectListItem>("/projects", payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectsKey }),
  });
}

export function useStartJob(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      orientation: string;
      max_clips: number;
      min_clip_seconds: number;
      max_clip_seconds: number;
    }) =>
      api.post<Job>(`/projects/${projectId}/start`, payload),
    onSuccess: (job) => {
      queryClient.setQueryData(jobKey(job.id), job);
      queryClient.invalidateQueries({ queryKey: projectKey(projectId) });
      queryClient.invalidateQueries({ queryKey: projectsKey });
    },
  });
}

/** Save a custom caption style from the in-app editor. Invalidates the
 * shared caption-styles cache so it shows up in every picker right away. */
export function useCreateCaptionStyle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { label: string; config: Record<string, unknown> }) =>
      api.post<CaptionStyle>("/caption-styles", payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: captionStylesKey }),
  });
}

/** Enqueue cutting + uploading a single clip (on-demand download). */
export function useRenderClip(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      clipId: string;
      orientation: string;
      captionStyleId?: string | null;
      captionConfig?: Record<string, unknown> | null;
    }) =>
      api.post<Job>(`/projects/${projectId}/clips/${payload.clipId}/render`, {
        orientation: payload.orientation,
        caption_style_id: payload.captionStyleId ?? null,
        caption_config: payload.captionConfig ?? null,
      }),
    onSuccess: (job) => {
      queryClient.setQueryData(jobKey(job.id), job);
      queryClient.invalidateQueries({ queryKey: projectKey(projectId) });
    },
  });
}

export type SmartRenderPayload = {
  clip: Clip;
  sourceUrl: string;
  orientation: string;
  captionStyleId?: string | null;
  /** Resolved style config to burn in (null → no captions, like server). */
  captionStyleConfig?: Record<string, unknown> | null;
  watermark?: boolean;
  maxResolution?: number | null;
  /** Local progress of the browser render, 0..1 (client path only). */
  onProgress?: (fraction: number) => void;
  /** Called if the client render bailed and the server queue took over. */
  onFallback?: () => void;
};

export type SmartRenderResult = {
  mode: "client" | "server";
  /** Set when mode === "client": the registered clip (with signed URL). */
  clip?: Clip;
  /** Set when mode === "server": the queued render job. */
  job?: Job;
};

/**
 * Render a single clip, preferring the browser (WebCodecs via mediabunny)
 * whenever the backend flag and browser capabilities allow. The client path
 * renders locally with live progress, auto-downloads the file, uploads it to
 * R2 via presign/PUT and registers it exactly like a server render. ANY
 * failure falls back transparently to the untouched server queue mutation.
 */
export function useSmartRenderClip(
  projectId: string,
  billing: BillingStatus | undefined
) {
  const queryClient = useQueryClient();
  const serverRender = useRenderClip(projectId);
  return useMutation<SmartRenderResult, Error, SmartRenderPayload>({
    mutationFn: async (payload) => {
      const isDesktop = typeof window !== "undefined" && !!(window as unknown as { clipzard?: unknown }).clipzard;
      // Desktop: 100% local ffmpeg — no S3, no mediabunny. Use serverRender path which maps to main.ts jobs:render → local file.
      if (isDesktop) {
        payload.onFallback?.(); // not needed but keeps parity
        try {
          const job = await serverRender.mutateAsync({
            clipId: payload.clip.id,
            orientation: payload.orientation,
            captionStyleId: payload.captionStyleId ?? null,
            captionConfig: payload.captionStyleConfig ?? null,
          });
          return { mode: "server", job };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Legacy main threw "Render already queued"; new main returns existing job.
          // Handle both gracefully: surface as existing job so UI shows progress (block until done).
          if (msg.includes("Render already")) {
            // Try to surface existing job from cache; invalidate to refetch real render_job
            // The main now returns existing, so this path only hits old binaries.
            throw new Error("Render already in progress — please wait until it finishes.");
          }
          throw err;
        }
      }
      const { clip, sourceUrl } = payload;
      if (
        clientRenderEnabled(billing) &&
        sourceUrl &&
        clip.end_time - clip.start_time <= MAX_CLIENT_RENDER_SECONDS
      ) {
        let blob: Blob | null = null;
        try {
          let lastReport = 0;
          blob = await renderClipInBrowser({
            sourceUrl,
            fallbackUrl: `${API_URL}/projects/${projectId}/source/stream`,
            clipStartSeconds: clip.start_time,
            clipEndSeconds: clip.end_time,
            orientation: "portrait",
            captionWords: clip.caption_json,
            captionStyle: (payload.captionStyleConfig as never) ?? null,
            watermark: payload.watermark,
            maxResolution: payload.maxResolution,
            onProgress: (fraction) => {
              const now = Date.now();
              if (fraction >= 1 || now - lastReport >= 250) {
                lastReport = now;
                payload.onProgress?.(fraction);
              }
            },
          });
        } catch (err) {
          console.warn("client-render: falling back to server render", err);
          payload.onFallback?.();
          const job = await serverRender.mutateAsync({
            clipId: clip.id,
            orientation: payload.orientation,
            captionStyleId: payload.captionStyleId ?? null,
            captionConfig: payload.captionStyleConfig ?? null,
          });
          return { mode: "server", job };
        }

        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = `${clip.title.replace(/[^\w]+/g, "-").toLowerCase() || "clip"}.mp4`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);

        const presign = await api.post<{ url: string; key: string }>(
          `/projects/${projectId}/clips/${clip.id}/client-render/presign`,
          {}
        );
        let uploaded = false;
        try {
          const put = await fetch(presign.url, {
            method: "PUT",
            headers: { "Content-Type": "video/mp4" },
            body: blob,
          });
          if (!put.ok) throw new Error(`Upload failed (${put.status} ${put.statusText})`);
          uploaded = true;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const isCors = msg.includes("Failed to fetch") || msg.includes("CORS") || msg.includes("NetworkError");
          if (!isCors) throw e;
          console.warn("client-render: direct PUT failed, retrying via proxy", e);
        }
        if (uploaded) {
          const registered = await api.post<Clip>(
            `/projects/${projectId}/clips/${clip.id}/client-render/complete`,
            { key: presign.key, size_bytes: blob.size }
          );
          return { mode: "client", clip: registered };
        }
        const proxyRegistered = await fetch(
          `${API_URL}/projects/${projectId}/clips/${clip.id}/client-render/upload?key=${encodeURIComponent(presign.key)}`,
          { method: "POST", credentials: "include", body: blob, headers: { "Content-Type": "video/mp4" } }
        ).then(async (r) => {
          if (!r.ok) {
            const t = await r.text().catch(() => r.statusText);
            throw new Error(`Proxy upload failed (${r.status} ${t})`);
          }
          return r.json() as Promise<Clip>;
        });
        return { mode: "client", clip: proxyRegistered };
      }
      payload.onFallback?.();

      const job = await serverRender.mutateAsync({
        clipId: clip.id,
        orientation: payload.orientation,
        captionStyleId: payload.captionStyleId ?? null,
        captionConfig: payload.captionStyleConfig ?? null,
      });
      return { mode: "server", job };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKey(projectId) });
    },
  });
}

/** Delete a project: moves it to the trash (soft delete). */
export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => api.delete<void>(`/projects/${projectId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectsKey });
      queryClient.invalidateQueries({ queryKey: trashKey });
      queryClient.invalidateQueries({ queryKey: settingsKey });
    },
  });
}

export const trashKey = ["projects-trash"] as const;

/** Soft-deleted projects (trash). Auto-purged server-side after 30 days. */
export function useTrashProjects() {
  return useQuery<TrashProject[]>({
    queryKey: trashKey,
    queryFn: () => api.get<TrashProject[]>("/projects/trash"),
  });
}

/** Take a project out of the trash back into the active list. */
export function useRestoreProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      api.post<ProjectListItem>(`/projects/${projectId}/restore`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectsKey });
      queryClient.invalidateQueries({ queryKey: trashKey });
    },
  });
}

/** Permanently delete a trashed project — frees its storage and project
 * quota. Not undoable; callers should confirm first. */
export function usePurgeProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      api.delete<void>(`/projects/${projectId}/purge`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectsKey });
      queryClient.invalidateQueries({ queryKey: trashKey });
      queryClient.invalidateQueries({ queryKey: settingsKey });
    },
  });
}

export type JobLog = { id: string; job_id: string; ts: string; level: string; stage: string | null; message: string };

export function useJobLogs(jobId: string) {
  const [logs, setLogs] = useState<JobLog[]>([]);
  useEffect(() => {
    if (!jobId) return;
    const w = window as unknown as { clipzard?: { getJobLogs?: (id: string) => Promise<unknown>; onJobLog?: (cb: (d: unknown) => void) => () => void } };
    if (w.clipzard?.getJobLogs) {
      w.clipzard.getJobLogs(jobId).then((rows) => {
        if (Array.isArray(rows)) setLogs(rows as JobLog[]);
      }).catch(() => {});
    }
    const off = w.clipzard?.onJobLog?.((data) => {
      const d = data as { jobId?: string; log?: JobLog };
      if (d?.jobId === jobId && d?.log) setLogs((prev: JobLog[]) => [...prev, d.log as JobLog]);
    });
    return () => { off?.(); };
  }, [jobId]);
  return logs;
}

export function useCancelJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (jobId: string) => {
      const w = window as unknown as { clipzard?: { jobCancel?: (id: string) => Promise<unknown> } };
      if (w.clipzard?.jobCancel) return w.clipzard.jobCancel(jobId) as Promise<void>;
      return api.post<void>(`/jobs/${jobId}/cancel`, {});
    },
    onSuccess: (_data, jobId) => {
      queryClient.invalidateQueries({ queryKey: jobKey(jobId) });
      queryClient.invalidateQueries({ queryKey: projectsKey });
    },
  });
}

export function useDeleteRenderedClip(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (clipId: string) => api.delete<void>(`/projects/${projectId}/clips/${clipId}/rendered`),
    onMutate: async (clipId) => {
      await queryClient.cancelQueries({ queryKey: projectKey(projectId) });
      const previous = queryClient.getQueryData<ProjectDetail>(projectKey(projectId));
      // Optimistic: clear video URLs immediately so UI reflects without waiting for refetch
      queryClient.setQueryData<ProjectDetail>(projectKey(projectId), (old) => {
        if (!old) return old;
        const patchClip = (c: Clip) =>
          c.id === clipId ? { ...c, video_url: null, signed_video_url: null, caption_style_id: null, render_job: null } : c;
        // Handle both flat and nested shapes (main returns both)
        const maybeNested = old as unknown as { project?: ProjectDetail };
        if (maybeNested.project && Array.isArray((maybeNested.project as unknown as { clips?: unknown }).clips)) {
          // shouldn't happen, but be safe
        }
        return {
          ...old,
          clips: old.clips.map(patchClip),
        } as ProjectDetail;
      });
      return { previous };
    },
    onError: (_err, _clipId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(projectKey(projectId), context.previous);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKey(projectId) });
      queryClient.invalidateQueries({ queryKey: projectsKey });
    },
    onSettled: () => {
      // Ensure fresh data from disk
      queryClient.invalidateQueries({ queryKey: projectKey(projectId) });
    },
  });
}

export function usePresignUpload() {
  // Desktop: no S3 — file is local path, no presign needed. Keep stub for web compat.
  return useMutation({
    mutationFn: async (_payload: { file_name: string; content_type: string }) => {
      const isDesktop = typeof window !== "undefined" && !!(window as unknown as { clipzard?: unknown }).clipzard;
      if (isDesktop) throw new Error("Upload is local file on desktop — no presign needed");
      return api.post<{ url: string; key: string }>("/uploads/presign", _payload);
    },
  });
}
