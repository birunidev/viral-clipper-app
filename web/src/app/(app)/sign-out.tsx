"use client";

import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await authClient.signOut();
        router.push("/login");
        router.refresh();
      }}
      className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
    >
      Sign out
    </button>
  );
}
