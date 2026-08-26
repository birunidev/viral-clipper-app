"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import type { User } from "./types";

const SESSION_KEY = ["auth", "me"] as const;

export function useSession() {
  return useQuery<User | null>({
    queryKey: SESSION_KEY,
    queryFn: async () => {
      try {
        return await api.get<User>("/auth/me");
      } catch (err) {
        // Only an explicit 401 means "not logged in". Network errors and
        // server failures must surface as errors (React Query retries /
        // keeps previous data) — otherwise a transient blip would clear
        // the auth state and bounce a still-authenticated user to login.
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
}

export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { name: string; email: string; password: string }) =>
      api.post<User>("/auth/register", payload),
    onSuccess: (user) => {
      queryClient.setQueryData(SESSION_KEY, user);
    },
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { email: string; password: string }) =>
      api.post<User>("/auth/login", payload),
    onSuccess: (user) => {
      queryClient.setQueryData(SESSION_KEY, user);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>("/auth/logout"),
    onSuccess: () => {
      queryClient.setQueryData(SESSION_KEY, null);
      queryClient.clear();
    },
  });
}
