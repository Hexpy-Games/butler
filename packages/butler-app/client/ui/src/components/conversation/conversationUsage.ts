import { appCopy, getAppLocale } from "@/app/copy.ts";
import type { ContextDetailsView, UsageMonitorView } from "@/app/types.ts";
import type { UsageQuotaWindow, UsageSummaryRowsProps, UsageTokenRow } from "@/butler-ds";
import { windowLabel } from "../settings/providerQuotaPresentation";
import type { UsageAuthMode } from "./usageAuthMode";

export type ConversationUsageStatus = "idle" | "loading" | "ready" | "failed";

export interface ConversationUsageInput {
  mode: UsageAuthMode;
  context: ContextDetailsView;
  /** The last /usage-monitor view for this session, kept across refetches. */
  view: UsageMonitorView | null;
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

function quotaWindows(view: UsageMonitorView, context: ContextDetailsView): UsageQuotaWindow[] | null {
  const providerId = context.provider_id ?? view.providerUsage.activeProviderId;
  const quota = view.providerUsage.providers.find((provider) => provider.providerId === providerId)?.remaining;
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

function quotaUpdatedAt(view: UsageMonitorView, context: ContextDetailsView): string | null {
  const providerId = context.provider_id ?? view.providerUsage.activeProviderId;
  const quota = view.providerUsage.providers.find((provider) => provider.providerId === providerId)?.remaining;
  return quota?.stale ? quota.fetchedAt ?? view.generated_at : null;
}

/**
 * The popover's usage section for this conversation, or null when the mode
 * has none (local and unknown models show context only).
 */
export function conversationUsageSummary({ mode, context, view, status }: ConversationUsageInput): UsageSummaryRowsProps | null {
  if (mode === "local" || mode === "unknown") return null;
  const copy = appCopy.composer.usage;
  const base: UsageSummaryRowsProps = {
    unavailableLabel: copy.unavailable,
    loadingLabel: copy.loading,
    estimateLabel: copy.estimate,
    remainingLabel: copy.left,
    locale: getAppLocale(),
  };
  if (!view) return { ...base, state: status === "failed" ? "unavailable" : "loading" };
  const staleAt = status === "failed" ? view.generated_at : null;
  if (mode === "subscription") {
    const windows = quotaWindows(view, context);
    if (!windows) return { ...base, state: "unavailable" };
    const updatedAt = quotaUpdatedAt(view, context) ?? staleAt;
    return { ...base, state: "ready", quotaWindows: windows, updatedLabel: updatedAt ? copy.updated(usageTime(updatedAt)) : undefined };
  }
  const usd = view.cost.available ? view.cost.estimatedUsd : null;
  return {
    ...base,
    state: "ready",
    tokens: tokenRows(view),
    cost: { label: copy.cost, usd, estimated: usd !== null && Boolean(view.cost.asOf) },
    updatedLabel: staleAt ? copy.updated(usageTime(staleAt)) : undefined,
  };
}
