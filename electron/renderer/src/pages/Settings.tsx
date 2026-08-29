"use client";

import { Check, Database, Warning, XCircle, DownloadSimple, Trash, HardDrive } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useSettings, useUpdateSettings } from "@/hooks/use-settings";
import { useProjects, useDeleteProject } from "@/hooks/use-projects";
import { useBilling } from "@/hooks/use-billing";
import type { UserSettings } from "@/hooks/types";

const inputClass =
  "h-10 rounded-lg border border-line bg-surface-2 px-3 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-accent/50";

/**
 * BYOK settings: users bring their own LLM (OpenAI-compatible) and
 * AssemblyAI keys so the app runs on their own API credits, plus a view of
 * their storage quota and the projects consuming it.
 */
export default function SettingsPage() {
  const settingsQuery = useSettings();
  const settings = settingsQuery.data;
  const projectsQuery = useProjects();
  const deleteProject = useDeleteProject();
  const billing = useBilling();
  const byok = billing.data?.byok_enabled ?? false;
  const [deleteError, setDeleteError] = useState("");

  const used = settings?.storage_used_bytes ?? 0;
  const cap = settings?.storage_cap_bytes ?? 0;
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Settings</h1>
        <p className="mt-1 text-sm text-ink-tertiary">
          Manage your storage, local AI models and workspace. If onboarding failed, finish setup here.
        </p>
      </div>

      {/* Dependency Setup — same as onboarding, with logs */}
      <DependencySetupCard />

      {/* Local AI Models */}
      <LocalModelsCard />

      {/* Storage */}
      <Card className="p-5">
        <div className="flex items-center gap-2 text-sm font-medium text-ink">
          <Database size={16} className="text-accent" />
          Storage
        </div>
        <p className="mt-1 text-xs text-ink-tertiary">
          {fmtBytes(used)} of {fmtBytes(cap)} used
        </p>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
            style={{ width: `${Math.max(pct, used > 0 ? 2 : 0)}%` }}
          />
        </div>
        {pct >= 90 && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-danger">
            <Warning size={13} weight="fill" />
            You&apos;re almost at the storage limit. Delete a project to free space.
          </p>
        )}

        {projectsQuery.data && projectsQuery.data.length > 0 && (
          <div className="mt-4 flex flex-col gap-2 border-t border-line-soft pt-4">
            <p className="text-xs font-medium text-ink-secondary">Projects</p>
            {deleteError && (
              <p className="flex items-center gap-1.5 text-xs text-danger">
                <Warning size={13} weight="fill" />
                {deleteError}
              </p>
            )}
            {projectsQuery.data.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{p.title}</p>
                  <p className="text-xs text-ink-tertiary">{p.clip_count} clips</p>
                </div>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={deleteProject.isPending}
                  onClick={() => {
                    if (confirm(`Delete "${p.title}" and its rendered files? This frees up storage.`)) {
                      deleteProject.mutate(p.id, {
                        onError: (err) => setDeleteError(err.message),
                      });
                    }
                  }}
                >
                  <XCircle size={13} />
                  Delete
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* BYOK keys (hidden unless the feature is enabled) */}
      {byok && (
        <KeysForm
          key={settings ? "loaded" : "loading"}
          settings={settings ?? null}
        />
      )}
    </div>
  );
}

/** The editable BYOK key form. Remounted (via `key`) when settings load, so
 * its initial state comes straight from props with no hydration effect. */
