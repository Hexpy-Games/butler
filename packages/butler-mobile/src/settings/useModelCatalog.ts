import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { GatewayClient } from "../../../butler-protocol/src/client/index.ts";
import { getAppCopy, reasoningEffortLabel, type AppLocale } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import type { AppModelSummary, ModelCatalogView, ReasoningEffort } from "./types";

const cache = new WeakMap<GatewayClient, ModelCatalogView>();
const listeners = new Set<() => void>();
const listen = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export async function refreshModelCatalog(client: GatewayClient): Promise<void> {
  cache.set(client, await client.request<ModelCatalogView>("/model-catalog"));
  listeners.forEach(listener => listener());
}

export function useModelCatalog() {
  const { client, reconcile } = useConversation();
  const [error, setError] = useState(false);
  const catalog = useSyncExternalStore(listen, () => client ? cache.get(client) ?? null : null);
  const reload = useCallback(() => {
    if (!client) return;
    setError(false);
    void refreshModelCatalog(client).catch(() => setError(true));
  }, [client]);
  useEffect(reload, [reload, reconcile]);
  return { catalog, error, reload };
}

export function runtimeModels(c: ModelCatalogView): AppModelSummary[] {
  const models = c?.registered_models?.length ? c.registered_models : c?.models ?? [];
  return models.filter(model => model.runtime_supported === true && model.availability === "ready");
}

export function modelDisplayName(m: AppModelSummary | null | undefined, locale: AppLocale): string {
  return m?.display_name ?? m?.model_id ?? getAppCopy(locale).interfaceFeedback.model;
}

export function tokenWindowLabel(tokens: number | undefined, locale: AppLocale): string {
  if (typeof tokens !== "number" || !Number.isFinite(tokens)) return getAppCopy(locale).interfaceFeedback.contextUnknown;
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M API context`;
  return `${Math.round(tokens / 1000)}k API context`;
}

export function modelLabel(m: AppModelSummary, locale: AppLocale): string {
  return `${m.provider_label} / ${modelDisplayName(m, locale)} (${tokenWindowLabel(m.context_window_tokens, locale)})`;
}

export function reasoningOptionLabel(m: AppModelSummary | undefined, e: ReasoningEffort, locale: AppLocale): string {
  if (m?.provider_id === "local" && e !== "none") {
    const ratio = m.local_reasoning_budget_ratio;
    if (typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0) return `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
    const budget = m.reasoning_budget_tokens?.[e];
    if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) {
      if (budget < 1000) return String(Math.round(budget));
      const value = budget / 1000;
      return `${value < 10 && !Number.isInteger(value) ? value.toFixed(1) : Math.round(value)}k`;
    }
  }
  return reasoningEffortLabel(e, locale);
}

export function effectiveReasoningEffort(model: AppModelSummary | undefined, stored: ReasoningEffort): ReasoningEffort {
  const efforts = model?.reasoning_efforts ?? ["none"];
  if (efforts.includes(stored)) return stored;
  if (model && efforts.includes(model.default_reasoning_effort)) return model.default_reasoning_effort;
  return efforts[0] ?? "none";
}
