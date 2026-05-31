import type { ContextUsageCategory } from "@/app/types.ts";
import { contextChartColor, formatTokenCount } from "./contextPanelUtils.ts";
import { KeyValueRow } from "@/butler-ds";

export function ContextCategoryRow({
  category,
  colorIndex,
  totalTokens,
}: {
  category: ContextUsageCategory;
  colorIndex: number;
  totalTokens: number;
}) {
  const ratio = totalTokens > 0 ? category.used_tokens / totalTokens : 0;
  return (
    <KeyValueRow
      label={category.label}
      description={category.safe_description}
      value={formatTokenCount(category.used_tokens)}
      meta={`${Math.round(ratio * 100)}%`}
      detailAlign="start"
      swatchColor={contextChartColor(colorIndex)}
      valueTextSize="caption"
    />
  );
}
