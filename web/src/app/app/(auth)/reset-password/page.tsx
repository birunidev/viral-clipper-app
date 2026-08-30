"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useConfirmPasswordReset } from "@/hooks/use-licenses";

function ResetPasswordForm() {
  const router = useRouter();
  const search = useSearchParams();
  const token = search?.get("token") ?? "";
  const confirm = useConfirmPasswordReset();
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!token) {
      setError("Missing token — open the link from your email again.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== password2) {
      setError("Passwords don't match.");
      return;
    }
    confirm.mutate(
      { token, new_password: password },
      {
        onSuccess: () => {
          router.replace("/app/login?reset=1");
        },
        onError: (err) => setError(err.message),
      }
    );
  }

  if (!token) {
    return (
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          Reset link is missing the token
        </h1>
        <p className="mt-2 text-sm text-ink-tertiary">
          The link you opened is incomplete. Open the link from your email or request a
          new one.
        </p>
        <Link
          href="/app/forgot-password"
          className="mt-4 inline-block text-sm font-medium text-ink underline underline-offset-4"
        >
          Request a new reset link →
        </Link>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <h1 className="text-xl font-semibold tracking-tight text-ink">Set a new password</h1>
      <p className="mt-1 text-sm text-ink-tertiary">
        Choose a new password for your ClipZard account.
      </p>
      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-ink-secondary">New password</span>
          <input
            type="password"
            required
            autoComplete="new-password"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-10 rounded-lg border border-line bg-surface-2 px-3 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-accent/50"
            placeholder="••••••••"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-ink-secondary">Confirm new password</span>
          <input
            type="password"
            required
            autoComplete="new-password"
            minLength={8}
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
            className="h-10 rounded-lg border border-line bg-surface-2 px-3 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-accent/50"
            placeholder="••••••••"
          />
        </label>
        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={confirm.isPending}
          className="inline-flex h-10 items-center justify-center rounded-lg bg-accent text-sm font-medium text-accent-ink transition-[transform,background-color] duration-150 ease-out hover:bg-accent-strong active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {confirm.isPending ? "Saving…" : "Set new password"}
        </button>
      </form>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="text-sm text-ink-tertiary">Loading…</div>}>
      <ResetPasswordForm />
    </Suspense>
  );
}
