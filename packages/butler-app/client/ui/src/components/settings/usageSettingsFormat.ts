import type { UsageTokenBucketView } from "@/app/types.ts";

export interface UsageNamedBucket {
  name: string;
  bucket: UsageTokenBucketView;
}

const numberFormatter = new Intl.NumberFormat(undefined);
const compactFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const percentFormatter = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});

export function formatCount(value: number): string {
  return numberFormatter.format(value);
}

export function formatCompact(value: number): string {
  return compactFormatter.format(value);
}

export function formatPercent(value: number): string {
  return percentFormatter.format(value);
}

export function usageRows(
  buckets: Record<string, UsageTokenBucketView>,
  limit = 8,
): UsageNamedBucket[] {
  return Object.entries(buckets)
    .map(([name, bucket]) => ({ name, bucket }))
    .sort((left, right) =>
      right.bucket.totalTokens - left.bucket.totalTokens ||
      right.bucket.promptTokens - left.bucket.promptTokens ||
      left.name.localeCompare(right.name),
    )
    .slice(0, limit);
}

export function formatTimestamp(value?: string): string {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return "";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}
