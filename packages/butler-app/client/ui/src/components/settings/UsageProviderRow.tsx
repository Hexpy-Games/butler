import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type {
  ProviderQuotaResultView,
  UsageMonitorView,
} from "@/app/types.ts";
import { MetaList, Stack, Typo } from "@/butler-ds";
import {
  formatQuotaTimestamp,
  planLabel,
  quotaReasonLabel,
  sourceLabel,
} from "./providerQuotaPresentation";
import { ProviderQuotaGauge } from "./ProviderQuotaGauge";
import { formatCompact, formatCount } from "./usageSettingsFormat";

type UsageProvider = UsageMonitorView["providerUsage"]["providers"][number];

export function UsageProviderRow({ provider }: { provider: UsageProvider }) {
  useAppLocale();
  const quota = provider.remaining;
  return (
    <Stack align="row" justify="between" cross="start" gap="md" wrap>
      <Stack gap="xs" grow basis="md" minWidth="0">
        <Typo.Body as="div">{provider.providerId}</Typo.Body>
        <MetaList items={[
          { value: provider.source === "provider_adapter"
            ? appCopy.interfaceStatus.providerAdapter
            : appCopy.interfaceStatus.localTelemetry },
          { label: appCopy.interfaceDetails.requestsLabel, value: formatCount(provider.requestCount) },
          { label: appCopy.interfaceDetails.inputLabel, value: formatCompact(provider.promptTokens) },
          { label: appCopy.interfaceDetails.outputLabel, value: formatCompact(provider.outputTokens) },
        ]} />
        {quota.available && quota.stale ? (
          <Typo.Caption>{appCopy.interfaceStatus.staleQuota}</Typo.Caption>
        ) : null}
        {!quota.available ? (
          <MetaList items={[{ label: appCopy.interfaceDetails.quotaLabel, value: quotaReasonLabel(quota.reason?.code, quota.planKind) }]} />
        ) : null}
        {renderQuotaDetails(quota)}
        <MetaList items={[{
          label: appCopy.interfaceDetails.billingLabel,
          value: provider.billing.available ? appCopy.interfaceStatus.confirmed : provider.billing.reason,
        }]} />
      </Stack>
      <Typo.Body as="div" align="end" numeric="tabular" wrap="nowrap">
        {formatCompact(provider.totalTokens)}
      </Typo.Body>
    </Stack>
  );
}

function renderQuotaDetails(quota: ProviderQuotaResultView) {
  if (!quota.available) return null;
  return (
    <Stack gap="xs">
      <MetaList items={[
        { label: appCopy.interfaceDetails.planLabel, value: planLabel(quota.planKind, quota.planName) },
        { label: appCopy.interfaceDetails.sourceLabel, value: sourceLabel(quota.sourceKind) },
      ]} />
      <MetaList items={[
        {
          label: appCopy.interfaceDetails.fetchedLabel,
          value: quota.fetchedAt ? formatQuotaTimestamp(quota.fetchedAt) : appCopy.interfaceStatus.unknown,
        },
        ...(quota.stale && quota.reason ? [{ value: quotaReasonLabel(quota.reason.code) }] : []),
      ]} />
      {quota.windows.map((window) => (
        <ProviderQuotaGauge key={window.id} window={window} />
      ))}
    </Stack>
  );
}
