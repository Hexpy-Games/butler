import type { UsageMonitorView, UsageTokenBucketView } from "@/app/types.ts";
import { MetricCard, MetricGrid } from "@/butler-ds";
import { formatCompact, formatCount, formatPercent } from "./usageSettingsFormat";

export function UsageMonitorMetrics({ view }: { view: UsageMonitorView | null }) {
  const model = view?.model;
  const webSearch = view?.webSearch;
  const tools = view?.tools;

  return (
    <MetricGrid>
      <MetricCard
        value={formatCompact(model?.requestCount ?? 0)}
        label="모델 요청"
      />
      <MetricCard
        value={formatCompact(model?.promptTokens ?? 0)}
        label="입력 토큰"
      />
      <MetricCard
        value={formatCompact(model?.cachedTokens ?? 0)}
        label="캐시 입력"
        change={formatPercent(model?.cacheHitRatio ?? 0)}
        trend="neutral"
      />
      <MetricCard
        value={formatCompact(model?.uncachedTokens ?? 0)}
        label="비캐시 입력"
      />
      <MetricCard
        value={formatCompact(model?.outputTokens ?? 0)}
        label="출력 토큰"
      />
      <MetricCard
        value={formatCompact(webSearch?.requestCount ?? 0)}
        label="웹 검색"
        change={webSearch?.lastProvider ?? undefined}
        trend="neutral"
      />
      <MetricCard
        value={formatCompact(tools?.calls ?? 0)}
        label="도구 호출"
        change={`${formatCount(tools?.successes ?? 0)} ok · ${formatCount(tools?.failures ?? 0)} fail`}
        trend="neutral"
      />
      <MetricCard
        value={formatCompact(model?.totalTokens ?? 0)}
        label="총 토큰"
        change={formatMissingTotals(model)}
        trend="neutral"
      />
    </MetricGrid>
  );
}

function formatMissingTotals(
  model?: UsageTokenBucketView | null,
): string | undefined {
  if (!model?.missingTotalTokenCount) return undefined;
  return `${formatCount(model.missingTotalTokenCount)} total unknown`;
}
