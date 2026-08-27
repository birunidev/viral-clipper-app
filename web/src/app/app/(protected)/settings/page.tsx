"use client";

import { Check, Database, Warning, XCircle } from "@phosphor-icons/react";
import { useState } from "react";
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
          Manage your storage and workspace.
        </p>
      </div>

      {/* Cookie consent */}
      <Card className="p-5">
        <p className="text-sm font-medium text-ink">Cookies</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-tertiary">
          Necessary cookies keep you signed in. YouTube session cookies are optional — when enabled, your browser’s YouTube cookies are sent once per YouTube download to bypass bot checks and are never stored.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              try {
                localStorage.removeItem("snapclip_cookie_consent");
                localStorage.removeItem("snapclip_youtube_cookie_consent");
                document.cookie = "cookie_consent=; path=/; max-age=0";
                window.location.reload();
              } catch {}
            }}
            className="h-9 rounded-full border border-line bg-surface-2 px-4 text-sm font-medium text-ink hover:bg-surface-1"
          >
            Reset consent
          </button>
          <span className="text-xs text-ink-muted">
            Current: {(() => {
              try {
                const raw = localStorage.getItem("snapclip_cookie_consent");
                const c = raw ? JSON.parse(raw) : null;
                if (!c) return "not decided";
                return c.youtube ? "YouTube allowed" : c.analytics ? "Analytics only" : "Necessary only";
              } catch {
                return "not decided";
              }
            })()}
          </span>
        </div>
      </Card>

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
