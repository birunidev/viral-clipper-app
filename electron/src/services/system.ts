import os from "node:os";

export type Tier = "low" | "mid" | "high";
// Extra tiny tier for sub-1GB installer — selected via LLM_TIER env or auto on <8GB if you opt-in.
// Keep ramTier() on 3 buckets for compat; tiny is opt-in via LLM_TIER=tiny.

export function ramTier(): Tier {
  const gb = os.totalmem() / (1024 ** 3);
  if (gb >= 20) return "high";
  if (gb >= 12) return "mid";
  return "low";
}

export function whisperModelForTier(t: Tier): string {
  if (t === "high") return "medium";
  if (t === "mid") return "small";
  return "base";
}

// Size/quality trade-off for this task (JSON clip extraction from timestamped transcript):
// - 0.5B (~380 MB) : ultra-light, weak JSON, generic hooks — use only for tiny installer.
// - 1.5B (~950 MB) : BEST MB/quality — recommended default for <2 GB constraint. Beats old 3B per-MB.
// - 3B  (~2.0 GB)  : previous low, better but 2× download.
// - 7B  (~4.7 GB)  : mid, good quality.
// - 14B (~8.5 GB)  : high, only for 20GB+ machines.
// Default low is now 1.5B (was 3B) to meet <2GB installer budget.
function getStoredVariant(): string | null {
  try {
    const Store = require("electron-store") as unknown as { default: new (o: unknown)=> { get:(k:string, d?:unknown)=>unknown } };
    const Ctor = (Store.default ?? Store) as unknown as new (o: unknown)=> { get:(k:string,d?:unknown)=>unknown };
    const store = new Ctor({ name: "clipforge-config" });
    const v = String(store.get("llmVariant", "") ?? "");
    if (v) return v;
  } catch {}
  return null;
}

export function llmModelForTier(t: Tier): { file: string; url: string } {
  // Priority: env LLM_TIER > persisted llmVariant (Settings UI) > RAM tier
  const raw = (process.env.LLM_TIER ?? getStoredVariant() ?? "").toLowerCase();
  if (raw === "tiny" || raw === "nano" || raw === "0.5b") {
    return { file: "qwen2.5-0.5b-q4_k_m.gguf", url: "https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf" };
  }
  if (raw === "balanced" || raw === "1.5b") {
    return { file: "qwen2.5-1.5b-q4_k_m.gguf", url: "https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf" };
  }
  if (raw === "quality" || raw === "3b") {
    return { file: "qwen2.5-3b-q4_k_m.gguf", url: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf" };
  }
  if (t === "high") return { file: "qwen2.5-14b-q4_k_m.gguf", url: "https://huggingface.co/bartowski/Qwen2.5-14B-Instruct-GGUF/resolve/main/Qwen2.5-14B-Instruct-Q4_K_M.gguf" };
  if (t === "mid") return { file: "qwen2.5-7b-q4_k_m.gguf", url: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf" };
  // low — 1.5B is new sweet spot (950 MB) vs old 3B (2 GB)
  return { file: "qwen2.5-1.5b-q4_k_m.gguf", url: "https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf" };
}

// Explicit helpers for UI selector (no RAM check)
export function llmModelForVariant(v: "tiny" | "balanced" | "quality"): { file: string; url: string; sizeMb: number } {
  if (v === "tiny") return { file: "qwen2.5-0.5b-q4_k_m.gguf", url: "https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf", sizeMb: 380 };
  if (v === "balanced") return { file: "qwen2.5-1.5b-q4_k_m.gguf", url: "https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf", sizeMb: 950 };
  return { file: "qwen2.5-3b-q4_k_m.gguf", url: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf", sizeMb: 2000 };
}

export function threadCount(): number {
  return Math.max(2, os.cpus().length - 1);
}
