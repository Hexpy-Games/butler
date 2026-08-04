import type { ChartConfig } from "@/butler-ds";
import type { ContextDetailsView } from "@/app/types.ts";

export interface ContextChartSegment {
  key: string;
  label: string;
  category_id?: string;
  value: number;
  color: string;
  radius: [number, number, number, number];
}

const RESERVED_CONTEXT_SOURCE_KINDS = new Set([
  "output_reserve",
  "tool_reserve",
  "compaction_reserve",
]);

function isReservedContextCategory(
  category: ContextDetailsView["categories"][number],
): boolean {
  return RESERVED_CONTEXT_SOURCE_KINDS.has(category.source_kind ?? "");
}

export function buildContextChart(context: ContextDetailsView): {
  config: ChartConfig;
  data: Array<Record<string, number | string>>;
  segments: ContextChartSegment[];
} {
  const categories = [...context.categories]
    .filter((category) => !isReservedContextCategory(category))
    .sort((left, right) => right.used_tokens - left.used_tokens);
  const budgetTokens = Number.isFinite(context.budget_tokens)
    ? Math.max(0, Math.round(context.budget_tokens))
    : 0;
  const usedTokens = Number.isFinite(context.used_tokens)
    ? Math.max(0, context.used_tokens)
    : 0;
  let remainingOccupiedTokens = Math.min(budgetTokens, usedTokens);
  const categorySegments = categories.flatMap((category, index) => {
    const categoryTokens = Number.isFinite(category.used_tokens)
      ? Math.max(0, category.used_tokens)
      : 0;
    const value = Math.min(categoryTokens, remainingOccupiedTokens);
    remainingOccupiedTokens -= value;
    return value > 0
      ? [
          {
            key: `category_${index}`,
            label: category.label,
            category_id: category.id,
            value,
            color: contextChartColor(index),
            radius: [0, 0, 0, 0] as [number, number, number, number],
          },
        ]
      : [];
  });
  const occupiedTokens = categorySegments.reduce(
    (sum, segment) => sum + segment.value,
    0,
  );
  const freeTokens = Math.max(0, budgetTokens - occupiedTokens);
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
