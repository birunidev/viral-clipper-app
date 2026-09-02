import { contextBridge, ipcRenderer } from "electron";

console.log("[preload] loading, contextBridge available:", typeof contextBridge !== "undefined");
try {
  contextBridge.exposeInMainWorld("clipzard", {
  fastapiUrl: null as string | null,
  getFastApiUrl: () => ipcRenderer.invoke("fastapi:getUrl"),
  authLogin: (email: string, password: string) => ipcRenderer.invoke("auth:login", { email, password }),
  authLogout: () => ipcRenderer.invoke("auth:logout"),
  authMe: () => ipcRenderer.invoke("auth:me"),
  authForgotPassword: (email: string) => ipcRenderer.invoke("auth:forgot-password", { email }),
  entitlementCheck: () => ipcRenderer.invoke("entitlement:check"),
  entitlementStatus: () => ipcRenderer.invoke("entitlement:status"),
  entitlementSignOut: () => ipcRenderer.invoke("entitlement:sign-out"),
  systemInfo: () => ipcRenderer.invoke("system:info"),
  projectsList: () => ipcRenderer.invoke("projects:list"),
  projectGet: (id: string) => ipcRenderer.invoke("projects:get", id),
  projectCreate: (data: unknown) => ipcRenderer.invoke("projects:create", data),
  projectDelete: (id: string) => ipcRenderer.invoke("projects:delete", id),
  projectsTrash: () => ipcRenderer.invoke("projects:trash"),
  projectRestore: (id: string) => ipcRenderer.invoke("projects:restore", id),
  projectPurge: (id: string) => ipcRenderer.invoke("projects:purge", id),
   jobStart: (projectId: string, opts?: unknown) => ipcRenderer.invoke("jobs:start", { projectId, opts }),
   jobRender: (projectId: string, clipId: string, opts?: unknown) => ipcRenderer.invoke("jobs:render", { projectId, clipId, opts }),
   jobCancel: (jobId: string) => ipcRenderer.invoke("jobs:cancel", jobId),
   jobGet: (id: string) => ipcRenderer.invoke("jobs:get", id),
   clipsList: (projectId: string) => ipcRenderer.invoke("clips:list", projectId),
   clipDeleteRendered: (projectId: string, clipId: string) => ipcRenderer.invoke("clips:deleteRendered", { projectId, clipId }),
  captionStylesList: () => ipcRenderer.invoke("caption-styles:list"),
  captionStyleCreate: (data: unknown) => ipcRenderer.invoke("caption-styles:create", data),
   dialogOpenVideo: () => ipcRenderer.invoke("dialog:openVideo"),
   dialogSaveVideo: (sourcePath: string, defaultName?: string) => ipcRenderer.invoke("dialog:saveVideo", { sourcePath, defaultName }),
   shellShowItemInFolder: (p: string) => ipcRenderer.invoke("shell:showItemInFolder", p),
   shellOpenPath: (p: string) => ipcRenderer.invoke("shell:openPath", p),
   shellOpenExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
   modelsList: () => ipcRenderer.invoke("models:list"),
   modelsSetVariant: (v: string) => ipcRenderer.invoke("models:setVariant", v),
   modelsEnsure: (v: string) => ipcRenderer.invoke("models:ensure", v),
   modelsRemove: (v: string) => ipcRenderer.invoke("models:remove", v),
   onModelsProgress: (cb: (data: unknown) => void) => {
     const handler = (_: unknown, data: unknown) => cb(data);
     ipcRenderer.on("models:progress", handler);
     return () => ipcRenderer.removeListener("models:progress", handler);
   },
   depsStatus: () => ipcRenderer.invoke("deps:status"),
   depsEnsureAll: () => ipcRenderer.invoke("deps:ensureAll"),
   depsEnsure: (key: string) => ipcRenderer.invoke("deps:ensure", key),
    onDepsProgress: (cb: (data: unknown) => void) => {
      const handler = (_: unknown, data: unknown) => cb(data);
      ipcRenderer.on("deps:progress", handler);
      return () => ipcRenderer.removeListener("deps:progress", handler);
    },
    onboardingSkip: () => ipcRenderer.invoke("onboarding:skip"),
    onboardingComplete: () => ipcRenderer.invoke("onboarding:complete"),
    onNavigate: (cb: (path: string) => void) => {
      const handler = (_: unknown, path: string) => cb(path);
      ipcRenderer.on("navigate", handler as never);
      return () => ipcRenderer.removeListener("navigate", handler as never);
    },
      onJobProgress: (cb: (data: unknown) => void) => {
      const handler = (_: unknown, data: unknown) => cb(data);
      ipcRenderer.on("job:progress", handler);
      return () => ipcRenderer.removeListener("job:progress", handler);
    },
      getJobLogs: (jobId: string) => ipcRenderer.invoke("jobs:logs", jobId),
      clearJobLogs: (jobId: string) => ipcRenderer.invoke("jobs:clearLogs", jobId),
      onJobLog: (cb: (data: unknown) => void) => {
      const handler = (_: unknown, data: unknown) => cb(data);
      ipcRenderer.on("job:log", handler);
      return () => ipcRenderer.removeListener("job:log", handler);
    },
    updatesCheck: () => ipcRenderer.invoke("updates:check"),
    updatesInstall: () => ipcRenderer.invoke("updates:install"),
    updatesSetChannel: (ch: "stable" | "beta") => ipcRenderer.invoke("updates:channel", ch),
    onUpdateStatus: (cb: (data: unknown) => void) => {
      const handler = (_: unknown, data: unknown) => cb(data);
      ipcRenderer.on("update:status", handler);
      return () => ipcRenderer.removeListener("update:status", handler);
    },
    editPlanGet: (projectId: string) => ipcRenderer.invoke("edit-plan:get", projectId),
    editPlanSave: (projectId: string, plan: unknown) => ipcRenderer.invoke("edit-plan:save", projectId, plan),
  });
  console.log("[preload] exposed clipzard");
} catch (e) {
  console.error("[preload] expose failed", e);
}

