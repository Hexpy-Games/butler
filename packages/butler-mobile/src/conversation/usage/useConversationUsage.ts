import { useEffect, useState } from "react";
import type { ContextDetails, ProviderQuotaResult, UsageMonitorView } from "../../../../butler-protocol/src/index.ts";
import { useConversation } from "../live";
import type { ConversationUsageStatus } from "./usageView";

const lastViews = new Map<string, UsageMonitorView>();
const lastQuotas = new Map<string, ProviderQuotaResult>();

export function useConversationUsage({ sessionId, open, context, providerId = null }: {
  sessionId: string | null; open: boolean; context: ContextDetails; providerId?: string | null;
}): { view: UsageMonitorView | null; quota: ProviderQuotaResult | null; status: ConversationUsageStatus } {
  const { client } = useConversation();
  const revision = context.updated_at ?? `${context.used_tokens}/${context.budget_tokens}`;
  const key = `${sessionId ?? ""}\u0000${revision}`;
  const [result, setResult] = useState<{ key: string; status: "ready" | "failed" } | null>(null);
  const [, setView] = useState<UsageMonitorView | null>(null);
  const [, setQuota] = useState<ProviderQuotaResult | null>(null);
  useEffect(() => {
    if (!open || !client || !sessionId || !providerId) return;
    let cancelled = false;
    client.request<ProviderQuotaResult>(`/provider-quota?provider_id=${encodeURIComponent(providerId)}`).then(
      next => {
        if (cancelled) return;
        lastQuotas.set(providerId, next);
        setQuota(next);
      },
      () => undefined,
    );
    return () => { cancelled = true; };
  }, [open, client, sessionId, providerId, revision]);
  useEffect(() => {
    if (!open || !client || !sessionId) return;
    let cancelled = false;
    client.request<UsageMonitorView>(`/usage-monitor?session_id=${encodeURIComponent(sessionId)}`).then(
      next => {
        if (cancelled) return;
        lastViews.set(sessionId, next);
        setView(next);
        setResult({ key, status: "ready" });
      },
      () => { if (!cancelled) setResult({ key, status: "failed" }); },
    );
    return () => { cancelled = true; };
  }, [open, client, sessionId, key]);
  const view = sessionId ? lastViews.get(sessionId) ?? null : null;
  const quota = providerId ? lastQuotas.get(providerId) ?? null : null;
  if (!sessionId) return { view: null, quota: null, status: "idle" };
  if (result?.key === key) return { view, quota, status: result.status };
  return { view, quota, status: open ? "loading" : "idle" };
}
