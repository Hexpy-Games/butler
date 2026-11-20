import type { AppCopy } from "../../../../butler-i18n/src/index.ts";
import type { ButlerUsage, ContextDetails, ModelSummary, ProviderQuotaResult, ProviderQuotaWindow, UsageMonitorView } from "../../../../butler-protocol/src/index.ts";
import { bucketUsageSlots } from "../../../../butler-app/client/ui/src/libs/design-system/blocks/UsageBars/usageBuckets.ts";
import { compactTokens } from "../../../../butler-app/client/ui/src/components/usage/compactTokens.ts";
import type { UsageBarsSegment } from "../../ds/UsageBars";


/** How the conversation's model is billed, which picks the popover's usage section. */
export type UsageAuthMode = "subscription" | "api_key" | "local" | "unknown";

type Context = Pick<ContextDetails, "model_ref" | "provider_id"> | null | undefined;

export function usageAuthMode(model: ModelSummary | null | undefined, context: Context): UsageAuthMode {
  if (model?.provider_id === "local" || model?.platform || context?.provider_id === "local") return "local";
  if (model?.auth_type === "chatgpt_oauth") return "subscription";
  if (model?.auth_type === "api_key") return "api_key";
  return "unknown";
}

/** The catalog model the context was measured with; the active model when the context names none. */
export function contextModel(
  models: ModelSummary[],
  context: Context,
  activeModel: ModelSummary | null,
): ModelSummary | null {
  if (!context?.model_ref) return activeModel;
  return models.find((model) => model.model_ref === context.model_ref) ?? null;
}

/** Values after the start of a slot that carries its subtask requests, cached and output; shorter slots have no per-type split. */
const SPLIT_SLOT_VALUES = 8;

export function usageClock(value: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(value);
}

export function usageBucketLabel(start: number, end: number, now: number, stepHours: number, copy: AppCopy, locale: string): string {
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(start);
  const sameDay = new Date(start).toDateString() === new Date(now).toDateString();
  const hour = (value: number) => new Date(value).getHours();
  const time = stepHours < 24 ? copy.composer.usage.bucketHours(hour(start), hour(end) || 24, sameDay && stepHours === 1) : "";
  const label = [!sameDay || stepHours >= 24 ? date : "", time].filter(Boolean).join(" ");
  return [label, start <= now && now < end ? copy.composer.usage.now : ""].filter(Boolean).join(" · ");
}

export function usageTimeline(view: UsageMonitorView | null, maxBars: number, copy: AppCopy, locale: string) {
  const now = view ? Date.parse(view.generated_at) : 0;
  const grouped = bucketUsageSlots((view?.timeline.slots ?? []) as [number, ...number[]][], {
    maxBars,
    fromMs: view?.filters.sinceTs ?? undefined,
    toMs: view ? view.filters.untilTs ?? now : undefined,
  });
  // Only one chat's usage splits by who made the calls; all-chats bars stay solid.
  const scoped = Boolean(view?.filters.sessionId);
  const buckets = grouped.buckets.map((bucket) => {
    const [requests = 0, prompt = 0, cached = 0, output = 0, delegated = 0, dRequests = 0, dCached = 0, dOutput = 0] = bucket.values;
    const split = scoped && delegated > 0 && bucket.values.length >= SPLIT_SLOT_VALUES;
    const segment = (id: string, value: number, subtask: number): UsageBarsSegment => split ? { id, value, subtask } : { id, value };
    const label = usageBucketLabel(bucket.startMs, bucket.endMs, now, grouped.stepHours, copy, locale);
    return {
      ...bucket, requests, prompt, cached, output, delegated, dRequests, total: prompt + output,
      key: label, label,
      valueText: `${compactTokens(prompt + output, locale)} ${copy.composer.usage.tokens}`,
      segments: [
        segment("new", Math.max(0, prompt - cached), Math.max(0, delegated - dOutput - dCached)),
        segment("cache", cached, dCached),
        segment("output", output, dOutput),
      ],
    };
  });
  const indices = [...new Set([0, Math.floor((buckets.length - 1) / 2), buckets.length - 1])].filter((i) => i >= 0 && i < buckets.length);
  const axisLabels = indices.map((index) => ({ index, text: grouped.stepHours < 24
    ? `${new Date(buckets[index]!.startMs).toDateString() !== new Date(now).toDateString() ? new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(buckets[index]!.startMs) + " " : ""}${usageClock(buckets[index]!.startMs, locale)}`
    : new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(buckets[index]!.startMs) }));
  return { buckets, axisLabels, stepHours: grouped.stepHours };
}

