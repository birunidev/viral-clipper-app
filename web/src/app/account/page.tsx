"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AccountPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/app/profile");
  }, [router]);
  return (
    <div className="mx-auto max-w-3xl px-6 py-12 text-sm text-ink-tertiary">
      Redirecting to your account…
    </div>
  );
}
