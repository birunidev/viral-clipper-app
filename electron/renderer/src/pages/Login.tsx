import { Link, useNavigate } from "react-router-dom";
import { useState } from "react";

export default function LoginPage() {
  const navigate = useNavigate();
  const [key, setKey] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!key.trim()) {
      setError("Paste your license key from clipzard.web.id/account");
      return;
    }
    setPending(true);
    try {
      const res = await window.clipzard?.licenseVerify(key.trim(), email.trim() || undefined);
      if (res?.valid) navigate("/");
      else setError(res?.message ?? "Invalid license");
    } catch (err) {
      setError(err instanceof Error ? err.message : "License check failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <h1 className="text-xl font-semibold tracking-tight text-ink">Activate ClipZard</h1>
      <p className="mt-1 text-sm text-ink-tertiary">Paste your one-time license key.</p>
      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-ink-secondary">License key</span>
          <input
            required
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="h-10 rounded-lg border border-line bg-surface-2 px-3 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-accent/50"
            placeholder="CF-XXXX-XXXX-XXXX"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-ink-secondary">Email (optional)</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-10 rounded-lg border border-line bg-surface-2 px-3 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-accent/50"
            placeholder="you@example.com"
          />
        </label>
        {error && <p className="text-sm text-danger" role="alert">{error}</p>}
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-10 items-center justify-center rounded-lg bg-accent text-sm font-medium text-accent-ink transition-[transform,background-color] hover:bg-accent-strong active:scale-[0.98] disabled:opacity-50"
        >
          {pending ? "Activating…" : "Activate"}
        </button>
      </form>
      <p className="mt-4 text-sm text-ink-tertiary">
        No license? <a href="https://clipzard.web.id" target="_blank" className="font-medium text-ink underline underline-offset-4">Buy ClipZard — $49 one-time</a>
      </p>
      <p className="mt-2 text-xs text-ink-muted">
        Insider? <Link to="/register" className="underline">Use email login</Link> · Same input style as web/src/app/app/(auth)/login
      </p>
    </div>
  );
}
