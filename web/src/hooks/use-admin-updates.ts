"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, uploadForm } from "@/lib/api";
import type { AppUpdateAdminStatus, AppUpdateRow } from "./types";

export const adminUpdatesKey = ["admin", "updates"] as const;
export const adminStatusKey = ["admin", "updates", "status"] as const;

/** Whether the current session is an admin (controlled by env allowlist). */
export function useAdminStatus() {
  return useQuery<AppUpdateAdminStatus>({
    queryKey: adminStatusKey,
    queryFn: () => api.get<AppUpdateAdminStatus>("/update/admin-status"),
    staleTime: 60_000,
  });
}

/** List of every published update, newest first. */
export function useUpdatesList(enabled = true) {
  return useQuery<AppUpdateRow[]>({
    queryKey: adminUpdatesKey,
    queryFn: () => api.get<AppUpdateRow[]>("/update/list"),
    enabled,
    refetchInterval: 15_000,
  });
}

export type UploadInput = {
  file: File;
  version: string;
  platform: "win32" | "darwin" | "linux";
  arch: "ia32" | "x64" | "arm64";
  releaseNotes: string;
  isBeta: boolean;
};

/** Upload a new binary. POST as multipart/form-data. */
export function useUploadUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UploadInput) => {
      const form = new FormData();
      form.append("file", input.file, input.file.name);
      form.append("version", input.version);
      form.append("platform", input.platform);
      form.append("arch", input.arch);
      form.append("release_notes", input.releaseNotes);
      form.append("is_beta", input.isBeta ? "true" : "false");
      return uploadForm<AppUpdateRow & { ok?: boolean; sha512: string }>("/update/upload", form);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: adminUpdatesKey });
    },
  });
}

/** Delete a published update (DB row + S3 object). */
export function useDeleteUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ ok: boolean }>(`/update/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: adminUpdatesKey });
    },
  });
}
