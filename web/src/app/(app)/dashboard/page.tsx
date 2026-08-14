"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type Project = {
  id: string;
  title: string;
  source: string;
  sourceType: string;
  status: string;
  createdAt: string;
  _count: { clips: number };
  jobs: { status: string; progress: number }[];
};

type ApiError = { error?: string };

async function createProject(body: unknown): Promise<Response> {
  return fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export default function DashboardPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [title, setTitle] = useState("");
  const [sourceType, setSourceType] = useState<"youtube" | "upload">("youtube");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then(setProjects);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (sourceType === "youtube") {
      if (!url.trim()) {
        setError("Enter a YouTube URL.");
        return;
      }
      const res = await createProject({
        title,
        source: url.trim(),
        sourceType: "youtube",
      });
      if (!res.ok) {
        setError(((await res.json()) as ApiError).error ?? "Failed to create project.");
        return;
      }
      const project = (await res.json()) as Project;
      router.push(`/projects/${project.id}`);
      return;
    }

    if (!file) {
      setError("Choose a video file.");
      return;
    }
    setUploading(true);
    try {
      const put = await fetch("/api/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, contentType: file.type }),
      });
      if (!put.ok) throw new Error("Failed to get upload URL");
      const { url: putUrl, key } = (await put.json()) as { url: string; key: string };

      const uploadRes = await fetch(putUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!uploadRes.ok) throw new Error("Upload failed");

      const res = await createProject({ title, source: key, sourceType: "upload" });
      if (!res.ok) throw new Error("Failed to create project");
      const project = (await res.json()) as Project;
      router.push(`/projects/${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Projects</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Paste a YouTube URL or upload a video, then cut the best moments.
        </p>
      </div>

      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-6"
      >
        <label className="flex flex-col gap-1 text-sm">
          Title (optional)
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="My podcast episode"
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-zinc-400"
          />
        </label>

        <div className="flex gap-2">
          {(["youtube", "upload"] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setSourceType(type)}
              className={`rounded-lg px-4 py-2 text-sm ${
                sourceType === type
                  ? "bg-zinc-100 text-zinc-900"
                  : "border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              {type === "youtube" ? "YouTube URL" : "Upload file"}
            </button>
          ))}
        </div>

        {sourceType === "youtube" ? (
          <label className="flex flex-col gap-1 text-sm">
            YouTube URL
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-zinc-400"
            />
          </label>
        ) : (
          <label className="flex flex-col gap-1 text-sm">
            Video file
            <input
              type="file"
              accept="video/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
            />
          </label>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={uploading}
          className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
        >
          {uploading ? "Uploading..." : "Create project"}
        </button>
      </form>

      <div className="flex flex-col gap-3">
        {projects === null && <p className="text-sm text-zinc-500">Loading...</p>}
        {projects?.length === 0 && (
          <p className="text-sm text-zinc-500">No projects yet.</p>
        )}
        {projects?.map((p) => (
          <Link
            key={p.id}
            href={`/projects/${p.id}`}
            className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 px-5 py-4 hover:border-zinc-600"
          >
            <div>
              <p className="font-medium">{p.title}</p>
              <p className="mt-0.5 truncate text-xs text-zinc-500">{p.source}</p>
            </div>
            <div className="flex items-center gap-4 text-right">
              <span
                className={`rounded-full px-2.5 py-1 text-xs ${
                  p.status === "completed"
                    ? "bg-emerald-900 text-emerald-300"
                    : p.status === "failed"
                      ? "bg-red-900 text-red-300"
                      : "bg-zinc-800 text-zinc-300"
                }`}
              >
                {p.status}
              </span>
              <span className="text-xs text-zinc-400">
                {p._count.clips} clips
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
