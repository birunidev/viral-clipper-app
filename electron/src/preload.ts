import { contextBridge, ipcRenderer } from "electron";

console.log("[preload] loading, contextBridge available:", typeof contextBridge !== "undefined");
try {
  contextBridge.exposeInMainWorld("clipforge", {
  fastapiUrl: null as string | null,
  getFastApiUrl: () => ipcRenderer.invoke("fastapi:getUrl"),
  licenseVerify: (key: string, email?: string) => ipcRenderer.invoke("license:verify", { key, email }),
  licenseStatus: () => ipcRenderer.invoke("license:status"),
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
  jobGet: (id: string) => ipcRenderer.invoke("jobs:get", id),
  clipsList: (projectId: string) => ipcRenderer.invoke("clips:list", projectId),
  captionStylesList: () => ipcRenderer.invoke("caption-styles:list"),
  captionStyleCreate: (data: unknown) => ipcRenderer.invoke("caption-styles:create", data),
  dialogOpenVideo: () => ipcRenderer.invoke("dialog:openVideo"),
  shellOpenExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
    onJobProgress: (cb: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown) => cb(data);
    ipcRenderer.on("job:progress", handler);
    return () => ipcRenderer.removeListener("job:progress", handler);
  },
  });
  console.log("[preload] exposed clipforge");
} catch (e) {
  console.error("[preload] expose failed", e);
}

declare global {
  interface Window {
    clipforge: {
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
  }
}
