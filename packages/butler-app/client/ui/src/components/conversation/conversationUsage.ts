import { appCopy, getAppLocale } from "@/app/copy.ts";
import type { ContextDetailsView, ProviderQuotaResultView, UsageMonitorView } from "@/app/types.ts";
import type { UsageQuotaWindow, UsageSummaryRowsProps, UsageTokenRow } from "@/butler-ds";
import { windowLabel } from "../settings/providerQuotaPresentation";
import type { UsageAuthMode } from "./usageAuthMode";

export type ConversationUsageStatus = "idle" | "loading" | "ready" | "failed";

export interface ConversationUsageInput {
  mode: UsageAuthMode;
  context: ContextDetailsView;
  /** The last /usage-monitor view for this session, kept across refetches. */
  view: UsageMonitorView | null;
  /** The provider's stored quota, read apart from (and before) the monitor. */
  quota?: ProviderQuotaResultView | null;
  status: ConversationUsageStatus;
}

const SAME_DAY_MS = 20 * 60 * 60 * 1000;

/** "14:05" today; "Oct 2" / "10월 2일" for another day. */
export function usageTime(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  const sameDay = Math.abs(timestamp - now) < SAME_DAY_MS && new Date(timestamp).getDate() === new Date(now).getDate();
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
    : { month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(getAppLocale(), options).format(timestamp);
}

function viewQuota(view: UsageMonitorView, context: ContextDetailsView): ProviderQuotaResultView | undefined {
  const providerId = context.provider_id ?? view.providerUsage.activeProviderId;
  return view.providerUsage.providers.find((provider) => provider.providerId === providerId)?.remaining;
}

function quotaWindows(quota: ProviderQuotaResultView | null | undefined): UsageQuotaWindow[] | null {
  if (!quota?.available || quota.windows.length === 0) return null;
  return quota.windows.map((window) => ({
    id: window.id,
    label: windowLabel(window),
    remainingPercent: window.remainingPercent,
    caption: window.resetsAt ? appCopy.interfaceTemplates.resets(usageTime(window.resetsAt)) : undefined,
  }));
}

function tokenRows(view: UsageMonitorView): UsageTokenRow[] {
  const copy = appCopy.composer.usage;
  const bucket = view.model;
  return [
    { id: "input", label: copy.input, value: bucket.promptTokens },
    { id: "cached", label: copy.cached, value: bucket.cachedTokens },
    { id: "output", label: copy.output, value: bucket.outputTokens },
    ...(typeof bucket.reasoningTokens === "number" ? [{ id: "reasoning", label: copy.reasoning, value: bucket.reasoningTokens }] : []),
  ];
}

function quotaUpdatedAt(quota: ProviderQuotaResultView | null | undefined, fallback: string): string | null {
  return quota?.stale ? quota.fetchedAt ?? fallback : null;
}

/**
 * The popover's usage section for this conversation, or null when the mode
 * has none (local and unknown models show context only).
 */
export function conversationUsageSummary({ mode, context, view, quota, status }: ConversationUsageInput): UsageSummaryRowsProps | null {
  if (mode === "local" || mode === "unknown") return null;
  const copy = appCopy.composer.usage;
  const base: UsageSummaryRowsProps = {
    unavailableLabel: copy.unavailable,
    loadingLabel: copy.loading,
    estimateLabel: copy.estimate,
    remainingLabel: copy.left,
    locale: getAppLocale(),
  };
  if (mode === "subscription") {
    // The monitor's quota is the one the whole page shows; the stored quota
    // stands in until the monitor answers.
    const own = view ? viewQuota(view, context) : undefined;
    const source = own?.available ? own : quota ?? own;
    const windows = quotaWindows(source);
    if (!windows) return { ...base, state: !view && status !== "failed" ? "loading" : "unavailable" };
    const staleAt = status === "failed" && view ? view.generated_at : null;
    const updatedAt = quotaUpdatedAt(source, view?.generated_at ?? "") ?? staleAt;
    return { ...base, state: "ready", quotaWindows: windows, updatedLabel: updatedAt ? copy.updated(usageTime(updatedAt)) : undefined };
  }
  if (!view) return { ...base, state: status === "failed" ? "unavailable" : "loading" };
  const staleAt = status === "failed" ? view.generated_at : null;
  const usd = view.cost.available ? view.cost.estimatedUsd : null;
  return {
    ...base,
    state: "ready",
    tokens: tokenRows(view),
    cost: { label: copy.cost, usd, estimated: usd !== null && Boolean(view.cost.asOf) },
    updatedLabel: staleAt ? copy.updated(usageTime(staleAt)) : undefined,
  };
}
