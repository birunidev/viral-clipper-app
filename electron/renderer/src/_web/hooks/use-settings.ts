"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { UserSettings } from "./types";

export const settingsKey = ["settings"] as const;

/** The user's BYOK settings + storage usage. */
export function useSettings() {
  return useQuery<UserSettings>({
    queryKey: settingsKey,
    queryFn: () => api.get<UserSettings>("/settings"),
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      transcription_provider?: "assemblyai" | "local";
      llm_base_url?: string | null;
      llm_model?: string | null;
      llm_api_key?: string | null;
      assemblyai_key?: string | null;
    }) => api.put<UserSettings>("/settings", payload),
    onSuccess: (settings) => queryClient.setQueryData(settingsKey, settings),
  });
}
