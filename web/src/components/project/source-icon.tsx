"use client";

import { ArrowUpRight, Broadcast, Paperclip } from "@phosphor-icons/react";

export function SourceTypeIcon({ type }: { type: string }) {
  const Icon = type === "upload" ? Paperclip : Broadcast;
  return <Icon size={14} weight="fill" />;
}

export function ExternalArrow() {
  return <ArrowUpRight size={14} />;
}
