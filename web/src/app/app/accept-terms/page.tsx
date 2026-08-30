"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAcceptTerms, useLogout, useSession } from "@/hooks/use-auth";

export default function AcceptTermsPage() {
  const router = useRouter();
  const { data: user, isLoading } = useSession();
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");
  const acceptTerms = useAcceptTerms();
  const logout = useLogout();

  useEffect(() => {
    if (!isLoading && !user) router.replace("/app/login");
    if (!isLoading && user?.terms_accepted_at) router.replace("/app/profile");
  }, [isLoading, user, router]);

  if (isLoading || !user) return null;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!accepted) {
      setError("You must agree to the Terms of Service and Privacy Policy to continue.");
      return;
    }
    acceptTerms.mutate(undefined, {
      onSuccess: () => router.replace("/app/profile"),
      onError: (err) => setError(err.message),
    });
  }

  return (
    <main className="grain flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Please review our Terms</h1>
        <p className="mt-1 text-sm text-ink-tertiary">
          Before you continue, please accept our updated Terms of Service and Privacy Policy.
        </p>
        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
          <label className="flex items-start gap-2.5 text-sm text-ink-secondary">
            <input
              type="checkbox"
              required
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
            />
            <span>
              I agree to the{" "}
              <Link
                href="/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-ink underline underline-offset-4"
              >
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link
                href="/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-ink underline underline-offset-4"
              >
                Privacy Policy
              </Link>
              .
            </span>
          </label>
          {error && (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={acceptTerms.isPending || !accepted}
            className="inline-flex h-10 items-center justify-center rounded-lg bg-accent text-sm font-medium text-accent-ink transition-[transform,background-color] duration-150 ease-out hover:bg-accent-strong active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {acceptTerms.isPending ? "Saving…" : "Accept and continue"}
          </button>
        </form>
        <button
          onClick={() => logout.mutate(undefined, { onSuccess: () => router.replace("/app/login") })}
          className="mt-4 text-sm text-ink-tertiary underline underline-offset-4 hover:text-ink"
        >
          Sign out instead
        </button>
      </div>
    </main>
  );
}
