import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type {
  ProviderQuotaResultView,
  UsageMonitorView,
} from "@/app/types.ts";
import { Stack, Typo } from "@/butler-ds";
import {
  formatQuotaTimestamp,
  planLabel,
  quotaReasonLabel,
  sourceLabel,
} from "./providerQuotaPresentation";
import { ProviderQuotaGauge } from "./ProviderQuotaGauge";
import { formatCompact, formatCount } from "./usageSettingsFormat";

type UsageProvider = UsageMonitorView["providerUsage"]["providers"][number];

export function UsageProviderRow({
  provider,
  divider,
}: {
  provider: UsageProvider;
  divider: boolean;
}) {
  useAppLocale();
  const quota = provider.remaining;
  return (
    <Stack
      align="row"
      justify="between"
      cross="start"
      gap="md"
      wrap
      style={{
        paddingBlock: "var(--space-sm)",
        borderTop: divider ? "1px solid var(--line)" : 0,
      }}
    >
      <Stack gap="xs" style={{ minWidth: 0, flex: "1 1 280px" }}>
        <Typo.Body as="div">{provider.providerId}</Typo.Body>
        <Typo.Caption>
          {provider.source === "provider_adapter"
            ? appCopy.interfaceStatus.providerAdapter
            : appCopy.interfaceStatus.localTelemetry} {" "}
          {appCopy.interfaceDetails.requestsLabel}{formatCount(provider.requestCount)} {appCopy.interfaceDetails.inputLabel}{" "}
          {formatCompact(provider.promptTokens)} {appCopy.interfaceDetails.outputLabel}{" "}
          {formatCompact(provider.outputTokens)}
        </Typo.Caption>
        {quota.available && quota.stale ? (
          <Typo.Caption>{appCopy.interfaceStatus.staleQuota}</Typo.Caption>
        ) : null}
        {!quota.available ? (
          <Typo.Caption>{appCopy.interfaceDetails.quotaLabel}{quotaReasonLabel(quota.reason?.code)}</Typo.Caption>
        ) : null}
        {renderQuotaDetails(quota)}
        <Typo.Caption>
          {appCopy.interfaceDetails.billingLabel}{provider.billing.available ? appCopy.interfaceStatus.confirmed : provider.billing.reason}
        </Typo.Caption>
      </Stack>
      <Typo.Body
        as="div"
        style={{ textAlign: "right", whiteSpace: "nowrap" }}
      >
        {formatCompact(provider.totalTokens)}
      </Typo.Body>
    </Stack>
  );
}

function renderQuotaDetails(quota: ProviderQuotaResultView) {
  if (!quota.available) return null;
  return (
    <Stack gap="xs">
      <Typo.Caption>
        {appCopy.interfaceDetails.planLabel}{planLabel(quota.planKind, quota.planName)} {appCopy.interfaceDetails.sourceLabel}{sourceLabel(quota.sourceKind)}
      </Typo.Caption>
      <Typo.Caption>
        {appCopy.interfaceDetails.fetchedLabel}{quota.fetchedAt ? formatQuotaTimestamp(quota.fetchedAt) : appCopy.interfaceStatus.unknown}
        {quota.stale ? ` · ${quotaReasonLabel(quota.reason?.code)}` : ""}
      </Typo.Caption>
      {quota.windows.map((window) => (
        <ProviderQuotaGauge key={window.id} window={window} />
      ))}
    </Stack>
  );
}
