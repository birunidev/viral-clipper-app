"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { AdminLicenseRow } from "./types";

export const adminLicensesKey = ["admin", "licenses"] as const;

/** Read-only list of every License row in the system.  Gated by the
 * admin allowlist on the server. */
export function useAdminLicenses(enabled = true) {
  return useQuery<AdminLicenseRow[]>({
    queryKey: adminLicensesKey,
    queryFn: () => api.get<AdminLicenseRow[]>("/admin/licenses"),
    enabled,
    refetchInterval: 30_000,
  });
}
