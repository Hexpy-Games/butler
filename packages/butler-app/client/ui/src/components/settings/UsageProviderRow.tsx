import { useEffect, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import type { ProviderQuotaResultView, UsageMonitorView } from "@/app/types";
import { Box, Inline, KeyValueRow, Stack, Tag, Tooltip, Typo } from "@/butler-ds";
import { planLabel } from "./providerQuotaPresentation";
import { ProviderQuotaGauge } from "./ProviderQuotaGauge";
import { ProviderMark } from "./ProviderMark";
import { compactTokens } from "../usage/compactTokens";
import { usageProviderName } from "../usage/usageProviderName";

type UsageProvider = UsageMonitorView["providerUsage"]["providers"][number];

function useLastQuota(quota: ProviderQuotaResultView) {
  const [last, setLast] = useState<ProviderQuotaResultView | null>(null);
  useEffect(() => { if (quota.available && !quota.stale) setLast(quota); }, [quota]);
  return { ...quota, windows: quota.windows.length ? quota.windows : last?.windows ?? [],
    fetchedAt: quota.fetchedAt ?? last?.fetchedAt ?? null };
}

export function UsageProviderRow({ provider }: { provider: UsageProvider }) {
  const locale = useAppLocale();
  const copy = appCopy.composer.usage;
  const catalog = useButlerStore(store => store.modelCatalog);
  const name = catalog.providers.find(item => item.provider_id === provider.providerId)?.provider_label
    ?? catalog.models.find(item => item.provider_id === provider.providerId)?.provider_label
    ?? usageProviderName(provider.providerId);
  const quota = useLastQuota(provider.remaining);
  const payAsYouGo = quota.planKind === "api" && quota.reason?.code === "provider_quota_not_offered";
  const failed = quota.stale || (!quota.available && !payAsYouGo);
  const timestamp = quota.fetchedAt ? Date.parse(quota.fetchedAt) : NaN;
  const age = Number.isFinite(timestamp) ? copy.elapsedMinutes(Math.max(0, Math.floor((Date.now() - timestamp) / 60000))) : null;
  const checked = age ? failed ? copy.refreshFailedStale(age) : copy.checkedAgo(age) : null;
  const windows = quota.planUsage?.state === "limit_reached" && !quota.windows.length
    ? [{ id: "individualLimit", remainingPercent: 0, usedPercent: 100, windowDurationMins: null, resetsAt: quota.planUsage.resetsAt, expiresAt: null }]
    : quota.windows;
  return <Box border="hairline" radius="control" padding="md" data-test-class="usage-provider" data-provider={provider.providerId}>
    <Stack gap="md">
      <Stack gap="xs">
        <Inline cross="center" gap="sm" wrap>
          <ProviderMark providerId={provider.providerId} besideProviderName />
          <Typo.Body>{name}</Typo.Body>
          <Tag>{payAsYouGo ? copy.payAsYouGo : planLabel(quota.planKind, quota.planName)}</Tag>
          {quota.sourceKind === "chatgpt_plan" ? <Tooltip label={appCopy.chatgptPlan.estimateHint}><Tag>{copy.estimated}</Tag></Tooltip> : null}
        </Inline>
        {checked ? <Typo.Caption>{checked}</Typo.Caption> : null}
      </Stack>
      <Box data-stale={failed || undefined}>
        {payAsYouGo ? <KeyValueRow label={copy.thisMonth} value={compactTokens(provider.monthTokens ?? 0, locale)} valueTextSize="caption" />
          : <Stack gap="md">{windows.map(window => <ProviderQuotaGauge key={window.id} window={window} layout="usage" stale={failed} />)}</Stack>}
      </Box>
    </Stack>
  </Box>;
}