function KeysForm({ settings }: { settings: UserSettings | null }) {
  const updateSettings = useUpdateSettings();

  const [provider, setProvider] = useState<"assemblyai" | "local">(
    settings?.transcription_provider ?? "assemblyai"
  );
  const [llmBaseUrl, setLlmBaseUrl] = useState(settings?.llm_base_url ?? "");
  const [llmModel, setLlmModel] = useState(settings?.llm_model ?? "");
  const [llmKey, setLlmKey] = useState("");
  const [aaiKey, setAaiKey] = useState("");
  const [clearLlm, setClearLlm] = useState(false);
  const [clearAai, setClearAai] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");
  const [error, setError] = useState("");

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSavedMsg("");
    updateSettings.mutate(
      {
        transcription_provider: provider,
        llm_base_url: llmBaseUrl.trim() || null,
        llm_model: llmModel.trim() || null,
        // Key fields: an untouched/empty input must NOT wipe a stored key,
        // so empty means "leave unchanged" (null). Clearing is explicit —
        // only the "Remove" button sends "" (the backend's clear value).
        llm_api_key: clearLlm ? "" : llmKey || null,
        assemblyai_key: clearAai ? "" : aaiKey || null,
      },
      {
        onSuccess: () => {
          setLlmKey("");
          setAaiKey("");
          setClearLlm(false);
          setClearAai(false);
          setSavedMsg("Saved. Keys are encrypted at rest.");
        },
        onError: (err) => setError(err.message),
      }
    );
  }

  return (
    <Card className="p-5">
      <form onSubmit={handleSave} className="flex flex-col gap-4">
        <div>
          <p className="text-sm font-medium text-ink">API keys</p>
          <p className="mt-0.5 text-xs text-ink-tertiary">
            Without a key, the app falls back to the shared backend keys.
          </p>
        </div>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-ink-secondary">Transcription provider</span>
          <div className="flex gap-2">
            {(["assemblyai", "local"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setProvider(p)}
                className={`flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm transition-colors ${
                  provider === p
                    ? "border-accent/40 bg-accent-soft text-ink"
                    : "border-line text-ink-secondary hover:border-line-strong"
                }`}
              >
                {provider === p && <Check size={14} weight="bold" className="text-accent" />}
                {p === "assemblyai" ? "AssemblyAI (cloud)" : "Local whisper.cpp"}
              </button>
            ))}
          </div>
        </label>

        {provider === "assemblyai" && (
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="flex items-center justify-between text-ink-secondary">
              AssemblyAI API key{settings?.has_assemblyai_key ? " — set" : ""}
              {clearAai ? (
                <button
                  type="button"
                  onClick={() => setClearAai(false)}
                  className="text-xs font-normal text-accent hover:underline"
                >
                  Keep key
                </button>
              ) : (
                settings?.has_assemblyai_key && (
                  <button
                    type="button"
                    onClick={() => {
                      setClearAai(true);
                      setAaiKey("");
                    }}
                    className="text-xs font-normal text-danger hover:underline"
                  >
                    Remove saved key on save
                  </button>
                )
              )}
            </span>
            <input
              type="password"
              value={aaiKey}
              onChange={(e) => {
                setAaiKey(e.target.value);
                if (e.target.value) setClearAai(false);
              }}
              placeholder={
                clearAai
                  ? "Will be removed when you save"
                  : settings?.has_assemblyai_key
                    ? `•••••••• (${settings.assemblyai_key_preview ?? "set"})`
                    : "sk-…"
              }
              disabled={clearAai}
              className={`${inputClass}${clearAai ? " opacity-50" : ""}`}
              autoComplete="off"
            />
          </label>
        )}

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="flex items-center justify-between text-ink-secondary">
            LLM API key (OpenAI-compatible){settings?.has_llm_api_key ? " — set" : ""}
            {clearLlm ? (
              <button
                type="button"
                onClick={() => setClearLlm(false)}
                className="text-xs font-normal text-accent hover:underline"
              >
                Keep key
              </button>
            ) : (
              settings?.has_llm_api_key && (
                <button
                  type="button"
                  onClick={() => {
                    setClearLlm(true);
                    setLlmKey("");
                  }}
                  className="text-xs font-normal text-danger hover:underline"
                >
                  Remove saved key on save
                </button>
              )
            )}
          </span>
          <input
            type="password"
            value={llmKey}
            onChange={(e) => {
              setLlmKey(e.target.value);
              if (e.target.value) setClearLlm(false);
            }}
            placeholder={
              clearLlm
                ? "Will be removed when you save"
                : settings?.has_llm_api_key
                  ? `•••••••• (${settings.llm_api_key_preview ?? "set"})`
                  : "sk-…"
            }
            disabled={clearLlm}
            className={`${inputClass}${clearLlm ? " opacity-50" : ""}`}
            autoComplete="off"
          />
        </label>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-ink-secondary">LLM base URL</span>
            <input
              type="text"
              value={llmBaseUrl}
              onChange={(e) => setLlmBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-ink-secondary">LLM model</span>
            <input
              type="text"
              value={llmModel}
              onChange={(e) => setLlmModel(e.target.value)}
              placeholder="gpt-4o-mini"
              className={inputClass}
            />
          </label>
        </div>

        {error && (
          <p className="flex items-center gap-1.5 text-sm text-danger">
            <Warning size={14} weight="fill" />
            {error}
          </p>
        )}
        {savedMsg && (
          <p className="flex items-center gap-1.5 text-sm text-success">
            <Check size={14} weight="bold" />
            {savedMsg}
          </p>
        )}

        <div className="flex justify-end">
          <Button type="submit" loading={updateSettings.isPending} disabled={updateSettings.isPending}>
            Save keys
          </Button>
        </div>
      </form>
    </Card>
  );
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

type VariantInfo = {
  key: "tiny" | "balanced" | "quality";
  label: string;
  file: string;
  sizeMb: number;
  installed: boolean;
  bytesOnDisk: number;
  description: string;
};