declare global {
  interface Window {
    clipzard: {
      authLogin: (email: string, password: string) => Promise<{ ok: boolean; reason?: string; message?: string; user?: unknown }>;
      authLogout: () => Promise<{ ok: boolean }>;
      authMe: () => Promise<unknown>;
      authForgotPassword: (email: string) => Promise<{ ok: boolean; message?: string }>;
      entitlementCheck: () => Promise<unknown>;
      entitlementStatus: () => Promise<unknown>;
      entitlementSignOut: () => Promise<{ ok: boolean }>;
      systemInfo: () => Promise<unknown>;
      projectsList: () => Promise<unknown>;
      projectGet: (id: string) => Promise<unknown>;
      projectCreate: (d: unknown) => Promise<unknown>;
      projectDelete: (id: string) => Promise<unknown>;
      jobStart: (p: string, o?: unknown) => Promise<unknown>;
      jobRender: (p: string, c: string, o?: unknown) => Promise<unknown>;
      jobCancel: (id: string) => Promise<unknown>;
      jobGet: (id: string) => Promise<unknown>;
      clipsList: (p: string) => Promise<unknown>;
      onJobProgress: (cb: (d: unknown) => void) => () => void;
      getJobLogs: (jobId: string) => Promise<unknown>;
      clearJobLogs: (jobId: string) => Promise<unknown>;
      onJobLog: (cb: (d: unknown) => void) => () => void;
      updatesCheck: () => Promise<{ ok: boolean; version?: string | null; error?: string }>;
      updatesInstall: () => Promise<void>;
      updatesSetChannel: (ch: "stable" | "beta") => Promise<{ ok: boolean; version?: string | null; error?: string }>;
      onUpdateStatus: (cb: (d: unknown) => void) => () => void;
    };
  }
}
