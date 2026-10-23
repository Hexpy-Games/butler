import { appCopy, useAppLocale } from "@/app/copy";
import type { ButlerUsageView, ProviderQuotaResultView } from "@/app/types";
import { Button, formatUsageTokens, KeyValueRow, ProviderLogo, Separator, Stack, Typo } from "@/butler-ds";
import { ProviderQuotaGauge } from "../settings/ProviderQuotaGauge";
import { formatQuotaTimestamp } from "../settings/providerQuotaPresentation";
import { manageChatGptUsage } from "./chatGptActions";
export function ManageChatGptUsage() {
  return <Button size="sm" variant="inline" onClick={manageChatGptUsage}>{appCopy.chatgptPlan.manageUsage}</Button>;
}
export function ChatGptPlanUsage({ quota, usage, popover = false }: {
  quota: ProviderQuotaResultView; usage?: ButlerUsageView | null; popover?: boolean;
}) {
  const locale = useAppLocale(), copy = appCopy.chatgptPlan;
  const limit = quota.planUsage?.state === "limit_reached";
  const windows = limit ? [] : quota.windows;
  const labels = { hours_5: copy.usageWindow5h, days_7: copy.usageWindow7d, days_30: copy.usageWindow30d };
  return <Stack gap="sm" data-test-class="chatgpt-plan-usage">
    {limit || !popover ? <Stack align="row" cross="center" justify="between" gap="sm" wrap>
      <Stack align="row" cross="center" gap="xs">
        <ProviderLogo name="openai" size="sm" />
        <Typo.Caption tone={limit ? "danger" : "secondary"}>{limit ? copy.limitReached : copy.usingPlan}
          {limit && quota.planUsage?.resetsAt ? ` · ${copy.resetsAt(formatQuotaTimestamp(quota.planUsage.resetsAt))}` : ""}</Typo.Caption>
      </Stack>
      {limit ? <ManageChatGptUsage /> : null}
    </Stack> : null}
    {windows.length ? <Stack gap="sm">
      {popover ? <Typo.Caption>{appCopy.composer.usage.accountLimits}</Typo.Caption> : null}
      {windows.map(window => <ProviderQuotaGauge key={window.id} window={window} estimated estimateTooltip={!popover} />)}
    </Stack> : null}
    {popover && windows.length ? <Separator /> : null}
    <Stack gap="xs">
      <Stack align="row" justify="between" cross="center" gap="sm">
        <Typo.Caption>{copy.butlerUsage}</Typo.Caption>{!limit ? <ManageChatGptUsage /> : null}
      </Stack>
      {(["hours_5", "days_7", "days_30"] as const).map(id => {
        const total = usage?.windows.find(window => window.id === id)?.totalTokens;
        return <KeyValueRow key={id} label={labels[id]} value={`${total === undefined ? "—" : formatUsageTokens(total, locale)} ${appCopy.composer.usage.tokens}`} valueTextSize="caption" />;
      })}
    </Stack>
  </Stack>;
}