function DependencySetupCard() {
  const [deps, setDeps] = useState<{ deps: { key: string; label: string; installed: boolean; path: string | null; description: string }[]; allReady: boolean; missing: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});

  const refresh = async () => {
    const cf = (window as unknown as { clipzard?: { depsStatus: () => Promise<unknown> } }).clipzard;
    if (!cf?.depsStatus) return;
    try { setDeps((await cf.depsStatus()) as typeof deps); } catch {}
  };

  useEffect(() => {
    refresh();
    const cf = (window as unknown as { clipzard?: { onDepsProgress: (cb: (d: unknown) => void) => () => void } }).clipzard;
    if (!cf?.onDepsProgress) return;
    const off = cf.onDepsProgress((d) => {
      const { key, progress: p, stage, done, error } = d as { key: string; progress: number; stage?: string; done?: boolean; error?: string };
      if (typeof p === "number") setProgress((prev) => ({ ...prev, [key]: p }));
      const line = `[${key}] ${stage ?? (done ? "done" : error ? `error: ${error}` : `${Math.round(p * 100)}%`)}`;
      setLogs((prev) => [...prev.slice(-200), line]);
      if (done) refresh();
    });
    return off;
  }, []);

  const handleEnsureAll = async () => {
    const cf = (window as unknown as { clipzard?: { depsEnsureAll: () => Promise<unknown> } }).clipzard;
    if (!cf?.depsEnsureAll) return;
    setBusy(true);
    setLogs((prev) => [...prev, "Starting dependency setup..."]);
    try { await cf.depsEnsureAll(); await refresh(); setLogs((prev) => [...prev, "All dependencies ready"]); } catch (e) { setLogs((prev) => [...prev, `Failed: ${String((e as Error).message)}`]); }
    finally { setBusy(false); }
  };

  if (!deps) return <Card className="p-5"><p className="text-xs text-ink-tertiary">Checking dependencies…</p></Card>;

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-ink">
          <DownloadSimple size={16} className="text-accent" />
          Dependency Setup
          {deps.allReady ? <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-600">Ready</span> : <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600">Incomplete</span>}
        </div>
        <Button size="sm" variant={deps.allReady ? "secondary" : "primary"} disabled={busy} onClick={handleEnsureAll} loading={busy}>
          {deps.allReady ? "Re-check" : "Download All"}
        </Button>
      </div>
      <p className="mt-1 text-xs text-ink-tertiary">
        {deps.allReady ? "All required models and binaries are ready. You can create clips." : `Missing: ${deps.missing.join(", ") || "unknown"} — finish setup before creating clips (same as onboarding).`}
      </p>
      <div className="mt-3 flex flex-col gap-1.5">
        {deps.deps.map((d) => (
          <div key={d.key} className={`flex items-center justify-between rounded-lg border px-3 py-2 text-xs ${d.installed ? "border-emerald-500/20 bg-emerald-500/5" : "border-amber-500/20 bg-amber-500/5"}`}>
            <div className="min-w-0">
              <p className="font-medium text-ink truncate">{d.label} {d.installed ? <Check size={12} className="inline text-emerald-600" weight="bold" /> : <Warning size={12} className="inline text-amber-600" weight="fill" />}</p>
              <p className="text-[11px] text-ink-tertiary truncate">{d.description}</p>
              {progress[d.key] != null && progress[d.key] < 1 && <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-2"><div className="h-full bg-accent" style={{ width: `${progress[d.key] * 100}%` }} /></div>}
            </div>
            <span className="ml-2 shrink-0 font-mono text-[10px] text-ink-muted truncate max-w-[180px]">{d.path ?? ""}</span>
          </div>
        ))}
      </div>
      {logs.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-ink-secondary">Logs</p>
          <div className="mt-1 max-h-40 overflow-auto rounded-lg border border-line bg-surface-2 p-2 font-mono text-[11px] leading-relaxed text-ink-secondary">
            {logs.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </div>
      )}
      <p className="mt-2 text-[11px] text-ink-muted">
        Onboarding can be skipped if stuck — then finish here. Once all required deps are installed, YouTube clipping will work without “Please go to Settings…” error.
      </p>
    </Card>
  );
}

