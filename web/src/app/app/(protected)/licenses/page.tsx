"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useMyLicenses, useLicenseDevices, useRevokeLicense, useReissueLicense, useRevokeDevice } from "@/hooks/use-licenses";
import type { LicenseSummary, DeviceSummary } from "@/hooks/types";

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function DeviceRow({
  device,
  onRevoke,
}: {
  device: DeviceSummary;
  onRevoke: (id: string) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-line px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="text-xs font-mono text-ink-tertiary">{device.os}</span>
        <div>
          <p className="text-sm font-medium text-ink">{device.device_name}</p>
          <p className="text-xs text-ink-tertiary">
            {device.is_revoked ? "Revoked" : `Last seen ${timeAgo(device.last_seen_at)}`}
          </p>
        </div>
      </div>
      {!device.is_revoked && (
        <button
          onClick={() => onRevoke(device.id)}
          className="text-xs text-danger hover:underline"
        >
          Revoke
        </button>
      )}
    </div>
  );
}

function LicenseCard({
  license,
  onReissue,
}: {
  license: LicenseSummary;
  onReissue: (id: string) => void;
}) {
  const devices = useLicenseDevices(license.id);
  const revokeDevice = useRevokeDevice();

  return (
    <Card>
      <div className="border-b border-line px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm font-semibold capitalize text-ink">{license.tier}</span>
            {license.is_active ? (
              <span className="ml-2 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
                Active
              </span>
            ) : (
              <span className="ml-2 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger">
                Revoked
              </span>
            )}
          </div>
          {license.is_active && (
            <Button
              variant="secondary"
              onClick={() => onReissue(license.id)}
              className="text-xs"
            >
              Reissue key
            </Button>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-tertiary">
          <span>Issued {timeAgo(license.issued_at)}</span>
          {license.reissued_at && (
            <span>Reissued {timeAgo(license.reissued_at)}</span>
          )}
          {license.reissued_from_id && (
            <span className="font-mono">↻ from {license.reissued_from_id.slice(0, 8)}…</span>
          )}
        </div>
      </div>

      <div className="px-6 py-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          Devices ({license.device_count} active)
        </p>
        {devices.isLoading ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg bg-surface-2" />
            ))}
          </div>
        ) : devices.data?.devices && devices.data.devices.length > 0 ? (
          <div className="space-y-2">
            {devices.data.devices.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                onRevoke={(id) => revokeDevice.mutate(id)}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-tertiary">No active devices.</p>
        )}
      </div>
    </Card>
  );
}

export default function LicensesPage() {
  const licensesQuery = useMyLicenses();
  const reissueMutation = useReissueLicense();
  const [reissued, setReissued] = useState<string | null>(null);

  const licenses = licensesQuery.data?.licenses ?? [];

  function handleReissue(licenseId: string) {
    reissueMutation.mutate(licenseId, {
      onSuccess: (data) => {
        setReissued(data.new_license_id);
        licensesQuery.refetch();
      },
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Licenses</h1>
        <p className="mt-1 text-sm text-ink-tertiary">
          Manage your desktop license keys and the devices authorised to run ClipZard.
          Maximum {activeLicense?.device_count ?? 0} active devices.
        </p>
      </header>

      {reissued && (
        <div className="rounded-lg border border-success/30 bg-success/5 p-4 text-sm text-success">
          New license key generated. Old key has been revoked. Re-download ClipZard to get the new key.
        </div>
      )}

      {reissueMutation.isError && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-4 text-sm text-danger">
          Failed to reissue. Try again or contact support.
        </div>
      )}

      {licensesQuery.isLoading ? (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="h-48 animate-pulse rounded-xl border border-line bg-surface-1" />
          ))}
        </div>
      ) : licenses.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong px-6 py-16 text-center">
          <p className="text-sm text-ink-tertiary">No license found.</p>
          <a
            href="/app/billing"
            className="mt-2 inline-block text-sm font-medium text-accent hover:underline"
          >
            Buy a license →
          </a>
        </div>
      ) : (
        <div className="space-y-4">
          {licenses.map((lic) => (
            <LicenseCard key={lic.id} license={lic} onReissue={handleReissue} />
          ))}
        </div>
      )}

      <div className="rounded-xl border border-line bg-surface-1 px-6 py-5">
        <h2 className="text-sm font-semibold text-ink">Reissue vs Revoke</h2>
        <p className="mt-2 text-sm text-ink-tertiary">
          <strong>Reissue</strong> generates a fresh license key and immediately revokes all devices —
          use this when your devices have changed and you want a clean slate.{" "}
          <strong>Revoke</strong> on a device just removes that one device from the activation list.
        </p>
      </div>
    </div>
  );
}
