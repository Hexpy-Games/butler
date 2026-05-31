import type { ChartConfig } from "@/butler-ds";
import type { ContextDetailsView } from "@/app/types.ts";

export interface ContextChartSegment {
  key: string;
  label: string;
  value: number;
  color: string;
  radius: [number, number, number, number];
}

export function buildContextChart(context: ContextDetailsView): {
  config: ChartConfig;
  data: Array<Record<string, number | string>>;
  segments: ContextChartSegment[];
} {
  const categories = [...context.categories]
    .filter((category) => category.used_tokens > 0)
    .sort((left, right) => right.used_tokens - left.used_tokens);
  const usedTokens = Math.max(0, context.used_tokens);
  const freeTokens = Math.max(0, context.budget_tokens - usedTokens);
  const categorySegments = categories.map((category, index) => ({
    key: `category_${index}`,
    label: category.label,
    value: category.used_tokens,
    color: contextChartColor(index),
    radius: [0, 0, 0, 0] as [number, number, number, number],
  }));
  const segments = [
    ...categorySegments,
    {
      key: "free",
      label: "Free context",
      value: freeTokens,
      color: "var(--context-chart-free)",
      radius: [0, 10, 10, 0] as [number, number, number, number],
    },
  ].filter((segment) => segment.value > 0);
  if (segments.length > 0) {
    segments[0].radius = [
      10,
      segments.length === 1 ? 10 : 0,
      segments.length === 1 ? 10 : 0,
      10,
    ];
  }
  const row = segments.reduce<Record<string, number | string>>(
    (accumulator, segment) => ({
      ...accumulator,
      [segment.key]: segment.value,
    }),
    { name: "Context" },
  );
  const config = segments.reduce<ChartConfig>((accumulator, segment) => {
    accumulator[segment.key] = {
      color: segment.color,
      label: segment.label,
    };
    return accumulator;
  }, {});

  return {
    config,
    data: [row],
    segments,
  };
}

export function contextChartColor(index: number): string {
  return `var(--context-chart-${(index % 6) + 1})`;
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return tokens.toLocaleString();
}
