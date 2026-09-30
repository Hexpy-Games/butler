import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import type { ProviderQuotaResultView, UsageMonitorView } from "@/app/types.ts";
import type { ConversationUsageStatus } from "./conversationUsage";

export type UsageLoader = (sessionId: string) => Promise<UsageMonitorView>;

export const loadConversationUsage: UsageLoader = (sessionId) =>
  api<UsageMonitorView>(`/usage-monitor?${new URLSearchParams({ session_id: sessionId })}`);

export type QuotaLoader = (providerId: string) => Promise<ProviderQuotaResultView>;

/** The stored quota of a provider: a millisecond read, unlike the monitor's. */
export const loadProviderQuota: QuotaLoader = (providerId) =>
  api<ProviderQuotaResultView>(`/provider-quota?${new URLSearchParams({ provider_id: providerId })}`);

/** Last view per session, so reopening shows it at once while it refreshes. */
const lastViews = new Map<string, UsageMonitorView>();
/** Last quota per provider, shown before the monitor answers. */
const lastQuotas = new Map<string, ProviderQuotaResultView>();

export function resetConversationUsageCache(): void {
  lastViews.clear();
  lastQuotas.clear();
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
  providerId = null,
  loadQuota = loadProviderQuota,
}: {
  sessionId: string | null;
  open: boolean;
  revision: string;
  load?: UsageLoader;
  /** Set for subscription models: their quota is read apart from the monitor. */
  providerId?: string | null;
  loadQuota?: QuotaLoader;
}): { view: UsageMonitorView | null; quota: ProviderQuotaResultView | null; status: ConversationUsageStatus } {
  const key = `${sessionId ?? ""}\u0000${revision}`;
  const [result, setResult] = useState<Result | null>(null);
  const [, setView] = useState<UsageMonitorView | null>(null);
  const [, setQuota] = useState<ProviderQuotaResultView | null>(null);

  useEffect(() => {
    if (!open || !sessionId || !providerId) return undefined;
    let cancelled = false;
    loadQuota(providerId).then(
      (next) => {
        if (cancelled) return;
        lastQuotas.set(providerId, next);
        setQuota(next);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, providerId, revision, loadQuota]);

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
  const quota = providerId ? lastQuotas.get(providerId) ?? null : null;
  if (!sessionId) return { view: null, quota: null, status: "idle" };
  if (result?.key === key) return { view, quota, status: result.status };
  return { view, quota, status: open ? "loading" : "idle" };
}
