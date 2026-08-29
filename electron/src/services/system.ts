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
  // Tier-aware whisper for better Indonesian word-by-word accuracy
  // low (8GB) -> small 488MB, mid (12GB) -> medium 1.5GB, high (20GB+) -> large-v3 3GB
  // User has 31GB (high) -> large-v3 gives best ID transcription
  if (t === "high") return "large-v3";
  if (t === "mid") return "medium";
  return "small";
}

// Size/quality trade-off for this task (JSON clip extraction from timestamped transcript):
// - 0.5B (~380 MB) : ultra-light, weak JSON, generic hooks — use only for tiny installer.
// - 1.5B (~950 MB) : balanced default — ok JSON but hooks can feel generic (see few-shot prompt fix).
// - 3B  (~2.0 GB)  : better hook naturalness, recommended for EN/ID if <2GB extra is ok.
// - 7B  (~4.7 GB)  : mid, noticeably more natural titles/hooks multilingual — best local quality/cost.
// - 14B (~8.5 GB)  : high, only for 20GB+ machines.
// For natural hooks: use LLM_TIER=7b or cloud OPENAI_API_KEY (gpt-4o-mini) — both significantly outperform 1.5B word processing.
function getStoredVariant(): string | null {
  try {
    const Store = require("electron-store") as unknown as { default: new (o: unknown)=> { get:(k:string, d?:unknown)=>unknown } };
    const Ctor = (Store.default ?? Store) as unknown as new (o: unknown)=> { get:(k:string,d?:unknown)=>unknown };
    const store = new Ctor({ name: "clipzard-config" });
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
  if (raw === "quality" || raw === "3b") {
    return { file: "qwen2.5-3b-q4_k_m.gguf", url: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf" };
  }
  if (raw === "7b" || raw === "mid") {
    return { file: "qwen2.5-7b-q4_k_m.gguf", url: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf" };
  }
  if (raw === "14b" || raw === "high") {
    return { file: "qwen2.5-14b-q4_k_m.gguf", url: "https://huggingface.co/bartowski/Qwen2.5-14B-Instruct-GGUF/resolve/main/Qwen2.5-14B-Instruct-Q4_K_M.gguf" };
  }
  // User requested 7b as default local while Qwen3-4B trains — 7b best quality/cost for EN/ID hooks, fits 5060 8GB via Q4_K_M
  // Set LLM_TIER=balanced to force 1.5b if installer budget needed
  return { file: "qwen2.5-7b-q4_k_m.gguf", url: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf" };
}

// Explicit helpers for UI selector (no RAM check)
export function llmModelForVariant(v: "tiny" | "balanced" | "quality"): { file: string; url: string; sizeMb: number } {
  if (v === "tiny") return { file: "qwen2.5-0.5b-q4_k_m.gguf", url: "https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf", sizeMb: 380 };
  if (v === "balanced") return { file: "qwen2.5-1.5b-q4_k_m.gguf", url: "https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf", sizeMb: 950 };
  // quality now points to 7B — significantly more natural hooks (EN/ID) vs old 3B, worth the 4.7GB for users who opt in
  return { file: "qwen2.5-7b-q4_k_m.gguf", url: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf", sizeMb: 4700 };
}

export function threadCount(): number {
  return Math.max(2, os.cpus().length - 1);
}
