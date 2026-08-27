"use client";

import { LockKey } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ApiError } from "@/lib/api";

/**
 * A soft-throttle upsell card: shown in place of a blocked action (new
 * project, upload, start/render job) when the user hits a plan limit. Read
 * access to existing projects/previews is never blocked — only the write
 * action is gated, so this replaces the form/button that would have started it.
 */
export function UpgradeRequired({
  title = "Limit reached",
  message,
  detail,
  children,
}: {
  title?: string;
  message: string;
  detail?: string;
  children?: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col items-start gap-3 border-accent/30 bg-accent-soft/40 p-5">
      <div className="flex items-center gap-2 text-sm font-medium text-ink">
        <LockKey size={16} weight="fill" className="text-accent" />
        {title}
      </div>
      <p className="text-sm text-ink-tertiary pretty">{message}</p>
      {detail && <p className="text-xs text-ink-muted">{detail}</p>}
      {children}
      <Link to="/billing">
        <Button size="sm">
          Get credits
        </Button>
      </Link>
    </Card>
  );
}

/** True when a thrown error is a 402 paywall response (acts as a type guard). */
export function isPaywall(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 402;
}