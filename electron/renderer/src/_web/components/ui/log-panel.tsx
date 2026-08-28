"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, Terminal } from "@phosphor-icons/react";

export type LogLine = {
  id: string;
  ts: string;
  level: "info" | "warn" | "error";
  stage?: string | null;
  message: string;
};

function fmtTime(ts: string) {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return ts.slice(11, 19); }
}

export function LogPanel({ logs, isRunning }: { logs: LogLine[]; isRunning?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState<"all" | "error">("all");

  const filtered = filter === "error" ? logs.filter((l) => l.level === "error" || l.level === "warn") : logs;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [logs.length, filtered.length]);

  async function copyAll() {
    const text = filtered.map((l) => `[${fmtTime(l.ts)}] [${l.level}] ${l.stage ? `[${l.stage}] ` : ""}${l.message}`).join("\n");
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch {}
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs text-ink-tertiary">
          <Terminal size={13} className={isRunning ? "animate-pulse text-accent" : ""} />
          <span className="font-mono tabular-nums">{filtered.length} lines</span>
          {isRunning && <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setFilter((f) => (f === "all" ? "error" : "all"))} className={`rounded-md border px-2 py-1 text-xs font-medium transition-colors ${filter === "error" ? "border-warning/30 bg-warning-soft text-warning" : "border-line bg-surface-2 text-ink-tertiary hover:text-ink"}`}>{filter === "error" ? "Errors" : "All"}</button>
          <button onClick={copyAll} className="flex items-center gap-1 rounded-md border border-line bg-surface-2 px-2 py-1 text-xs text-ink-tertiary hover:text-ink">{copied ? "Copied" : <><Copy size={12} />Copy</>}</button>
        </div>
      </div>
      <div ref={ref} className="max-h-[320px] overflow-auto rounded-xl border border-line bg-[#0f0f10] p-3 font-mono text-[11px] leading-5">
        {filtered.length === 0 ? (
          <p className="text-ink-muted">{isRunning ? "Waiting for logs…" : "No logs yet — run the pipeline to see details."}</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.map((l) => (
              <div key={l.id} className="flex gap-2">
                <span className="shrink-0 text-ink-muted tabular-nums">{fmtTime(l.ts)}</span>
                <span className={`shrink-0 rounded px-1 py-0 text-[10px] font-bold uppercase leading-4 ${l.level === "error" ? "bg-danger-soft text-danger" : l.level === "warn" ? "bg-warning-soft text-warning" : "bg-surface-2 text-ink-tertiary"}`}>{l.level}</span>
                {l.stage && <span className="shrink-0 text-ink-tertiary">[{l.stage}]</span>}
                <span className={l.level === "error" ? "text-danger" : l.level === "warn" ? "text-warning" : "text-ink-secondary"} style={{ wordBreak: "break-word" }}>{l.message}</span>
              </div>
            ))}
            {isRunning && <span className="inline-flex h-3 w-2 animate-pulse bg-accent/60" />}
          </div>
        )}
      </div>
    </div>
  );
}
