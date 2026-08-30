"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { DeviceSummary, LicenseSummary, User } from "./types";

const LICENSES_KEY = ["licenses", "me"] as const;
const DEVICES_KEY = (licenseId: string) => ["licenses", licenseId, "devices"] as const;

export function useMyLicenses() {
  return useQuery<{ licenses: LicenseSummary[] }>({
    queryKey: LICENSES_KEY,
    queryFn: () => api.get<{ licenses: LicenseSummary[] }>("/licenses/me"),
    staleTime: 30_000,
  });
}

export function useLicenseDevices(licenseId: string | null) {
  return useQuery<{ devices: DeviceSummary[] }>({
    queryKey: licenseId ? DEVICES_KEY(licenseId) : ["licenses", "_", "devices"],
    queryFn: () => api.get<{ devices: DeviceSummary[] }>(`/licenses/${licenseId}/devices`),
    enabled: !!licenseId,
    staleTime: 15_000,
  });
}

export function useRevokeLicense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (licenseId: string) =>
      api.post<{ ok: true }>(`/licenses/${licenseId}/revoke`, { reason: "user_request" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["licenses"] });
      qc.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });
}

export function useReissueLicense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (licenseId: string) =>
      api.post<{ ok: true; new_license_id: string }>(`/licenses/${licenseId}/reissue`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["licenses"] });
      qc.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });
}

export function useRevokeDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deviceInternalId: string) =>
      api.post<{ ok: true }>(`/devices/${deviceInternalId}/revoke`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["licenses"] });
      qc.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });
}

export function useRequestPasswordReset() {
  return useMutation({
    mutationFn: (email: string) =>
      api.post<{ ok: true }>("/auth/password/reset-request", { email }),
  });
}

export function useConfirmPasswordReset() {
  return useMutation({
    mutationFn: (payload: { token: string; new_password: string }) =>
      api.post<{ ok: true }>("/auth/password/reset-confirm", payload),
  });
}

export type { User };
