"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useRegister } from "@/hooks/use-auth";

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const register = useRegister();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    register.mutate(
      { name, email, password },
      {
        onSuccess: () => router.push("/app/dashboard"),
        onError: (err) => setError(err.message),
      }
    );
  }

  return (
    <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
      <h1 className="text-xl font-semibold">Create your account</h1>
      <p className="mt-1 text-sm text-zinc-400">Start cutting viral clips.</p>
      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Name
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-zinc-400"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-zinc-400"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-zinc-400"
          />
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={register.isPending}
          className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white disabled:opacity-50"
        >
          {register.isPending ? "Creating..." : "Create account"}
        </button>
      </form>
      <p className="mt-4 text-sm text-zinc-400">
        Already have an account?{" "}
        <Link href="/app/login" className="text-zinc-100 underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
