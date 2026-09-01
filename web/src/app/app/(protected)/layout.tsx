"use client";

import { CreditCard, DownloadSimple, Key, List, Shield, SignOut, UserCircle, X } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useLogout, useSession } from "@/hooks/use-auth";
import { useAdminStatus } from "@/hooks/use-admin-updates";

function Logo() {
  return (
    <Link href="/app/profile" className="flex items-center gap-2.5">
      <img src="/logo-with-text.png" alt="ClipZard" className="h-8 w-auto object-contain" />
    </Link>
  );
}

const NAV = [
  { href: "/app/profile", label: "Profile", icon: UserCircle },
  { href: "/app/licenses", label: "Licenses", icon: Key },
  { href: "/app/billing", label: "Billing", icon: CreditCard },
];
const DOWNLOAD_NAV = { href: "/download", label: "Download app", icon: DownloadSimple };
const ADMIN_NAV = { href: "/admin/updates", label: "Admin", icon: Shield };

export default function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: user, isLoading, isError } = useSession();
  const logout = useLogout();
  const admin = useAdminStatus();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (!isLoading && !isError && !user) router.replace("/app/login");
    if (!isLoading && user && !user.terms_accepted_at)
      router.replace("/app/accept-terms");
  }, [isLoading, isError, user, router]);

  // Close drawer on route change
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Lock body scroll when drawer is open
  useEffect(() => {
    if (drawerOpen) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [drawerOpen]);

  if (isLoading || !user) return null;

  const licenseLabel = user.has_license
    ? `${user.license_tier ?? "licensed"} · ${user.credits.toLocaleString("en-US")} credits`
    : "No license";

  // Shared nav content for desktop sidebar and mobile drawer
  const NavContent = () => (
    <>
      <nav className="flex flex-1 flex-col gap-1 px-3">
        {NAV.map((item) => {
          const active = pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setDrawerOpen(false)}
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
        {admin.data?.is_admin && (
          <Link
            href={ADMIN_NAV.href}
            onClick={() => setDrawerOpen(false)}
            className="mt-2 flex items-center gap-2.5 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/20"
          >
            <ADMIN_NAV.icon size={16} weight="fill" />
            {ADMIN_NAV.label}
          </Link>
        )}
        <Link
          href={DOWNLOAD_NAV.href}
          onClick={() => setDrawerOpen(false)}
          className="mt-2 flex items-center gap-2.5 rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-sm font-medium text-ink-secondary transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <DOWNLOAD_NAV.icon size={16} weight="fill" />
          {DOWNLOAD_NAV.label}
        </Link>
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
        <Link
          href="/app/licenses"
          onClick={() => setDrawerOpen(false)}
          className="mx-3 mb-1 flex items-center gap-2 rounded-lg border border-line bg-surface-2/60 px-3 py-1.5 text-xs text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              user.has_license ? "bg-success" : "bg-accent"
            }`}
          />
          <span className="font-medium capitalize">{licenseLabel}</span>
        </Link>
        <button
          onClick={() => {
            setDrawerOpen(false);
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
    </>
  );

  return (
    <div className="flex min-h-dvh flex-1">
      {/* Mobile drawer overlay */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-canvas/60 backdrop-blur-sm"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute left-0 top-0 flex h-dvh w-72 max-w-[85vw] flex-col border-r border-line bg-surface-1 shadow-2xl"
          >
            <div className="flex items-center justify-between px-4 py-4">
              <Logo />
              <button
                onClick={() => setDrawerOpen(false)}
                aria-label="Close menu"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-tertiary hover:bg-surface-2 hover:text-ink"
              >
                <X size={18} />
              </button>
            </div>
            <NavContent />
          </div>
        </div>
      )}

      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface-1 md:flex">
        <div className="px-4 py-5">
          <Logo />
        </div>
        <NavContent />
      </aside>

      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-line px-4 py-3 md:hidden">
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-tertiary hover:bg-surface-2 hover:text-ink"
          >
            <List size={20} />
          </button>
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
