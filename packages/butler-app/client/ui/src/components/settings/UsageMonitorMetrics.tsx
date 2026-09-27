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
        value={model?.requestCount ?? 0} format={formatCompact}
        label={appCopy.interfaceStatus.modelRequests}
      />
      <MetricCard
        value={model?.promptTokens ?? 0} format={formatCompact}
        label={appCopy.interfaceStatus.inputTokens}
      />
      <MetricCard
        value={model?.cachedTokens ?? 0} format={formatCompact}
        label={appCopy.interfaceStatus.cachedInput}
        change={formatPercent(model?.cacheHitRatio ?? 0)}
        trend="neutral"
      />
      <MetricCard
        value={model?.uncachedTokens ?? 0} format={formatCompact}
        label={appCopy.interfaceStatus.uncachedInput}
      />
      <MetricCard
        value={model?.outputTokens ?? 0} format={formatCompact}
        label={appCopy.interfaceStatus.outputTokens}
      />
      <MetricCard
        value={webSearch?.requestCount ?? 0} format={formatCompact}
        label={appCopy.interfaceStatus.webSearch}
        change={webSearch?.lastProvider ?? undefined}
        trend="neutral"
      />
      <MetricCard
        value={tools?.calls ?? 0} format={formatCompact}
        label={appCopy.interfaceStatus.toolCalls}
        change={`${formatCount(tools?.successes ?? 0)} ok · ${formatCount(tools?.failures ?? 0)} fail`}
        trend="neutral"
      />
      <MetricCard
        value={model?.totalTokens ?? 0} format={formatCompact}
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
