import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import type { UsageMonitorView } from "@/app/types.ts";
import type { ConversationUsageStatus } from "./conversationUsage";

export type UsageLoader = (sessionId: string) => Promise<UsageMonitorView>;

export const loadConversationUsage: UsageLoader = (sessionId) =>
  api<UsageMonitorView>(`/usage-monitor?${new URLSearchParams({ session_id: sessionId })}`);

/** Last view per session, so reopening shows it at once while it refreshes. */
const lastViews = new Map<string, UsageMonitorView>();

export function resetConversationUsageCache(): void {
  lastViews.clear();
}

interface Result {
  key: string;
  status: Exclude<ConversationUsageStatus, "idle" | "loading">;
}

/**
 * This conversation's /usage-monitor view. Fetched when `open` turns true and
 * again when `revision` (the session view's context) changes while open; no
 * polling or timers.
 */
export function useConversationUsage({
  sessionId,
  open,
  revision,
  load = loadConversationUsage,
}: {
  sessionId: string | null;
  open: boolean;
  revision: string;
  load?: UsageLoader;
}): { view: UsageMonitorView | null; status: ConversationUsageStatus } {
  const key = `${sessionId ?? ""}\u0000${revision}`;
  const [result, setResult] = useState<Result | null>(null);
  const [, setView] = useState<UsageMonitorView | null>(null);

  useEffect(() => {
    if (!open || !sessionId) return undefined;
    let cancelled = false;
    load(sessionId).then(
      (next) => {
        if (cancelled) return;
        lastViews.set(sessionId, next);
        setView(next);
        setResult({ key, status: "ready" });
      },
      () => {
        if (!cancelled) setResult({ key, status: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, key, load]);

  const view = sessionId ? lastViews.get(sessionId) ?? null : null;
  if (!sessionId) return { view: null, status: "idle" };
  if (result?.key === key) return { view, status: result.status };
  return { view, status: open ? "loading" : "idle" };
}
