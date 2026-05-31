import { appCopy } from "@/app/copy.ts";
import type { UsageMonitorView } from "@/app/types.ts";
import { Stack, SurfacePanel, Typo } from "@/butler-ds";
import { formatCompact, formatCount } from "./usageSettingsFormat";

type UsageProvider =
  UsageMonitorView["providerUsage"]["providers"][number];

export function UsageProviderPanel({
  activeProviderId,
  providers,
}: {
  activeProviderId: string | null;
  providers: UsageProvider[];
}) {
  return (
    <SurfacePanel elevation="none">
      <Stack gap="md">
        <Stack align="row" justify="between" cross="start" gap="md" wrap>
          <Stack gap="xs" style={{ minWidth: 0, flex: "1 1 260px" }}>
            <Typo.Body as="div">API 프로바이더 사용량</Typo.Body>
            <Typo.Caption>
              {activeProviderId
                ? `현재 기준: ${activeProviderId}`
                : appCopy.settings.descriptions.usageMonitorEmpty}
            </Typo.Caption>
          </Stack>
          <Typo.Body as="div" style={{ textAlign: "right" }}>
            {formatCount(providers.length)}
          </Typo.Body>
        </Stack>
        {providers.length === 0 ? (
          <Typo.Caption>
            {appCopy.settings.descriptions.usageMonitorEmpty}
          </Typo.Caption>
        ) : (
          <Stack gap="xs">
            {providers.map((provider, index) => (
              <ProviderRow
                key={provider.providerId}
                provider={provider}
                divider={index > 0}
              />
            ))}
          </Stack>
        )}
      </Stack>
    </SurfacePanel>
  );
}

function ProviderRow({
  provider,
  divider,
}: {
  provider: UsageProvider;
  divider: boolean;
}) {
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
            : "로컬 텔레메트리"}{" "}
          · 요청 {formatCount(provider.requestCount)} · 입력{" "}
          {formatCompact(provider.promptTokens)} · 출력{" "}
          {formatCompact(provider.outputTokens)}
        </Typo.Caption>
        <Typo.Caption>
          잔여량:{" "}
          {provider.remaining.available ? "확인됨" : provider.remaining.reason}
        </Typo.Caption>
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
