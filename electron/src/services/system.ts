import os from "node:os";

export type Tier = "low" | "mid" | "high";

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

export function llmModelForTier(t: Tier): { file: string; url: string } {
  if (t === "high") return { file: "qwen2.5-14b-q4_k_m.gguf", url: "https://huggingface.co/Qwen/Qwen2.5-14B-Instruct-GGUF/resolve/main/qwen2.5-14b-instruct-q4_k_m.gguf" };
  if (t === "mid") return { file: "qwen2.5-7b-q4_k_m.gguf", url: "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf" };
  return { file: "qwen2.5-3b-q4_k_m.gguf", url: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf" };
}

export function threadCount(): number {
  return Math.max(2, os.cpus().length - 1);
}
