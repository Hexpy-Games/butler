import type { ShowcaseRenderContext } from "../../showcase";
import { bucketUsageSlots, USAGE_SLOT_MS, type UsageBucketing, type UsageSlot } from "./usageBuckets";
import type { UsageBarsAxisLabel, UsageBarsBucket, UsageBarsSeries } from "./usageBarsTypes";

type AppLocale = ShowcaseRenderContext["locale"];

const copy = {
  "en-US": {
    newInput: "New input", cached: "Cached", output: "Output", chat: "Usage in this chat", period: "Usage by period",
    tokens: (value: string) => `${value} tokens`, justStarted: "Just started", noUsage: "No usage yet",
    noUsagePeriod: "No usage in this period", loading: "Loading usage", today: "Today", total: "Total", add: "Add a response",
    replay: "Replay", range: "Switch range",
  },
  "ko-KR": {
    newInput: "새 입력", cached: "캐시", output: "출력", chat: "이 대화의 사용량", period: "기간별 사용량",
    tokens: (value: string) => `${value} 토큰`, justStarted: "방금 시작", noUsage: "아직 사용량이 없습니다",
    noUsagePeriod: "이 기간에 사용량이 없습니다", loading: "사용량 불러오는 중", today: "오늘", total: "합계", add: "응답 추가",
    replay: "다시 재생", range: "기간 바꾸기",
  },
} as const;

export function usageCopy(locale: AppLocale) {
  return copy[locale];
}

export function usageSeries(locale: AppLocale): UsageBarsSeries[] {
  const text = copy[locale];
  return [
    { id: "new", color: "chart-1", label: text.newInput },
    { id: "cached", color: "chart-5", label: text.cached },
    { id: "output", color: "chart-2", label: text.output },
  ];
}

export function compactTokens(locale: AppLocale, value: number): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** 15:32 on Oct 15, 2026 (local), the sample "now". */
export const SAMPLE_NOW = new Date(2026, 9, 15, 15, 32).getTime();
const HOUR = 60 * 60 * 1000;

/** Deterministic 15-minute slots [start, new, cached, output] over `hours` before now, active in working hours. */
export function sampleSlots(hours: number, seed = 1): UsageSlot[] {
  const slots: UsageSlot[] = [];
  const first = SAMPLE_NOW - hours * HOUR;
  for (let start = first - (first % USAGE_SLOT_MS); start < SAMPLE_NOW; start += USAGE_SLOT_MS) {
    const hour = new Date(start).getHours();
    const index = Math.round((start - first) / USAGE_SLOT_MS);
    const wave = ((index * 37 + seed * 11) % 23) / 23;
    if (hour < 9 || hour > 22 || wave < 0.45) continue;
    const prompt = Math.round(40_000 + wave * 260_000);
    slots.push([start, Math.round(prompt * 0.12), Math.round(prompt * 0.88), Math.round(prompt * 0.03)]);
  }
  return slots;
}

export function toBuckets(locale: AppLocale, bucketing: UsageBucketing): UsageBarsBucket[] {
  const text = copy[locale];
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: bucketing.stepHours < 24 ? "numeric" : undefined });
  return bucketing.buckets.map((bucket) => {
    const [fresh = 0, cached = 0, output = 0] = bucket.values;
    return {
      key: `${bucket.startMs}`,
      segments: [{ id: "new", value: fresh }, { id: "cached", value: cached }, { id: "output", value: output }],
      label: date.format(bucket.startMs),
      valueText: text.tokens(compactTokens(locale, fresh + cached + output)),
    };
  });
}

/** Hourly: first and last hour. Sub-day steps: each midnight. Days: every 7th day back from the last. */
export function sampleAxisLabels(locale: AppLocale, bucketing: UsageBucketing): UsageBarsAxisLabel[] {
  const { buckets, stepHours } = bucketing;
  const hour = new Intl.DateTimeFormat(locale, { hour: "numeric" });
  const day = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" });
  if (buckets.length === 0) return [];
  if (stepHours === 1 && buckets.length <= 24) {
    const ends = buckets.length > 1 ? [0, buckets.length - 1] : [0];
    return ends.map((index) => ({ index, text: hour.format(buckets[index]!.startMs) }));
  }
  return buckets.flatMap((bucket, index) => {
    const start = new Date(bucket.startMs);
    const show = stepHours < 24 ? start.getHours() === 0 : (buckets.length - 1 - index) % 7 === 0;
    return show ? [{ index, text: index === buckets.length - 1 ? copy[locale].today : day.format(start) }] : [];
  });
}

/** `slots` bucketed over the `hours` before now (the usage tab's fixed window). */
export function windowChart(locale: AppLocale, slots: readonly UsageSlot[], hours: number, maxBars?: number) {
  const bucketing = bucketUsageSlots(slots, { fromMs: SAMPLE_NOW - hours * HOUR, toMs: SAMPLE_NOW, maxBars });
  return { bucketing, buckets: toBuckets(locale, bucketing), axisLabels: sampleAxisLabels(locale, bucketing) };
}

/** A ready-to-render sample: hours back from now, bucketed for `maxBars`. */
export function sampleChart(locale: AppLocale, hours: number, maxBars?: number, seed?: number) {
  return windowChart(locale, sampleSlots(hours, seed), hours, maxBars);
}

/** Chat usage since the chat's first slot (the popover case). */
export function chatChart(locale: AppLocale, slots: readonly UsageSlot[]) {
  const bucketing = bucketUsageSlots(slots, { toMs: SAMPLE_NOW });
  return { bucketing, buckets: toBuckets(locale, bucketing), axisLabels: sampleAxisLabels(locale, bucketing) };
}

/** Plain-number tick labels for the panel's gutter. */
export function tickFormat(locale: AppLocale) {
  return (value: number) => compactTokens(locale, value);
}
