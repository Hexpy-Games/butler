import { compactTokens } from "./compactTokens";
import { appCopy, getAppLocale } from "@/app/copy";
import type { UsageMonitorView } from "@/app/types";
import { bucketUsageSlots, type UsageBarsEmphasis, type UsageBarsSegment, type UsageBarsSeries } from "@/butler-ds";

export function usageSeries(): UsageBarsSeries[] {
  const copy = appCopy.composer.usage;
  return [
    { id: "new", color: "chart-1", label: copy.newInput },
    { id: "cache", color: "chart-5", label: copy.cached },
    { id: "output", color: "chart-2", label: copy.output },
  ];
}

export function usageTokens(value: number): string {
  return compactTokens(value, getAppLocale());
}

export function usageClock(value: number): string {
  return new Intl.DateTimeFormat(getAppLocale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(value);
}

export function usageBucketLabel(start: number, end: number, now: number, stepHours: number): string {
  const date = new Intl.DateTimeFormat(getAppLocale(), { month: "short", day: "numeric" }).format(start);
  const sameDay = new Date(start).toDateString() === new Date(now).toDateString();
  const hour = (value: number) => new Date(value).getHours();
  const time = stepHours < 24 ? appCopy.composer.usage.bucketHours(hour(start), hour(end) || 24, sameDay && stepHours === 1) : "";
  const label = [!sameDay || stepHours >= 24 ? date : "", time].filter(Boolean).join(" ");
  return [label, start <= now && now < end ? appCopy.composer.usage.now : ""].filter(Boolean).join(" · ");
}

export function usageTimeline(view: UsageMonitorView | null, maxBars: number) {
  const now = view ? Date.parse(view.generated_at) : 0;
  const grouped = bucketUsageSlots(view?.timeline.slots ?? [], {
    maxBars,
    fromMs: view?.filters.sinceTs ?? undefined,
    toMs: view ? view.filters.untilTs ?? now : undefined,
  });
  // Only one chat's usage splits by who made the calls; all-chats bars stay solid.
  const scoped = Boolean(view?.filters.sessionId);
  const buckets = grouped.buckets.map((bucket) => {
    const [requests = 0, prompt = 0, cached = 0, output = 0, delegated = 0, dRequests = 0, dCached = 0, dOutput = 0] = bucket.values;
    const split = scoped && delegated > 0;
    const segment = (id: string, value: number, subtask: number): UsageBarsSegment => split ? { id, value, subtask } : { id, value };
    return {
      ...bucket, requests, prompt, cached, output, delegated, dRequests, total: prompt + output,
      key: String(bucket.startMs),
      label: usageBucketLabel(bucket.startMs, bucket.endMs, now, grouped.stepHours),
      valueText: `${usageTokens(prompt + output)} ${appCopy.composer.usage.tokens}`,
      segments: [
        segment("new", Math.max(0, prompt - cached), Math.max(0, delegated - dOutput - dCached)),
        segment("cache", cached, dCached),
        segment("output", output, dOutput),
      ],
    };
  });
  const indices = [...new Set([0, Math.floor((buckets.length - 1) / 2), buckets.length - 1])].filter((i) => i >= 0 && i < buckets.length);
  const axisLabels = indices.map((index) => ({ index, text: grouped.stepHours < 24
    ? `${new Date(buckets[index]!.startMs).toDateString() !== new Date(now).toDateString() ? new Intl.DateTimeFormat(getAppLocale(), { month: "short", day: "numeric" }).format(buckets[index]!.startMs) + " " : ""}${usageClock(buckets[index]!.startMs)}`
    : new Intl.DateTimeFormat(getAppLocale(), { month: "short", day: "numeric" }).format(buckets[index]!.startMs) }));
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

export function usageShare(value: number): string {
  if (value > 0 && value < 0.01) return appCopy.composer.usage.tinyShare;
  return new Intl.NumberFormat(getAppLocale(), { style: "percent", maximumFractionDigits: 1 }).format(value);
}

/**
 * The chat total split into its own calls and its delegated work; `null` when nothing was delegated.
 * `requests` adds each part's request count: byRole for the whole chat, the slots' delegated requests for a bar.
 * `emphasis` is the chart emphasis the part's legend row links to.
 */
export function usageParts(view: UsageMonitorView | null, bucket?: ReturnType<typeof usageTimeline>["buckets"][number], requests = false) {
  const roles = view?.model.byRole;
  if (!view || !roles) return null;
  const sum = (field: "totalTokens" | "requestCount") =>
    Object.entries(roles).reduce((total, [role, part]) => role === "main" ? total : total + part[field], 0);
  const delegatedAll = sum("totalTokens");
  if (delegatedAll <= 0) return null;
  // Both parts share one basis: byRole totals for the chat, the slot's prompt + output for a bar.
  const [main, delegated] = bucket ? [bucket.total - bucket.delegated, bucket.delegated] : [roles.main?.totalTokens ?? 0, delegatedAll];
  const counts = !requests ? null : bucket ? [bucket.requests - bucket.dRequests, bucket.dRequests] : [roles.main?.requestCount ?? 0, sum("requestCount")];
  const total = main + delegated;
  const copy = appCopy.composer.usage;
  const count = new Intl.NumberFormat(getAppLocale());
  const part = (id: string, emphasis: UsageBarsEmphasis, label: string, value: number, calls?: number) => ({ id, emphasis, label, value: [
    usageTokens(value), total > 0 ? usageShare(value / total) : null, calls === undefined ? null : copy.requests(count.format(calls)),
  ].filter(Boolean).join(" · ") });
  return [part("main", "conversation", copy.conversationPart, main, counts?.[0]), part("delegated", "subtask", copy.delegatedPart, delegated, counts?.[1])];
}
