"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useLogout, useSession } from "@/hooks/use-auth";

// Client-side auth guard for the /app/* routes. The layout renders nothing
// until the session query resolves, and redirects to /app/login if the user
// is not authenticated.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { data: user, isLoading } = useSession();
  const logout = useLogout();

  useEffect(() => {
    if (!isLoading && !user) {
      router.replace("/app/login");
    }
  }, [isLoading, user, router]);

  if (isLoading || !user) {
    return null;
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-3">
        <Link href="/app/dashboard" className="font-semibold tracking-tight">
          ClipForge
        </Link>
        <div className="flex items-center gap-4">
          <span className="text-sm text-zinc-400">{user.email}</span>
          <button
            onClick={() => logout.mutate()}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="flex-1 px-6 py-6">{children}</main>
    </div>
  );
}
