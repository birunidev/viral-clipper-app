export const isDesktop = typeof window !== "undefined" && !!(window as unknown as { clipzard?: unknown }).clipzard;

type Clipforge = Window["clipzard"];

function desktop(): Clipforge {
  return (window as unknown as { clipzard: Clipforge }).clipzard;
}

export function toMediaUrl(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  if (filePath.startsWith("http://") || filePath.startsWith("https://") || filePath.startsWith("media://")) return filePath as string;
  return `media://${filePath}`;
}
