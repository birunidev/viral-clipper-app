"use client";

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, DownloadSimple, Warning, XCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function OnboardingPage() {
  const nav = useNavigate();
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
    setLogs((prev) => [...prev, "Starting dependency setup (same as Settings)..."]);
    try { await cf.depsEnsureAll(); await refresh(); setLogs((prev) => [...prev, "All dependencies ready"]); } catch (e) { setLogs((prev) => [...prev, `Failed: ${String((e as Error).message)}`]); }
    finally { setBusy(false); }
  };

  const handleSkip = async () => {
    const cf = (window as unknown as { clipzard?: { onboardingSkip: () => Promise<unknown> } }).clipzard;
    if (cf?.onboardingSkip) await cf.onboardingSkip();
    nav("/login", { replace: true });
  };

  const handleComplete = async () => {
    const cf = (window as unknown as { clipzard?: { onboardingComplete: () => Promise<unknown> } }).clipzard;
    if (cf?.onboardingComplete) await cf.onboardingComplete();
    nav("/login", { replace: true });
  };

  if (!deps) return <div className="flex min-h-dvh items-center justify-center p-8 text-sm text-ink-tertiary">Checking dependencies…</div>;

  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Welcome to ClipZard</h1>
        <p className="mt-1 text-sm text-ink-tertiary">
          Downloading LLM, Whisper, FFmpeg and all deps — like CapCut. Logs shown below. You can skip if stuck, then finish in Settings.
        </p>
      </div>

      <Card className="p-5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-ink">
            Dependency Setup {deps.allReady ? <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-600">Ready</span> : <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600">Incomplete</span>}
          </p>
          <Button size="sm" variant={deps.allReady ? "secondary" : "primary"} disabled={busy} onClick={handleEnsureAll} loading={busy}>
            <DownloadSimple size={13} /> {deps.allReady ? "Re-check" : "Download All"}
          </Button>
        </div>
        <div className="mt-3 flex flex-col gap-1.5">
          {deps.deps.map((d) => (
            <div key={d.key} className={`flex items-center justify-between rounded-lg border px-3 py-2 text-xs ${d.installed ? "border-emerald-500/20 bg-emerald-500/5" : "border-amber-500/20 bg-amber-500/5"}`}>
              <div className="min-w-0">
                <p className="font-medium text-ink truncate">{d.label} {d.installed ? <Check size={12} className="inline text-emerald-600" weight="bold" /> : <Warning size={12} className="inline text-amber-600" weight="fill" />}</p>
                <p className="text-[11px] text-ink-tertiary truncate">{d.description}</p>
                {progress[d.key] != null && progress[d.key] < 1 && <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-2"><div className="h-full bg-accent" style={{ width: `${progress[d.key] * 100}%` }} /></div>}
              </div>
              <span className="ml-2 shrink-0 font-mono text-[10px] text-ink-muted truncate max-w-[150px]">{d.path ?? ""}</span>
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
      </Card>

      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={handleSkip} disabled={busy}>
          <XCircle size={14} /> Skip onboarding
        </Button>
        <Button variant="primary" onClick={handleComplete} disabled={!deps.allReady && busy}>
          <Check size={14} weight="bold" /> Continue
        </Button>
      </div>
      <p className="text-center text-[11px] text-ink-muted">
        Skipped? After license, go to Settings → Dependency Setup to finish. YouTube clipping will be blocked until all required deps are installed (“Please go to Settings…”).
      </p>
    </div>
  );
}
