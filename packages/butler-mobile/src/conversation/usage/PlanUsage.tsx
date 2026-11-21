import { View } from "react-native";
import { getAppCopy } from "../../../../butler-i18n/src/index.ts";
import { compactTokens } from "../../../../butler-app/client/ui/src/components/usage/compactTokens.ts";
import { Text, useTokens } from "@/ds";
import { useAppLocale } from "@/i18n";
import { usageTime, type QuotaSummary } from "./usageView";

export function PlanUsage({ summary }: { summary: QuotaSummary }) {
  const t = useTokens();
  const locale = useAppLocale();
  const copy = getAppCopy(locale);
  const { plan, windows, state, updatedLabel, butlerUsage } = summary;
  const limit = plan?.planUsage?.state === "limit_reached";
  const labels = { hours_5: copy.chatgptPlan.usageWindow5h, days_7: copy.chatgptPlan.usageWindow7d, days_30: copy.chatgptPlan.usageWindow30d };
  const row = { flexDirection: "row", justifyContent: "space-between", gap: t.length("--space-2") } as const;
  return <View style={{ gap: t.length("--space-2") }}>
    {limit ? <Text variant="caption" tone="danger">{copy.chatgptPlan.limitReached}
      {plan?.planUsage?.resetsAt ? ` · ${copy.chatgptPlan.resetsAt(usageTime(plan.planUsage.resetsAt, locale))}` : ""}</Text> : null}
    <Text variant="caption">{copy.composer.usage.accountLimits}</Text>
    {state === "ready" ? windows.map(window => <View key={window.id} style={{ gap: t.length("--space-1") }}>
      <View style={row}>
        <Text variant="caption">{window.label}</Text>
        <Text variant="caption" numeric="tabular">{window.remainingPercent === null ? "—" : copy.composer.usage.left(`${Math.round(Math.max(0, Math.min(100, window.remainingPercent)))}%`)}</Text>
      </View>
      {window.caption ? <Text variant="caption" tone="tertiary">{window.caption}</Text> : null}
    </View>) : <Text variant="caption">{state === "loading" ? copy.composer.usage.loading : copy.composer.usage.unavailable}</Text>}
    {!plan && updatedLabel ? <Text variant="caption" tone="tertiary">{updatedLabel}</Text> : null}
    {plan ? <>
      <View style={{ height: t.length("--border-hairline"), backgroundColor: t.color("--line") }} />
      <Text variant="caption">{copy.chatgptPlan.butlerUsage}</Text>
      {(["hours_5", "days_7", "days_30"] as const).map(id => {
        const total = butlerUsage?.windows.find(window => window.id === id)?.totalTokens;
        return <View key={id} style={row}>
          <Text variant="caption">{labels[id]}</Text>
          <Text variant="caption" numeric="tabular">{`${total === undefined ? "—" : compactTokens(total, locale)} ${copy.composer.usage.tokens}`}</Text>
        </View>;
      })}
    </> : null}
  </View>;
}
