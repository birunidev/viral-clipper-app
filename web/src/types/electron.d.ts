export type ClipforgeAPI = {
  licenseVerify: (k: string, e?: string) => Promise<{ valid: boolean; message?: string }>;
  licenseStatus: () => Promise<unknown>;
  systemInfo: () => Promise<unknown>;
  projectsList: () => Promise<unknown>;
  projectGet: (id: string) => Promise<unknown>;
  projectCreate: (d: unknown) => Promise<unknown>;
  projectDelete: (id: string) => Promise<unknown>;
  jobStart: (p: string, o?: unknown) => Promise<unknown>;
  jobRender: (p: string, c: string, o?: unknown) => Promise<unknown>;
  jobGet: (id: string) => Promise<unknown>;
  clipsList: (p: string) => Promise<unknown>;
  onJobProgress: (cb: (d: unknown) => void) => () => void;
};

declare global {
  interface Window {
    clipzard?: ClipforgeAPI;
  }
}
