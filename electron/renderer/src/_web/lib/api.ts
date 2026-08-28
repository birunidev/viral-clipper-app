/**
 * Thin fetch wrapper for the ClipForge FastAPI backend.
 *
 * All requests go to `NEXT_PUBLIC_API_URL` (e.g. https://app.example.com/api/v1
 * in prod via Caddy, http://localhost:8000/api/v1 in dev) with credentials
 * included so the httpOnly session cookie is sent/received. There is no
 * server-side code in this app — every call happens from the browser.
 */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api/v1";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

function isDesktop(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { clipforge?: unknown }).clipforge;
}

function desktop(): Window["clipforge"] & { getFastApiUrl?: () => Promise<string | null>; fastapiUrl?: string | null } {
  return (window as unknown as { clipforge: Window["clipforge"] & { getFastApiUrl?: () => Promise<string | null>; fastapiUrl?: string | null } }).clipforge;
}

let cachedFastApiUrl: string | null | undefined = undefined;
async function getFastApiUrl(): Promise<string | null> {
  if (typeof cachedFastApiUrl === "string" && cachedFastApiUrl) return cachedFastApiUrl;
  try {
    const d = desktop() as unknown as { getFastApiUrl?: () => Promise<string | null> };
    if (d?.getFastApiUrl) {
      const url = await d.getFastApiUrl();
      if (url) {
        cachedFastApiUrl = url;
        return url;
      }
    }
  } catch {}
  return null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (isDesktop()) {
    const fastUrl = await getFastApiUrl().catch(() => null);
    if (fastUrl) {
      // FastAPI local mode - use HTTP to Python backend (outside Electron main)
      const url = `${fastUrl}${path}`;
      const res = await fetch(url, {
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
        ...init,
      });
      if (!res.ok) {
        let msg = res.statusText;
        try { const b = await res.json(); msg = b.detail ?? b.error ?? msg; } catch {}
        throw new ApiError(res.status, msg);
      }
      if (res.status === 204) return undefined as T;
      return res.json() as Promise<T>;
    }
    return desktopRequest<T>(path, init);
  }
  try {
    const res = await fetch(`${API_URL}${path}`, {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      ...init,
    });

    if (!res.ok) {
      let message = res.statusText;
      try {
        const body = await res.json();
        message = body.detail ?? body.error ?? message;
      } catch {
        // no JSON body
      }
      throw new ApiError(res.status, message);
    }

    if (res.status === 204) {
      return undefined as T;
    }
    return res.json() as Promise<T>;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    const isNetworkError = msg.includes("Failed to fetch") || msg.includes("ECONNREFUSED") || msg.includes("NetworkError") || err instanceof TypeError;
    if (isNetworkError) {
      if (path === "/auth/me") {
        return { id: "dev", email: "dev@local", name: "Dev", terms_accepted_at: new Date().toISOString() } as T;
      }
      if (path === "/billing/status") {
        return {
          tier: "unlimited",
          tier_name: "Unlimited",
          credits: 0,
          limits: { storage_cap_bytes: 1024*1024*1024*100, max_projects: null, max_resolution: 2160, watermark: false },
          usage: { storage_used_bytes: 0, projects: 0 },
          packs: [],
          topups: [],
          byok_enabled: false,
        } as T;
      }
      if (path === "/settings") {
        return { transcription_provider: "local", storage_used_bytes: 0, storage_cap_bytes: 1024*1024*1024*100, byok_enabled: false } as T;
      }
      if (path === "/projects" || path === "/projects/trash" || path.startsWith("/projects/") || path.startsWith("/caption-styles") || path.startsWith("/jobs/")) {
        if (path === "/projects" || path === "/projects/trash" || path === "/caption-styles") return [] as T;
        throw new ApiError(404, "Dev: backend not running");
      }
    }
    throw err;
  }
}

