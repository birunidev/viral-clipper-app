export function isDesktop(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { clipzard?: unknown }).clipzard;
}

type Clipzard = Window["clipzard"];

function desktop(): Clipzard {
  return (window as unknown as { clipzard: Clipzard }).clipzard;
}

export function toMediaUrl(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  if (filePath.startsWith("http://") || filePath.startsWith("https://") || filePath.startsWith("media://")) return filePath as string;
  return `media://${filePath}`;
}
