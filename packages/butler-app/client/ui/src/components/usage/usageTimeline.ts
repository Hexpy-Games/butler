import { appCopy, getAppLocale } from "@/app/copy";
import type { UsageMonitorView } from "@/app/types";
import { bucketUsageSlots, formatUsageTokens, type UsageBarsSeries } from "@/butler-ds";

export function usageSeries(): UsageBarsSeries[] {
  const copy = appCopy.composer.usage;
  return [
    { id: "new", color: "chart-1", label: copy.newInput },
    { id: "cache", color: "chart-5", label: copy.cached },
    { id: "output", color: "chart-2", label: copy.output },
  ];
}

export function usageTokens(value: number): string {
  return formatUsageTokens(value, getAppLocale());
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
  const buckets = grouped.buckets.map((bucket) => {
    const [requests = 0, prompt = 0, cached = 0, output = 0] = bucket.values;
    return {
      ...bucket, requests, prompt, cached, output, total: prompt + output,
      key: String(bucket.startMs),
      label: usageBucketLabel(bucket.startMs, bucket.endMs, now, grouped.stepHours),
      valueText: `${usageTokens(prompt + output)} ${appCopy.composer.usage.tokens}`,
      segments: [{ id: "new", value: Math.max(0, prompt - cached) }, { id: "cache", value: cached }, { id: "output", value: output }],
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
