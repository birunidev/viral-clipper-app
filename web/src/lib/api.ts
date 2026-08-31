/**
 * Thin fetch wrapper for the ClipZard FastAPI backend.
 *
 * All requests go to `NEXT_PUBLIC_API_URL` (e.g. https://clipzard.web.id/api/v1
 * in prod via Caddy, http://localhost:8000/api/v1 in dev) with credentials
 * included so the httpOnly session cookie is sent/received. There is no
 * server-side code in this app — every call happens from the browser.
 */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://clipzard.web.id/api/v1";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

function isDesktop(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { clipzard?: unknown }).clipzard;
}

function desktop(): Window["clipzard"] {
  return (window as unknown as { clipzard: Window["clipzard"] }).clipzard;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (isDesktop()) {
    return desktopRequest<T>(path, init);
  }
  const hasBody = init?.body !== undefined && init?.body !== null;
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> ?? {}),
  };
  if (hasBody && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    headers,
    ...init,
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (Array.isArray(body.detail)) {
        message = body.detail.map((d: { msg?: string } | string) => typeof d === "string" ? d : (d.msg ?? JSON.stringify(d))).join("; ");
      } else {
        message = body.detail ?? body.error ?? body.message ?? message;
      }
      if (typeof message !== "string") message = JSON.stringify(message);
    } catch {
      // no JSON body
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

async function desktopRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  const d = desktop()!;

  if (path === "/projects" && method === "GET") return (await d.projectsList()) as T;
  if (path === "/projects" && method === "POST") return (await d.projectCreate(body)) as T;
  if (path === "/caption-styles" && method === "GET") {
    return [] as unknown as T;
  }
  const projectMatch = path.match(/^\/projects\/([^/]+)$/);
  if (projectMatch) {
    if (method === "GET") return (await d.projectGet(projectMatch[1])) as T;
    if (method === "DELETE") return (await d.projectDelete(projectMatch[1])) as T;
  }
  const startMatch = path.match(/^\/projects\/([^/]+)\/start$/);
  if (startMatch && method === "POST") return (await d.jobStart(startMatch[1], body)) as T;
  const renderMatch = path.match(/^\/projects\/([^/]+)\/clips\/([^/]+)\/render$/);
  if (renderMatch && method === "POST") return (await d.jobRender(renderMatch[1], renderMatch[2], body)) as T;
  const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
  if (jobMatch && method === "GET") return (await d.jobGet(jobMatch[1])) as T;

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

/**
 * Multipart upload helper for the updates admin UI. Uses the native
 * browser FormData (no body serialization), so the request layer above
 * is bypassed. Credentials are included to send the session cookie.
 */
export async function uploadForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    credentials: "include",
    body: form,
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
  return res.json() as Promise<T>;
}