async function desktopRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  const d = desktop() as unknown as Record<string, (...a: unknown[])=>Promise<unknown>>;

  if (path === "/auth/me" && method === "GET") {
    const s = await (d.licenseStatus as () => Promise<{ licensed: boolean; license?: { license_key?: string } }>)();
    if (!s.licensed) throw new ApiError(401, "Not licensed");
    return { id: "desktop", email: "licensed@clipforge.local", name: "Licensed", terms_accepted_at: new Date().toISOString() } as T;
  }
  if ((path === "/auth/logout" || path === "/auth/register" || path === "/auth/login") && method === "POST") {
    return { id: "desktop", email: "licensed@clipforge.local", name: "Licensed", terms_accepted_at: new Date().toISOString() } as T;
  }
  if (path === "/auth/accept-terms" && method === "POST") {
    return { id: "desktop", email: "licensed@clipforge.local", name: "Licensed", terms_accepted_at: new Date().toISOString() } as T;
  }
  if (path === "/billing/status" && method === "GET") {
    const info = await (d.systemInfo as () => Promise<{ tier: string }>)().catch(() => ({ tier: "mid" }));
    return {
      tier: "unlimited",
      tier_name: "Unlimited",
      credits: 0,
      limits: { storage_cap_bytes: 1024*1024*1024*100, max_projects: null, max_resolution: 2160, watermark: false },
      usage: { storage_used_bytes: 0, projects: 0 },
      packs: [],
      topups: [],
      byok_enabled: false,
      system_tier: info.tier,
    } as T;
  }
  if (path === "/billing/transactions" && method === "GET") return [] as T;
  if (path === "/projects/trash" && method === "GET") return (await (d.projectsTrash as ()=>Promise<unknown>)()) as T;
  if (path === "/settings" && method === "GET") return { transcription_provider: "local", storage_used_bytes: 0, storage_cap_bytes: 1024*1024*1024*100, byok_enabled: false } as T;
  if (path === "/settings" && method === "PUT") return { transcription_provider: "local", storage_used_bytes: 0, storage_cap_bytes: 1024*1024*1024*100 } as T;

  if (path === "/billing/checkout" && method === "POST") {
    await (d.shellOpenExternal as (u:string)=>Promise<void>)("https://clipforge.com/account");
    return { provider: "paddle", url: "https://clipforge.com/account" } as T;
  }
  if (path === "/projects" && method === "GET") return (await (d.projectsList as ()=>Promise<unknown>)()) as T;
  if (path === "/projects" && method === "POST") return (await (d.projectCreate as (b:unknown)=>Promise<unknown>)(body)) as T;
  if (path === "/caption-styles" && method === "GET") return (await (d.captionStylesList as ()=>Promise<unknown>)()) as T;
  if (path === "/caption-styles" && method === "POST") return (await (d.captionStyleCreate as (b:unknown)=>Promise<unknown>)(body)) as T;
  const projectMatch = path.match(/^\/projects\/([^/]+)$/);
  if (projectMatch) {
    if (method === "GET") return (await (d.projectGet as (id:string)=>Promise<unknown>)(projectMatch[1])) as T;
    if (method === "DELETE") return (await (d.projectDelete as (id:string)=>Promise<unknown>)(projectMatch[1])) as T;
  }
  const startMatch = path.match(/^\/projects\/([^/]+)\/start$/);
  if (startMatch && method === "POST") return (await (d.jobStart as (a:string,b:unknown)=>Promise<unknown>)(startMatch[1], body)) as T;
  const renderMatch = path.match(/^\/projects\/([^/]+)\/clips\/([^/]+)\/render$/);
  if (renderMatch && method === "POST") return (await (d.jobRender as (a:string,b:string,c:unknown)=>Promise<unknown>)(renderMatch[1], renderMatch[2], body)) as T;
  const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
  if (jobMatch && method === "GET") return (await (d.jobGet as (id:string)=>Promise<unknown>)(jobMatch[1])) as T;
  const restoreMatch = path.match(/^\/projects\/([^/]+)\/restore$/);
  if (restoreMatch && method === "POST") return (await (d.projectRestore as (id:string)=>Promise<unknown>)(restoreMatch[1])) as T;
  const purgeMatch = path.match(/^\/projects\/([^/]+)\/purge$/);
  if (purgeMatch && method === "DELETE") return (await (d.projectPurge as (id:string)=>Promise<unknown>)(purgeMatch[1])) as T;
  if (path.startsWith("/uploads/presign") && method === "POST") throw new ApiError(400, "Upload via local file picker — use Choose file in dashboard (local)");

  throw new ApiError(404, `Desktop IPC: no handler for ${method} ${path}`);
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
