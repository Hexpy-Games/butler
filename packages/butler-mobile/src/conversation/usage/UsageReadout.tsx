import { View } from "react-native";
import { getAppCopy } from "../../../../butler-i18n/src/index.ts";
import type { UsageMonitorView } from "../../../../butler-protocol/src/index.ts";
import { compactTokens } from "../../../../butler-app/client/ui/src/components/usage/compactTokens.ts";
import { Text, UsageBars, useTokens, type UsageBarsProps } from "@/ds";
import { PILL } from "../../design/tokens";
import { useAppLocale } from "@/i18n";
import { usageClock, usageParts, usageReadout, type usageTimeline, type ConversationUsageStatus, type UsageAuthMode } from "./usageView";

export function UsageReadout({ view, status, mode, timeline, selected, onSelect }: {
  view: UsageMonitorView | null; status: ConversationUsageStatus; mode: UsageAuthMode;
  timeline: ReturnType<typeof usageTimeline>; selected: number | null; onSelect(index: number | null): void;
}) {
  const t = useTokens();
  const locale = useAppLocale();
  const appCopy = getAppCopy(locale), copy = appCopy.composer.usage;
  const bucket = selected === null ? undefined : timeline.buckets[selected];
  const values = usageReadout(view, bucket);
  const parts = usageParts(view, appCopy, locale, bucket);
  const series: UsageBarsProps["series"] = [
    { id: "new", color: "--context-chart-1" }, { id: "cache", color: "--context-chart-5" }, { id: "output", color: "--context-chart-2" },
  ];
  const tokens = [Math.max(0, values.prompt - values.cached), values.cached, values.output];
  const labels = [copy.newInput, copy.cached, copy.output];
  const ratio = values.prompt ? Math.round(values.cached / values.prompt * 100) : 0;
  const cost = view?.cost.available ? view.cost.estimatedUsd : null;
  const costText = !cost ? "—" : cost < 0.01 ? copy.tinyCost
    : new Intl.NumberFormat(locale, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol" }).format(cost);
  const label = bucket?.label ?? copy.thisChat;
  const stack = { gap: t.length("--space-2") };
  const row = { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: t.length("--space-2") } as const;
  const bars = <UsageBars {...timeline} series={series} selectedIndex={selected} onSelect={onSelect}
    state={!view ? "loading" : "ready"} emptyLabel={copy.noUsage} loadingLabel={copy.loading}
    note={timeline.buckets.length === 1 ? copy.justStarted : undefined} accessibilityLabel={copy.chartLabel} />;
  if (!view && status === "failed") return <View style={stack}>
    <Text variant="caption">{copy.thisChat}</Text><Text variant="caption">{copy.unavailable}</Text>
  </View>;
  if (view && !bucket && values.requests === 0 && values.total === 0) return <View style={stack}>
    <Text variant="caption">{label}</Text>{bars}
  </View>;
  return <View style={stack}>
    <View style={row}>
      <Text variant="caption">{label}</Text>
      <Text variant="caption" numeric="tabular">{view ? copy.requests(new Intl.NumberFormat(locale).format(values.requests)) : "—"}
        {timeline.stepHours > 1 ? ` · ${copy.bucketUnit(timeline.stepHours)}` : ""}</Text>
    </View>
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: t.length("--space-xs") }}>
      <Text variant="h2" numeric="tabular">{view ? compactTokens(values.total, locale) : "—"}</Text>
      <Text variant="caption">{copy.tokens}</Text>
    </View>
    {mode === "api_key" && !bucket ? <Text variant="caption">{costText} · {copy.estimate}</Text> : null}
    {status === "failed" && view ? <Text variant="caption">{copy.updated(usageClock(Date.parse(view.generated_at), locale))}</Text> : null}
    {bars}
    {series.map((item, index) => <View key={item.id} style={row}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.length("--space-2") }}>
        <View style={{ width: t.length("--space-2"), height: t.length("--space-2"), borderRadius: t.length(PILL), backgroundColor: t.color(item.color) }} />
        <Text variant="caption">{labels[index]}</Text>
      </View>
      <Text variant="caption" numeric="tabular">{view ? `${compactTokens(tokens[index], locale)}${item.id === "cache" ? ` · ${ratio}%` : ""}` : "—"}</Text>
    </View>)}
    {parts?.map(part => <View key={part.id} style={row}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.length("--space-2") }}>
        <View style={{ width: t.length("--space-2"), height: t.length("--space-2"), borderRadius: t.length(PILL),
          backgroundColor: t.color("--context-chart-5"), opacity: part.emphasis === "subtask" ? 0.5 : 1 }} />
        <Text variant="caption">{part.label}</Text>
      </View>
      <Text variant="caption" numeric="tabular">{part.value}</Text>
    </View>)}
  </View>;
}
