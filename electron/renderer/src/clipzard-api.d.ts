export {};

declare global {
  interface ClipzardApi {
    authLogin: (email: string, password: string) => Promise<{
      ok: boolean;
      reason?: string;
      message?: string;
      user?: unknown;
    }>;
    authLogout: () => Promise<{ ok: boolean }>;
    authMe: () => Promise<unknown>;
    authForgotPassword: (email: string) => Promise<{ ok: boolean; message?: string }>;
    entitlementCheck: () => Promise<unknown>;
    entitlementStatus: () => Promise<{
      ok: boolean;
      reason?: string;
      message?: string;
      max_devices?: number;
      current_device_count?: number;
      payload?: {
        entitled: boolean;
        tier: string;
        max_devices: number;
        current_device_count: number;
        expires_at: string | null;
        credits: number;
        cloud_enabled: boolean;
        server_time: string;
        cache_max_age_days: number;
      };
      cached?: boolean;
      age_days?: number;
    }>;
    entitlementSignOut: () => Promise<{ ok: boolean }>;
    systemInfo: () => Promise<{ tier: string; whisperModel: string; llmModel: string; entitled: boolean; fastApiUrl: string | null; selectedVariant: string; whisper: unknown }>;
    getFastApiUrl: () => Promise<string | null>;
    projectsList: () => Promise<unknown[]>;
    projectGet: (id: string) => Promise<unknown>;
    projectCreate: (d: unknown) => Promise<unknown>;
    projectDelete: (id: string) => Promise<unknown>;
    projectsTrash: () => Promise<unknown[]>;
    projectRestore: (id: string) => Promise<unknown>;
    projectPurge: (id: string) => Promise<unknown>;
    jobStart: (projectId: string, opts?: unknown) => Promise<unknown>;
    jobRender: (projectId: string, clipId: string, opts?: unknown) => Promise<unknown>;
    jobCancel: (id: string) => Promise<unknown>;
    jobGet: (id: string) => Promise<unknown>;
    clipsList: (projectId: string) => Promise<unknown[]>;
    clipDeleteRendered: (projectId: string, clipId: string) => Promise<unknown>;
    captionStylesList: () => Promise<unknown[]>;
    captionStyleCreate: (data: unknown) => Promise<unknown>;
    dialogOpenVideo: () => Promise<unknown>;
    dialogSaveVideo: (sourcePath: string, defaultName?: string) => Promise<unknown>;
    shellShowItemInFolder: (p: string) => Promise<void>;
    shellOpenPath: (p: string) => Promise<void>;
    shellOpenExternal: (url: string) => Promise<void>;
    modelsList: () => Promise<unknown>;
    modelsSetVariant: (v: string) => Promise<unknown>;
    modelsEnsure: (v: string) => Promise<unknown>;
    modelsRemove: (v: string) => Promise<unknown>;
    onModelsProgress: (cb: (data: unknown) => void) => () => void;
    depsStatus: () => Promise<unknown>;
    depsEnsureAll: () => Promise<unknown>;
    depsEnsure: (key: string) => Promise<unknown>;
    onDepsProgress: (cb: (data: unknown) => void) => () => void;
    onboardingSkip: () => Promise<unknown>;
    onboardingComplete: () => Promise<unknown>;
    onJobProgress: (cb: (data: unknown) => void) => () => void;
    getJobLogs: (jobId: string) => Promise<unknown>;
    clearJobLogs: (jobId: string) => Promise<unknown>;
    onJobLog: (cb: (data: unknown) => void) => () => void;
    updatesCheck: () => Promise<{ ok: boolean; version?: string | null; error?: string }>;
    updatesInstall: () => Promise<void>;
    updatesSetChannel: (ch: "stable" | "beta") => Promise<{ ok: boolean; version?: string | null; error?: string }>;
    onUpdateStatus: (cb: (data: unknown) => void) => () => void;
  }

  interface Window {
    clipzard?: ClipzardApi;
  }
}
