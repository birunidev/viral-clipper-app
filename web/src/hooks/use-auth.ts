"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { User } from "./types";

const SESSION_KEY = ["auth", "me"] as const;

export function useSession() {
  return useQuery<User | null>({
    queryKey: SESSION_KEY,
    queryFn: async () => {
      try {
        return await api.get<User>("/auth/me");
      } catch {
        return null;
      }
    },
    retry: false,
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
