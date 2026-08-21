"use client";

import { GearSix, SignOut, SquaresFour, VideoCamera } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useLogout, useSession } from "@/hooks/use-auth";

function Logo() {
  return (
    <Link href="/app/dashboard" className="flex items-center gap-2.5">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-accent-ink">
        <VideoCamera size={16} weight="fill" />
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-ink">ClipForge</span>
    </Link>
  );
}

const NAV = [
  { href: "/app/dashboard", label: "Projects", icon: SquaresFour },
  { href: "/app/settings", label: "Settings", icon: GearSix },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: user, isLoading } = useSession();
  const logout = useLogout();

  useEffect(() => {
    if (!isLoading && !user) router.replace("/app/login");
  }, [isLoading, user, router]);

  if (isLoading || !user) return null;

  return (
    <div className="flex min-h-dvh flex-1">
      {/* Sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface-1 md:flex">
        <div className="px-4 py-5">
          <Logo />
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3">
          {NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-surface-2 font-medium text-ink"
                    : "text-ink-tertiary hover:bg-surface-2 hover:text-ink"
                }`}
              >
                <Icon size={16} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex flex-col gap-1 border-t border-line px-3 py-4">
          <div className="flex items-center gap-2.5 px-3 py-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-ink">
              {(user.name?.[0] ?? user.email[0] ?? "U").toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-ink">{user.name || "Creator"}</p>
              <p className="truncate text-xs text-ink-muted">{user.email}</p>
            </div>
          </div>
          <button
            onClick={() => {
              logout.mutate(undefined, {
                onSuccess: () => router.replace("/app/login"),
              });
            }}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-tertiary transition-colors hover:bg-surface-2 hover:text-danger"
          >
            <SignOut size={16} />
            Sign out
          </button>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-line px-4 py-3 md:hidden">
          <Logo />
          <button
            onClick={() => {
              logout.mutate(undefined, {
                onSuccess: () => router.replace("/app/login"),
              });
            }}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-tertiary hover:bg-surface-2 hover:text-ink"
            aria-label="Sign out"
          >
            <SignOut size={18} />
          </button>
        </div>
        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