export function usageReadout(view: UsageMonitorView | null, bucket?: ReturnType<typeof usageTimeline>["buckets"][number]) {
  return bucket ?? {
    requests: view?.model.requestCount ?? 0,
    prompt: view?.model.promptTokens ?? 0,
    cached: view?.model.cachedTokens ?? 0,
    output: Math.max(0, (view?.model.totalTokens ?? 0) - (view?.model.promptTokens ?? 0)),
    total: view?.model.totalTokens ?? 0,
  };
}

export function usageShare(value: number, copy: AppCopy, locale: string): string {
  if (value > 0 && value < 0.01) return copy.composer.usage.tinyShare;
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(value);
}

/**
 * The chat total split into its own calls and its delegated work; `null` when nothing was delegated,
 * or when the response lacks the values for an honest split.
 * `emphasis` is the chart emphasis the part's legend row links to.
 */
export function usageParts(view: UsageMonitorView | null, copy: AppCopy, locale: string, bucket?: ReturnType<typeof usageTimeline>["buckets"][number]) {
  const subtasks = view?.model.subtasks;
  if (!view || !subtasks || !(subtasks.totalTokens > 0)) return null;
  if (bucket && bucket.values.length < SPLIT_SLOT_VALUES) return null;
  // Both parts share one basis: the view's totals for the chat, the slot's prompt + output for a bar.
  const [whole, delegated] = bucket ? [bucket.total, bucket.delegated] : [view.model.totalTokens, subtasks.totalTokens];
  const main = Math.max(0, whole - delegated);
  const total = main + delegated;
  const part = (id: string, emphasis: "conversation" | "subtask", label: string, value: number) => ({ id, emphasis, label, value: [
    compactTokens(value, locale), total > 0 ? usageShare(value / total, copy, locale) : null,
  ].filter(Boolean).join(" · ") });
  return [part("main", "conversation", copy.composer.usage.conversationPart, main), part("delegated", "subtask", copy.composer.usage.delegatedPart, delegated)];
}

const SAME_DAY_MS = 20 * 60 * 60 * 1000;

/** "14:05" today; "Oct 2" / "10월 2일" for another day. */
export function usageTime(value: string, locale: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  const sameDay = Math.abs(timestamp - now) < SAME_DAY_MS && new Date(timestamp).getDate() === new Date(now).getDate();
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
    : { month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(locale, options).format(timestamp);
}

export function windowLabel(
  window: ProviderQuotaWindow, copy: AppCopy,
): string {
  if (window.id === "mcp-month") return copy.interfaceStatus.mcpMonthly;
  if (window.id === "tokens-5-hour" || window.id.startsWith("tokens-5-hour-")) {
    return copy.interfaceStatus.fiveHour;
  }
  if (window.id === "tokens-weekly" || window.id.startsWith("tokens-weekly-")) {
    return copy.interfaceStatus.weekly;
  }
  if (window.windowDurationMins !== null) {
    return copy.interfaceStatus.minutesLimit(window.windowDurationMins);
  }
  return window.id === "individualLimit" ? copy.interfaceStatus.individual : copy.interfaceStatus.providedLimit;
}

export type ConversationUsageStatus = "idle" | "loading" | "ready" | "failed";
export interface QuotaSummary {
  state: "loading" | "unavailable" | "ready";
  windows: { id: string; label: string; remainingPercent: number | null; caption?: string }[];
  updatedLabel?: string;
  plan?: ProviderQuotaResult;
  butlerUsage?: ButlerUsage | null;
}

export function quotaSummary(
  mode: UsageAuthMode, context: ContextDetails, view: UsageMonitorView | null,
  quota: ProviderQuotaResult | null, status: ConversationUsageStatus, copy: AppCopy, locale: string,
): QuotaSummary | null {
  if (mode !== "subscription") return null;
  const providerId = context.provider_id ?? view?.providerUsage.activeProviderId;
  const own = view?.providerUsage.providers.find(provider => provider.providerId === providerId)?.remaining;
  const source = own?.available ? own : quota ?? own;
  const windows = !source?.available || source.windows.length === 0 ? null : source.windows.map(window => ({
    id: window.id, label: windowLabel(window, copy), remainingPercent: window.remainingPercent,
    caption: window.resetsAt ? copy.interfaceTemplates.resets(usageTime(window.resetsAt, locale)) : undefined,
  }));
  if (source?.sourceKind === "chatgpt_plan" && source.planUsage) return {
    state: "ready", plan: source, windows: windows ?? [],
    butlerUsage: view?.providerUsage.providers.find(provider => provider.providerId === "openai")?.butlerUsage,
  };
  if (!windows) return { state: !view && status !== "failed" ? "loading" : "unavailable", windows: [] };
  const staleAt = status === "failed" && view ? view.generated_at : null;
  const updatedAt = (source?.stale ? source.fetchedAt ?? view?.generated_at ?? "" : null) ?? staleAt;
  return { state: "ready", windows, updatedLabel: updatedAt ? copy.composer.usage.updated(usageTime(updatedAt, locale)) : undefined };
}
