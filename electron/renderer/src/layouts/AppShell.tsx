"use client";

import { CreditCard, GearSix, SignOut, SquaresFour, VideoCamera } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { useLogout, useSession } from "@/hooks/use-auth";
import { useBilling } from "@/hooks/use-billing";

function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2.5">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-accent-ink">
        <VideoCamera size={16} weight="fill" />
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-ink">SnapClip</span>
    </Link>
  );
}

const NAV = [
  { href: "/", label: "Projects", icon: SquaresFour },
  { href: "/billing", label: "Credits", icon: CreditCard },
  { href: "/settings", label: "Settings", icon: GearSix },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const pathname = useLocation().pathname;
  const { data: user, isLoading, isError } = useSession();
  const logout = useLogout();
  const billing = useBilling();

  useEffect(() => {
    if (!isLoading && !isError && !user) navigate("/login");
    if (!isLoading && user && !user.terms_accepted_at) navigate("/accept-terms");
  }, [isLoading, isError, user, navigate]);

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
                to={item.href}
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
          <Link
            to="/billing"
            className="mx-3 mb-1 flex items-center gap-2 rounded-lg border border-line bg-surface-2/60 px-3 py-1.5 text-xs text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${billing.data && billing.data.credits > 0 ? "bg-success" : "bg-accent"}`} />
            <span className="font-medium">{billing.data?.tier_name ?? "Free"}</span>
            {billing.data && <span className="text-ink-muted">·</span>}
            {billing.data && (
              <span className="text-ink-muted">{billing.data.credits.toLocaleString("en-US")} credits</span>
            )}
          </Link>
          <button
            onClick={() => {
              logout.mutate(undefined, {
                onSuccess: () => navigate("/login"),
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
                onSuccess: () => navigate("/login"),
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
