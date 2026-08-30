"use client";

import { ArrowSquareOut, GearSix, Shield, SignOut, SquaresFour } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useLogout, useSession } from "@/hooks/use-auth";
import { useAdminStatus } from "@/hooks/use-admin-updates";

const ADMIN_NAV = [
  { href: "/admin/updates", label: "App updates", icon: Shield },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: user, isLoading } = useSession();
  const logout = useLogout();
  const admin = useAdminStatus();

  useEffect(() => {
    if (!isLoading && !user) router.replace("/app/login");
  }, [isLoading, user, router]);

  useEffect(() => {
    // Once we know the admin state, bounce non-admins back to the app
    if (!admin.isLoading && user && admin.data && !admin.data.is_admin) {
      router.replace("/app/dashboard");
    }
  }, [admin.isLoading, admin.data, user, router]);

  if (isLoading || !user) return null;
  if (admin.isLoading || !admin.data) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-sm text-ink-tertiary">
        Checking admin access…
      </div>
    );
  }
  if (!admin.data.is_admin) return null;

  return (
    <div className="flex min-h-dvh flex-1">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface-1 md:flex">
        <div className="px-4 py-5">
          <Link href="/admin/updates" className="flex items-center gap-2.5">
            <img src="/logo-with-text.png" alt="ClipZard" className="h-8 w-auto object-contain" />
          </Link>
          <span className="mt-2 inline-flex items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
            <Shield size={11} weight="fill" />
            Admin
          </span>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3">
          {ADMIN_NAV.map((item) => {
            const active = pathname === item.href;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                  active ? "bg-surface-2 font-medium text-ink" : "text-ink-tertiary hover:bg-surface-2 hover:text-ink"
                }`}
              >
                <Icon size={16} />
                {item.label}
              </Link>
            );
          })}
          <Link
            href="/app/dashboard"
            className="mt-1 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-tertiary transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <ArrowSquareOut size={16} />
            Back to app
          </Link>
        </nav>
        <div className="flex flex-col gap-1 border-t border-line px-3 py-4">
          <div className="flex items-center gap-2.5 px-3 py-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-ink">
              {(user.name?.[0] ?? user.email[0] ?? "A").toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-ink">{user.name || "Admin"}</p>
              <p className="truncate text-xs text-ink-muted">{user.email}</p>
            </div>
          </div>
          <button
            onClick={() => {
              logout.mutate(undefined, { onSuccess: () => router.replace("/app/login") });
            }}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-tertiary transition-colors hover:bg-surface-2 hover:text-danger"
          >
            <SignOut size={16} />
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-line px-4 py-3 md:hidden">
          <Link href="/admin/updates" className="text-sm font-medium text-ink">
            ClipZard Admin
          </Link>
          <button
            onClick={() => router.replace("/app/dashboard")}
            className="text-xs text-ink-tertiary underline"
          >
            Back to app
          </button>
        </div>
        <main className="flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
