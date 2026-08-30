"use client";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/use-auth";
import { useRequestPasswordReset } from "@/hooks/use-licenses";
import Link from "next/link";
import { useState, type ReactNode } from "react";

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <div className="border-b border-line px-6 py-4">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-ink-tertiary">{subtitle}</p>}
      </div>
      <div className="px-6 py-5">{children}</div>
    </Card>
  );
}

export default function ProfilePage() {
  const { data: user, isLoading } = useSession();
  const resetMutation = useRequestPasswordReset();
  const [resetSent, setResetSent] = useState(false);

  if (isLoading || !user) return null;

  function onSendReset() {
    if (!user) return;
    resetMutation.mutate(user.email, {
      onSuccess: () => setResetSent(true),
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        <p className="mt-1 text-sm text-ink-tertiary">
          Your account info, license, and password.
        </p>
      </header>

      <Section
        title="Account"
        subtitle="The name and email attached to your ClipZard account."
      >
        <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-tertiary">Name</dt>
            <dd className="mt-1 text-sm font-medium text-ink">{user.name || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-tertiary">Email</dt>
            <dd className="mt-1 text-sm font-medium text-ink">{user.email}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs uppercase tracking-wide text-ink-tertiary">User ID</dt>
            <dd className="mt-1 break-all font-mono text-[11px] text-ink-tertiary">
              {user.id}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-ink-tertiary">Terms accepted</dt>
            <dd className="mt-1 text-sm text-ink">
              {user.terms_accepted_at
                ? new Date(user.terms_accepted_at).toLocaleDateString()
                : "Not yet"}
            </dd>
          </div>
        </dl>
      </Section>

      <Section
        title="License"
        subtitle="The permanent desktop license that authorises the ClipZard app to run on this account."
      >
        {user.has_license ? (
          <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-tertiary">Tier</dt>
              <dd className="mt-1 text-sm font-medium capitalize text-ink">
                {user.license_tier ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-tertiary">Devices</dt>
              <dd className="mt-1 text-sm text-ink">
                {user.current_device_count} of {user.max_devices || "—"} active
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-ink-tertiary">Credits</dt>
              <dd className="mt-1 text-sm text-ink">
                {user.credits.toLocaleString("en-US")} min
              </dd>
            </div>
            <div className="flex items-end">
              <Link
                href="/app/licenses"
                className="text-sm font-medium text-accent hover:underline"
              >
                Manage devices →
              </Link>
            </div>
          </dl>
        ) : (
          <div className="flex flex-col gap-2 text-sm text-ink-secondary">
            <p>You don&apos;t have a desktop license yet.</p>
            <Link
              href="/app/billing"
              className="text-sm font-medium text-accent hover:underline"
            >
              Buy a license →
            </Link>
          </div>
        )}
      </Section>

      <Section
        title="Password"
        subtitle="Reset your password by email. We never store the current password."
      >
        {resetSent ? (
          <p className="text-sm text-success">
            Reset link sent to {user.email}. Check your inbox.
          </p>
        ) : (
          <div className="flex items-center gap-3">
            <Button
              onClick={onSendReset}
              disabled={resetMutation.isPending}
              variant="secondary"
            >
              {resetMutation.isPending ? "Sending…" : "Send password reset link"}
            </Button>
            {resetMutation.isError && (
              <p className="text-sm text-danger">
                {resetMutation.error instanceof Error
                  ? resetMutation.error.message
                  : "Failed to send"}
              </p>
            )}
          </div>
        )}
      </Section>

      <p className="pt-2 text-xs text-ink-tertiary">
        Need to delete your account? Email{" "}
        <a href="mailto:support@clipzard.web.id" className="underline">
          support@clipzard.web.id
        </a>
        .
      </p>
    </div>
  );
}
