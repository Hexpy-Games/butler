import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { UsageMonitorView, UsageTokenBucketView } from "@/app/types.ts";
import { MetricCard, MetricGrid } from "@/butler-ds";
import { formatCompact, formatCount, formatPercent } from "./usageSettingsFormat";

export function UsageMonitorMetrics({ view }: { view: UsageMonitorView | null }) {
  useAppLocale();
  const model = view?.model;
  const webSearch = view?.webSearch;
  const tools = view?.tools;

  return (
    <MetricGrid>
      <MetricCard
        value={formatCompact(model?.requestCount ?? 0)}
        label={appCopy.interfaceStatus.modelRequests}
      />
      <MetricCard
        value={formatCompact(model?.promptTokens ?? 0)}
        label={appCopy.interfaceStatus.inputTokens}
      />
      <MetricCard
        value={formatCompact(model?.cachedTokens ?? 0)}
        label={appCopy.interfaceStatus.cachedInput}
        change={formatPercent(model?.cacheHitRatio ?? 0)}
        trend="neutral"
      />
      <MetricCard
        value={formatCompact(model?.uncachedTokens ?? 0)}
        label={appCopy.interfaceStatus.uncachedInput}
      />
      <MetricCard
        value={formatCompact(model?.outputTokens ?? 0)}
        label={appCopy.interfaceStatus.outputTokens}
      />
      <MetricCard
        value={formatCompact(webSearch?.requestCount ?? 0)}
        label={appCopy.interfaceStatus.webSearch}
        change={webSearch?.lastProvider ?? undefined}
        trend="neutral"
      />
      <MetricCard
        value={formatCompact(tools?.calls ?? 0)}
        label={appCopy.interfaceStatus.toolCalls}
        change={`${formatCount(tools?.successes ?? 0)} ok · ${formatCount(tools?.failures ?? 0)} fail`}
        trend="neutral"
      />
      <MetricCard
        value={formatCompact(model?.totalTokens ?? 0)}
        label={appCopy.interfaceStatus.totalTokens}
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
