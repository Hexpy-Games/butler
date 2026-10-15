import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import type { UsageMonitorView } from "@/app/types";
import { Stack, Typo } from "@/butler-ds";
import { planLabel, quotaReasonLabel } from "./providerQuotaPresentation";
import { ProviderQuotaGauge } from "./ProviderQuotaGauge";
import { usageClock } from "../usage/usageTimeline";

type UsageProvider = UsageMonitorView["providerUsage"]["providers"][number];
export function UsageProviderRow({ provider }: { provider: UsageProvider }) {
  useAppLocale();
  const catalog = useButlerStore(store => store.modelCatalog);
  const name = catalog.providers.find(item => item.provider_id === provider.providerId)?.provider_label
    ?? catalog.models.find(item => item.provider_id === provider.providerId)?.provider_label
    ?? appCopy.settings.localModels.provider;
  const quota = provider.remaining;
  const displayName = quota.sourceKind === "codex_app_server" ? appCopy.composer.usage.codexProvider : name;
  const description = [displayName, planLabel(quota.planKind, quota.planName),
    quota.fetchedAt ? appCopy.composer.usage.checked(usageClock(Date.parse(quota.fetchedAt))) : null].filter(Boolean).join(" · ");
  if (!quota.available && quota.planKind === "api" && quota.reason?.code === "provider_quota_not_offered") {
    return <Typo.Caption>{name} · {appCopy.interfaceStatus.quotaApiPlan}</Typo.Caption>;
  }
  return <Stack gap="sm">
    <Typo.Caption>{description}</Typo.Caption>
    {quota.available ? quota.windows.map(window => <ProviderQuotaGauge key={window.id} window={window} />)
      : <Typo.Caption>{quotaReasonLabel(quota.reason?.code, quota.planKind)}</Typo.Caption>}
  </Stack>;
}
