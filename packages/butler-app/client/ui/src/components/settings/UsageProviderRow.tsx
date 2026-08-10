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
            ? "프로바이더 어댑터"
            : "로컬 텔레메트리"} {" "}
          · 요청 {formatCount(provider.requestCount)} · 입력{" "}
          {formatCompact(provider.promptTokens)} · 출력{" "}
          {formatCompact(provider.outputTokens)}
        </Typo.Caption>
        {quota.available && quota.stale ? (
          <Typo.Caption>잔여량: 이전 확인값(새로고침 실패)</Typo.Caption>
        ) : null}
        {!quota.available ? (
          <Typo.Caption>잔여량: {quotaReasonLabel(quota.reason?.code)}</Typo.Caption>
        ) : null}
        {renderQuotaDetails(quota)}
        <Typo.Caption>
          과금: {provider.billing.available ? "확인됨" : provider.billing.reason}
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
        플랜: {planLabel(quota.planKind, quota.planName)} · 출처: {sourceLabel(quota.sourceKind)}
      </Typo.Caption>
      <Typo.Caption>
        조회 시각: {quota.fetchedAt ? formatQuotaTimestamp(quota.fetchedAt) : "미확인"}
        {quota.stale ? ` · ${quotaReasonLabel(quota.reason?.code)}` : ""}
      </Typo.Caption>
      {quota.windows.map((window) => (
        <ProviderQuotaGauge key={window.id} window={window} />
      ))}
    </Stack>
  );
}
