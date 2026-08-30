"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLogin } from "@/hooks/use-auth";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const login = useLogin();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    login.mutate(
      { email, password },
      {
        onSuccess: () => router.push("/app/profile"),
        onError: (err) => setError(err.message),
      }
    );
  }

  return (
    <div className="w-full max-w-sm">
      <h1 className="text-xl font-semibold tracking-tight text-ink">Sign in</h1>
      <p className="mt-1 text-sm text-ink-tertiary">Pick up where you left off.</p>
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
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-ink-secondary">Password</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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
          disabled={login.isPending}
          className="inline-flex h-10 items-center justify-center rounded-lg bg-accent text-sm font-medium text-accent-ink transition-[transform,background-color] duration-150 ease-out hover:bg-accent-strong active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="mt-4 text-sm text-ink-tertiary">
        No account?{" "}
        <Link href="/app/register" className="font-medium text-ink underline underline-offset-4">
          Create one
        </Link>
        {" · "}
        <Link
          href="/app/forgot-password"
          className="font-medium text-ink underline underline-offset-4"
        >
          Forgot password
        </Link>
      </p>
    </div>
  );
}