function LocalModelsCard() {
  const [data, setData] = useState<{ variants: VariantInfo[]; selected: string; whisper: { model: string; installed: boolean; bytesOnDisk: number } | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [error, setError] = useState("");

  const refresh = async () => {
    const cf = (window as unknown as { clipzard?: { modelsList: () => Promise<unknown> } }).clipzard;
    if (!cf?.modelsList) return;
    try { setData((await cf.modelsList()) as unknown as typeof data); } catch {}
  };

  useEffect(() => {
    refresh();
    const cf = (window as unknown as { clipzard?: { onModelsProgress: (cb: (d: unknown) => void) => () => void } }).clipzard;
    if (!cf?.onModelsProgress) return;
    const off = cf.onModelsProgress((d) => {
      const { variant, progress: p, done } = d as { variant: string; progress: number; done?: boolean };
      setProgress((prev) => ({ ...prev, [variant]: p }));
      if (done) { setBusy(null); refresh(); }
    });
    return off;
  }, []);

  const handleSelect = async (v: string) => {
    const cf = (window as unknown as { clipzard?: { modelsSetVariant: (x: string) => Promise<unknown> } }).clipzard;
    if (!cf?.modelsSetVariant) return;
    setError("");
    try { await cf.modelsSetVariant(v); await refresh(); } catch (e) { setError(String((e as Error).message)); }
  };

  const handleDownload = async (v: string) => {
    const cf = (window as unknown as { clipzard?: { modelsEnsure: (x: string) => Promise<unknown> } }).clipzard;
    if (!cf?.modelsEnsure) return;
    setBusy(v); setError(""); setProgress((p) => ({ ...p, [v]: 0 }));
    try { await cf.modelsEnsure(v); } catch (e) { setError(String((e as Error).message)); setBusy(null); }
  };

  const handleRemove = async (v: string) => {
    if (!confirm(`Remove ${v} model? You can re-download later.`)) return;
    const cf = (window as unknown as { clipzard?: { modelsRemove: (x: string) => Promise<unknown> } }).clipzard;
    if (!cf?.modelsRemove) return;
    setBusy(v); setError("");
    try { await cf.modelsRemove(v); await refresh(); } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(null); }
  };

  if (!data) {
    // Fallback when not in Electron (dev web) — show static info
    const isElectron = !!(window as unknown as { clipzard?: unknown }).clipzard;
    if (!isElectron) return null;
    return <Card className="p-5"><p className="text-xs text-ink-tertiary">Loading local models…</p></Card>;
  }

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-sm font-medium text-ink">
        <HardDrive size={16} className="text-accent" />
        Local AI Models
      </div>
      <p className="mt-1 text-xs text-ink-tertiary">
        Pick the clip analyzer size. Smaller = faster download, weaker hooks. Current: <span className="font-medium text-ink-secondary">{data.selected}</span>
        {data.whisper && <> · Whisper <span className="font-mono">{data.whisper.model}</span> {data.whisper.installed ? `(${fmtBytes(data.whisper.bytesOnDisk)})` : "(will download on first transcribe)"}</>}
      </p>
      {error && <p className="mt-2 flex items-center gap-1.5 text-xs text-danger"><Warning size={13} weight="fill" />{error}</p>}
      <div className="mt-3 flex flex-col gap-2">
        {data.variants.map((v) => {
          const isSelected = data.selected === v.key;
          const isBusy = busy === v.key;
          const pct = progress[v.key] ?? 0;
          return (
            <div key={v.key} className={`flex flex-col gap-2 rounded-lg border px-3 py-2.5 ${isSelected ? "border-accent/40 bg-accent-soft" : "border-line bg-surface-2"}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
                    {isSelected && <Check size={14} weight="bold" className="text-accent" />}
                    {v.label}
                    <span className="text-xs font-normal text-ink-tertiary">· {v.sizeMb} MB</span>
                    {v.installed && <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600">installed · {fmtBytes(v.bytesOnDisk)}</span>}
                  </p>
                  <p className="text-xs text-ink-tertiary">{v.description}</p>
                  <p className="text-[11px] text-ink-muted font-mono truncate">{v.file}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {!isSelected && (
                    <Button size="sm" variant="secondary" disabled={isBusy} onClick={() => handleSelect(v.key)}>
                      Use
                    </Button>
                  )}
                  {v.installed ? (
                    <Button size="sm" variant="ghost" disabled={isBusy} onClick={() => handleRemove(v.key)}>
                      <Trash size={13} /> Remove
                    </Button>
                  ) : (
                    <Button size="sm" variant={isSelected ? "primary" : "secondary"} disabled={isBusy} onClick={() => handleDownload(v.key)}>
                      <DownloadSimple size={13} /> {isBusy ? `${Math.round(pct * 100)}%` : "Download"}
                    </Button>
                  )}
                </div>
              </div>
              {isBusy && pct > 0 && pct < 1 && (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full bg-accent transition-[width]" style={{ width: `${pct * 100}%` }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-ink-muted">
        Analyser runs locally via <span className="font-mono">node-llama-cpp</span>. If <span className="font-mono">LLM_API_KEY</span> is set, cloud is used instead (0 MB). Models live at <span className="font-mono">userData/models/llm/</span>.
      </p>
    </Card>
  );
}
