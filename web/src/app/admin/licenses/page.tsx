"use client";

import { useAdminLicenses } from "@/hooks/use-admin-licenses";
import { Card } from "@/components/ui/card";

export default function AdminLicensesPage() {
  const q = useAdminLicenses();
  const rows = q.data ?? [];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Licenses</h1>
        <p className="mt-1 text-sm text-ink-tertiary">
          Every desktop license on the platform, newest first. Read-only — the
          user revokes / reissues their own on{" "}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">/app/licenses</code>.
        </p>
      </header>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-line px-5 py-3">
          <h2 className="text-sm font-semibold text-ink">{rows.length} license{rows.length === 1 ? "" : "s"}</h2>
        </div>
        {q.isLoading ? (
          <div className="p-5 text-sm text-ink-tertiary">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-5 text-sm text-ink-tertiary">No licenses yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-2/60 text-xs uppercase tracking-wide text-ink-tertiary">
                <tr>
                  <th className="px-4 py-2">User</th>
                  <th className="px-4 py-2">Tier</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Devices</th>
                  <th className="px-4 py-2">Issued</th>
                  <th className="px-4 py-2">Reissued</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((l) => (
                  <tr key={l.id} className="bg-surface-1">
                    <td className="px-4 py-2">
                      <p className="font-medium text-ink truncate">{l.user_email}</p>
                      <p className="font-mono text-[10px] text-ink-tertiary">{l.id.slice(0, 12)}…</p>
                    </td>
                    <td className="px-4 py-2 capitalize text-ink">{l.tier}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                          l.is_valid
                            ? "bg-success/10 text-success"
                            : "bg-danger/10 text-danger"
                        }`}
                      >
                        {l.is_valid ? "Active" : "Revoked"}
                      </span>
                    </td>
                    <td className="px-4 py-2 tabular-nums text-ink">{l.device_count}</td>
                    <td className="px-4 py-2 text-ink-secondary">
                      {l.issued_at ? new Date(l.issued_at).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-2 text-ink-secondary">
                      {l.reissued_at ? new Date(l.reissued_at).toLocaleString() : <span className="text-ink-muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
