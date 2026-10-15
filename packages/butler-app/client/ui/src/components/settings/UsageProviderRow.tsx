import { appCopy, useAppLocale } from "@/app/copy";
import type { UsageMonitorView } from "@/app/types";
import { Stack, Typo } from "@/butler-ds";
import { planLabel, quotaReasonLabel } from "./providerQuotaPresentation";
import { ProviderQuotaGauge } from "./ProviderQuotaGauge";
import { usageClock } from "../usage/usageTimeline";

type UsageProvider = UsageMonitorView["providerUsage"]["providers"][number];
export function UsageProviderRow({ provider }: { provider: UsageProvider }) {
  useAppLocale();
  const quota = provider.remaining;
  const description = [provider.providerId, planLabel(quota.planKind, quota.planName),
    quota.fetchedAt ? appCopy.composer.usage.checked(usageClock(Date.parse(quota.fetchedAt))) : null].filter(Boolean).join(" · ");
  return <Stack gap="sm">
    <Typo.Caption>{description}</Typo.Caption>
    {quota.available ? quota.windows.map(window => <ProviderQuotaGauge key={window.id} window={window} />)
      : <Typo.Caption>{quotaReasonLabel(quota.reason?.code, quota.planKind)}</Typo.Caption>}
  </Stack>;
}
