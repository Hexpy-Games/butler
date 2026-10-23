import { ChatGptPlanUsage } from "../chatgpt/ChatGptPlanUsage";
import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import type { UsageMonitorView } from "@/app/types";
import { Stack, Typo } from "@/butler-ds";
import { planLabel, quotaReasonLabel } from "./providerQuotaPresentation";
import { ProviderQuotaGauge } from "./ProviderQuotaGauge";
import { usageProviderName } from "../usage/usageProviderName";
import { usageClock } from "../usage/usageTimeline";

type UsageProvider = UsageMonitorView["providerUsage"]["providers"][number];
export function UsageProviderRow({ provider }: { provider: UsageProvider }) {
  useAppLocale();
  const catalog = useButlerStore(store => store.modelCatalog);
  const name = catalog.providers.find(item => item.provider_id === provider.providerId)?.provider_label
    ?? catalog.models.find(item => item.provider_id === provider.providerId)?.provider_label
    ?? usageProviderName(provider.providerId);
  const quota = provider.remaining;
  if (provider.providerId === "openai" && quota.planUsage) return <ChatGptPlanUsage quota={quota} usage={provider.butlerUsage} />;
  const displayName = quota.sourceKind === "chatgpt_plan" ? appCopy.composer.usage.chatgptProvider : name;
  const description = [displayName, quota.planKind !== "unknown" || quota.planName ? planLabel(quota.planKind, quota.planName) : null,
    quota.fetchedAt ? appCopy.composer.usage.checked(usageClock(Date.parse(quota.fetchedAt))) : null].filter(Boolean).join(" · ");
  if (!quota.available && quota.planKind === "api" && quota.reason?.code === "provider_quota_not_offered") {
    return <Typo.Caption>{name} · {appCopy.interfaceStatus.quotaApiPlan}</Typo.Caption>;
  }
  if (!quota.available) return <Typo.Caption>{description} · {quotaReasonLabel(quota.reason?.code, quota.planKind)}</Typo.Caption>;
  return <Stack gap="sm">
    <Typo.Caption>{description}</Typo.Caption>
    {quota.windows.map(window => <ProviderQuotaGauge key={window.id} window={window} />)}
  </Stack>;
}
