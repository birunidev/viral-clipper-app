import { Link, useNavigate } from "react-router-dom";
import { useState } from "react";

export default function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [forgotMode, setForgotMode] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [pending, setPending] = useState(false);

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setInfo("");
    if (!email.trim() || !password) {
      setError("Email and password are required.");
      return;
    }
    setPending(true);
    try {
      const res = await window.clipzard?.authLogin(email.trim(), password);
      if (res?.ok) {
        navigate("/");
        return;
      }
      setError(
        res?.reason === "bad_credentials"
          ? "Invalid email or password."
          : res?.message ?? "Sign-in failed"
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setPending(false);
    }
  }

  async function onForgot(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setInfo("");
    if (!email.trim()) {
      setError("Enter the email you signed up with.");
      return;
    }
    setPending(true);
    try {
      const res = await window.clipzard?.authForgotPassword(email.trim());
      if (res?.ok) {
        setInfo("If that email is associated with an account, a reset link is on its way.");
      } else {
        setError(res?.message ?? "Failed to send reset link.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setPending(false);
    }
  }

  async function onSignOut() {
    await window.clipzard?.entitlementSignOut();
    setInfo("Signed out. Sign in with a different account.");
  }

  return (
    <div className="w-full max-w-sm">
      <h1 className="text-xl font-semibold tracking-tight text-ink">Sign in to ClipZard</h1>
      <p className="mt-1 text-sm text-ink-tertiary">
        Use the same account you have at clipzard.web.id.
      </p>

      {!forgotMode ? (
        <form onSubmit={onLogin} className="mt-6 flex flex-col gap-4">
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
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          {info && <p className="text-sm text-success" role="status">{info}</p>}
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-10 items-center justify-center rounded-lg bg-accent text-sm font-medium text-accent-ink transition-[transform,background-color] hover:bg-accent-strong active:scale-[0.98] disabled:opacity-50"
          >
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      ) : (
        <form onSubmit={onForgot} className="mt-6 flex flex-col gap-4">
          <p className="text-sm text-ink-secondary">
            Enter your account email and we&apos;ll send a one-time reset link.
          </p>
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
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          {info && <p className="text-sm text-success" role="status">{info}</p>}
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-10 items-center justify-center rounded-lg bg-accent text-sm font-medium text-accent-ink transition-[transform,background-color] hover:bg-accent-strong active:scale-[0.98] disabled:opacity-50"
          >
            {pending ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}

      <div className="mt-4 flex flex-col gap-2 text-sm text-ink-tertiary">
        {!forgotMode ? (
          <button
            type="button"
            onClick={() => { setForgotMode(true); setError(""); setInfo(""); }}
            className="text-left text-ink underline underline-offset-4"
          >
            Forgot your password?
          </button>
        ) : (
          <button
            type="button"
            onClick={() => { setForgotMode(false); setError(""); setInfo(""); }}
            className="text-left text-ink underline underline-offset-4"
          >
            Back to sign in
          </button>
        )}
        <button
          type="button"
          onClick={onSignOut}
          className="text-left text-ink-tertiary underline-offset-4 hover:underline"
        >
          Sign out current account
        </button>
        <p className="text-xs text-ink-muted">
          No account?{" "}
          <a
            href="https://clipzard.web.id"
            target="_blank"
            rel="noreferrer"
            className="text-ink underline underline-offset-4"
          >
            Buy a license at clipzard.web.id
          </a>
        </p>
      </div>
    </div>
  );
}
