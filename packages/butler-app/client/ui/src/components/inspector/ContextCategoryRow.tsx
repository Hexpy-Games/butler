import type { ContextUsageCategory } from "@/app/types.ts";
import { formatTokenCount } from "./contextPanelUtils.ts";
import { KeyValueRow } from "@/butler-ds";

export function ContextCategoryRow({
  category,
  swatchColor,
  totalTokens,
}: {
  category: ContextUsageCategory;
  swatchColor?: string;
  totalTokens: number;
}) {
  const ratio =
    totalTokens > 0
      ? Math.max(0, Math.min(1, category.used_tokens / totalTokens))
      : 0;
  return (
    <KeyValueRow
      label={category.label}
      description={category.safe_description}
      value={formatTokenCount(category.used_tokens)}
      meta={`${Math.round(ratio * 100)}%`}
      detailAlign="start"
      {...(swatchColor ? { swatchColor } : {})}
      valueTextSize="caption"
    />
  );
}
