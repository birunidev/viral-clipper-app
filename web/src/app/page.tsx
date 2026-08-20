import Link from "next/link";

// Server-rendered marketing page — no auth/DB access. Pure content plus
// links into the client-only app under /app/*.
export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-24 text-center">
      <div className="flex flex-col gap-4">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          ClipForge
        </h1>
        <p className="max-w-xl text-lg text-zinc-400">
          Find viral moments in long videos and cut short clips — 9:16, 16:9,
          or original.
        </p>
      </div>
      <div className="flex gap-3">
        <Link
          href="/app/register"
          className="rounded-lg bg-zinc-100 px-5 py-2.5 text-sm font-medium text-zinc-900 hover:bg-white"
        >
          Get started
        </Link>
        <Link
          href="/app/login"
          className="rounded-lg border border-zinc-700 px-5 py-2.5 text-sm font-medium text-zinc-100 hover:bg-zinc-800"
        >
          Sign in
        </Link>
      </div>
    </main>
  );
}
