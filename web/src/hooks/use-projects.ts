"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "@/lib/api";
import type { CaptionStyle, Job, ProjectDetail, ProjectListItem } from "./types";
import { settingsKey } from "./use-settings";

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

const TERMINAL_STATUSES = new Set(["completed", "failed"]);

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
    }) =>
      api.post<Job>(`/projects/${projectId}/clips/${payload.clipId}/render`, {
        orientation: payload.orientation,
        caption_style_id: payload.captionStyleId ?? null,
      }),
    onSuccess: (job) => {
      queryClient.setQueryData(jobKey(job.id), job);
      queryClient.invalidateQueries({ queryKey: projectKey(projectId) });
    },
  });
}

/** Delete a project: frees S3 storage + removes the DB row. */
export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => api.delete<void>(`/projects/${projectId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectsKey });
      queryClient.invalidateQueries({ queryKey: settingsKey });
    },
  });
}

export function usePresignUpload() {
  return useMutation({
    mutationFn: (payload: { file_name: string; content_type: string }) =>
      api.post<{ url: string; key: string }>("/uploads/presign", payload),
  });
}
