"use client";

import {
  CheckCircle,
  CircleNotch,
  CloudArrowUp,
  Copy,
  Database,
  Package,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  useAdminStatus,
  useDeleteUpdate,
  useUpdatesList,
  useUploadUpdate,
} from "@/hooks/use-admin-updates";
import type { AppUpdateRow } from "@/hooks/types";

type Platform = "win32" | "darwin" | "linux";
type Arch = "ia32" | "x64" | "arm64";

const PLATFORMS: { value: Platform; label: string }[] = [
  { value: "win32", label: "Windows" },
  { value: "darwin", label: "macOS" },
  { value: "linux", label: "Linux" },
];
const ARCHES: { value: Arch; label: string }[] = [
  { value: "x64", label: "x64" },
  { value: "ia32", label: "ia32 (x86 32-bit)" },
  { value: "arm64", label: "arm64" },
];
const DEFAULT_PLATFORM: Platform = "win32";
const DEFAULT_ARCH: Arch = "x64";

const inputClass =
  "h-10 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-accent/50 disabled:opacity-50";

export default function UpdatesAdminPage() {
  const admin = useAdminStatus();
  const list = useUpdatesList(admin.data?.is_admin ?? false);
  const upload = useUploadUpdate();
  const del = useDeleteUpdate();

  const [version, setVersion] = useState("0.1.0");
  const [platform, setPlatform] = useState<Platform>(DEFAULT_PLATFORM);
  const [arch, setArch] = useState<Arch>(DEFAULT_ARCH);
  const [isBeta, setIsBeta] = useState(false);
  const [releaseNotes, setReleaseNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<
    { kind: "ok" | "err"; msg: string } | null
  >(null);

  const canUpload = useMemo(
    () => Boolean(file) && version.trim().length > 0 && !upload.isPending,
    [file, version, upload.isPending],
  );

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setFeedback(null);
    setProgress(0);
    try {
      // XHR for upload progress (fetch doesn't expose it in browsers yet)
      const form = new FormData();
      form.append("file", file, file.name);
      form.append("version", version.trim());
      form.append("platform", platform);
      form.append("arch", arch);
      form.append("release_notes", releaseNotes);
      form.append("is_beta", isBeta ? "true" : "false");
      const res = await new Promise<{ ok: boolean; version: string; size_bytes: number; sha512: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api/v1"}/update/upload`);
        xhr.withCredentials = true;
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) setProgress(Math.round((ev.loaded / ev.total) * 100));
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch (err) {
              reject(new Error(`invalid JSON: ${String(err)}`));
            }
          } else {
            let msg = xhr.statusText;
            try {
              const body = JSON.parse(xhr.responseText);
              msg = body.detail ?? body.error ?? msg;
            } catch {
              /* not JSON */
            }
            reject(new Error(`HTTP ${xhr.status}: ${msg}`));
          }
        };
        xhr.onerror = () => reject(new Error("network error"));
        xhr.send(form);
      });
      setFeedback({
        kind: "ok",
        msg: `Uploaded ${res.version} (${(res.size_bytes / 1e6).toFixed(1)} MB, sha512 ${res.sha512.slice(0, 12)}…)`,
      });
      setFile(null);
      setReleaseNotes("");
      setProgress(null);
      list.refetch();
    } catch (err) {
      setFeedback({ kind: "err", msg: err instanceof Error ? err.message : String(err) });
      setProgress(null);
    }
  }

  async function handleDelete(row: AppUpdateRow) {
    if (!confirm(`Delete ${row.version} (${row.platform}/${row.arch}${row.is_beta ? " BETA" : ""})? This removes the S3 object and the DB row.`)) return;
    try {
      await del.mutateAsync(row.id);
    } catch (err) {
      alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const apiBase = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api/v1").replace(/\/$/, "");
  const checkUrl = (row: AppUpdateRow, channel: "stable" | "beta") =>
    `${apiBase}/update/check?version=0.0.0&platform=${row.platform}&arch=${row.arch}&channel=${channel}`;

  function copyToClipboard(text: string) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallback(text));
    } else {
      fallback(text);
    }
  }
  function fallback(text: string) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }

  if (!admin.data) {
    return (
      <div className="text-sm text-ink-tertiary">Loading…</div>
    );
  }
  if (!admin.data.is_admin) {
    return (
      <div className="rounded-xl border border-danger/20 bg-danger-soft p-4 text-sm text-danger">
        <p className="font-medium">Admin access required</p>
        <p className="mt-1 text-xs">
          Your account ({admin.data.email ?? "anonymous"}) is not in the admin allowlist. Set
          <code className="mx-1 rounded bg-surface-2 px-1 py-0.5 text-[11px]">CLIPZARD_ADMIN_EMAILS</code>
          on the backend to grant access.
        </p>
      </div>
    );
  }

  if (!admin.data.admin_emails_configured && !process.env.NEXT_PUBLIC_CLIPZARD_ADMIN_TOKEN) {
    return (
      <div className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm">
        <p className="flex items-center gap-1.5 font-medium text-warning">
          <Warning size={14} weight="fill" />
          No admin allowlist configured
        </p>
        <p className="mt-1 text-xs text-ink-secondary">
          Set <code className="rounded bg-surface-2 px-1 py-0.5 text-[11px]">CLIPZARD_ADMIN_EMAILS=you@example.com</code> on the
          backend. The current session is treated as admin because no allowlist is set — this is unsafe for production.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight text-ink">
          <Package size={20} className="text-accent" weight="fill" />
          App updates
        </h1>
        <p className="mt-1 text-sm text-ink-tertiary">
          Publish installer binaries so installed ClipZard apps can self-update. Uploaded files land in S3; the desktop
          app pulls from <code className="rounded bg-surface-2 px-1 py-0.5 text-[11px]">{apiBase}/update/check</code>.
        </p>
      </div>

      {/* Upload form */}
      <Card className="p-5">
        <div className="flex items-center gap-2 text-sm font-medium text-ink">
          <CloudArrowUp size={16} className="text-accent" />
          Publish a new version
        </div>
        <p className="mt-1 text-xs text-ink-tertiary">
          File is streamed to S3; SHA-512 is computed in-flight so a corrupt upload is rejected before it lands.
        </p>

        <form onSubmit={handleUpload} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-ink-secondary">Binary file</label>
            <label
              className={`flex h-20 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed bg-surface-2/40 px-3 text-center text-xs transition-colors hover:border-accent/50 ${file ? "border-accent/50" : "border-line-strong"}`}
            >
              <input
                type="file"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file ? (
                <>
                  <p className="truncate text-ink">{file.name}</p>
                  <p className="text-[11px] text-ink-muted">{(file.size / 1e6).toFixed(1)} MB</p>
                </>
              ) : (
                <>
                  <p className="text-ink-secondary">Click to choose</p>
                  <p className="text-[11px] text-ink-muted">.exe / .dmg / .AppImage / .deb</p>
                </>
              )}
            </label>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-ink-secondary">Version</label>
            <input
              type="text"
              className={inputClass}
              placeholder="0.2.0"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
            />
            <p className="text-[11px] text-ink-muted">Semver. Re-uploading the same version overwrites.</p>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-ink-secondary">Platform</label>
            <select className={inputClass} value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
              {PLATFORMS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-ink-secondary">Architecture</label>
            <select className={inputClass} value={arch} onChange={(e) => setArch(e.target.value as Arch)}>
              {ARCHES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1 sm:col-span-2">
            <label className="text-xs font-medium text-ink-secondary">Release notes</label>
            <textarea
              className={`${inputClass} h-24 py-2`}
              placeholder="## 0.2.0&#10;- Fixed download race&#10;- New caption style"
              value={releaseNotes}
              onChange={(e) => setReleaseNotes(e.target.value)}
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-ink-secondary sm:col-span-2">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-accent"
              checked={isBeta}
              onChange={(e) => setIsBeta(e.target.checked)}
            />
            <span>
              Mark as <span className="font-medium text-ink">beta</span> (only delivered to users opted into the beta
              channel)
            </span>
          </label>

          <div className="flex items-center justify-between gap-3 sm:col-span-2">
            <div className="text-xs text-ink-tertiary">
              {progress !== null ? `Uploading… ${progress}%` : "Ready"}
            </div>
            <Button type="submit" variant="primary" size="md" loading={upload.isPending || progress !== null} disabled={!canUpload}>
              Publish
            </Button>
          </div>

          {feedback && (
            <div
              className={`flex items-center gap-2 rounded-lg border p-3 text-xs sm:col-span-2 ${
                feedback.kind === "ok"
                  ? "border-success/30 bg-success/10 text-success"
                  : "border-danger/30 bg-danger-soft text-danger"
              }`}
            >
              {feedback.kind === "ok" ? <CheckCircle size={14} weight="fill" /> : <Warning size={14} weight="fill" />}
              {feedback.msg}
            </div>
          )}
        </form>
      </Card>

      {/* Existing updates */}
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-ink">
            <Database size={16} className="text-accent" />
            Published updates
            <span className="text-xs text-ink-muted">({list.data?.length ?? 0})</span>
          </div>
          {list.isFetching && <CircleNotch size={14} className="animate-spin text-ink-tertiary" />}
        </div>
        {list.isLoading ? (
          <p className="mt-4 text-xs text-ink-tertiary">Loading…</p>
        ) : list.error ? (
          <p className="mt-4 text-xs text-danger">Failed to load: {String(list.error)}</p>
        ) : !list.data || list.data.length === 0 ? (
          <p className="mt-4 text-xs text-ink-tertiary">No updates yet. Publish one above to get started.</p>
        ) : (
          <ul className="mt-4 flex flex-col divide-y divide-line-soft">
            {list.data.map((u) => (
              <li key={u.id} className="grid grid-cols-1 gap-2 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                    <span>v{u.version}</span>
                    <span className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-secondary">
                      {u.platform}
                    </span>
                    <span className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-secondary">
                      {u.arch}
                    </span>
                    {u.is_beta && (
                      <span className="rounded-md border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">
                        BETA
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-ink-muted">
                    {(u.size_bytes / 1e6).toFixed(1)} MB · sha512 {u.sha512.slice(0, 16)}… ·{" "}
                    {u.created_at ? new Date(u.created_at).toLocaleString() : "—"}
                  </div>
                  {u.release_notes && (
                    <pre className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-2/40 px-2 py-1 text-[11px] text-ink-secondary">
                      {u.release_notes}
                    </pre>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-ink-muted">
                    <span>check URL:</span>
                    <code className="rounded bg-surface-2 px-1 py-0.5 text-ink-secondary">{checkUrl(u, "stable")}</code>
                    <button
                      onClick={() => copyToClipboard(checkUrl(u, "stable"))}
                      className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-ink-tertiary hover:bg-surface-2 hover:text-ink"
                      type="button"
                    >
                      <Copy size={11} /> copy
                    </button>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(u)}
                  disabled={del.isPending}
                  className="text-ink-tertiary hover:text-danger"
                >
                  <Trash size={13} />
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-[11px] text-ink-muted">
        Tip: build a release with{" "}
        <code className="rounded bg-surface-2 px-1 py-0.5">npm --prefix electron run build:win</code>, then upload here.
        Users on an older version will detect the new release on next launch (and on each 6h check).
      </p>
    </div>
  );
}
