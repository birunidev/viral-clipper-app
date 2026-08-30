"use client";

import Link from "next/link";
import { useState } from "react";
import { useRequestPasswordReset } from "@/hooks/use-licenses";

export default function ForgotPasswordPage() {
  const reset = useRequestPasswordReset();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    reset.mutate(email, { onSuccess: () => setSent(true) });
  }

  if (sent) {
    return (
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Check your inbox</h1>
        <p className="mt-2 text-sm text-ink-tertiary">
          If <span className="font-medium text-ink">{email}</span> is associated with an
          account, a reset link is on its way. It expires in 1 hour.
        </p>
        <Link
          href="/app/login"
          className="mt-4 inline-block text-sm font-medium text-ink underline underline-offset-4"
        >
          Back to sign in →
        </Link>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <h1 className="text-xl font-semibold tracking-tight text-ink">Forgot your password?</h1>
      <p className="mt-1 text-sm text-ink-tertiary">
        Enter your email and we&apos;ll send you a one-time link to set a new password.
      </p>
      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-ink-secondary">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-10 rounded-lg border border-line bg-surface-2 px-3 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-accent/50"
            placeholder="you@example.com"
          />
        </label>
        <button
          type="submit"
          disabled={reset.isPending}
          className="inline-flex h-10 items-center justify-center rounded-lg bg-accent text-sm font-medium text-accent-ink transition-[transform,background-color] duration-150 ease-out hover:bg-accent-strong active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {reset.isPending ? "Sending…" : "Send reset link"}
        </button>
      </form>
      <p className="mt-4 text-sm text-ink-tertiary">
        Remembered it?{" "}
        <Link href="/app/login" className="font-medium text-ink underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </div>
  );
}
