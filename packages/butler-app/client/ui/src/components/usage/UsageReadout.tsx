import type { ReactNode } from "react";
import { appCopy, getAppLocale } from "@/app/copy";
import { AnimatedNumber, Inline, KeyValueRow, RollingSwap, Stack, Typo, SkeletonRows } from "@/butler-ds";
import type { UsageMonitorView } from "@/app/types";
import { usageReadout, usageSeries, usageTokens } from "./usageTimeline";

export function UsageReadout({ view, values, label, selected, showCost, delta, share, children, panel = false, unit }: {
  view: UsageMonitorView | null; values: ReturnType<typeof usageReadout>; label: string;
  selected: boolean; showCost: boolean; delta?: string; share?: string; children?: ReactNode; panel?: boolean; unit?: string;
}) {
  const copy = appCopy.composer.usage;
  const series = usageSeries();
  const tokens = [Math.max(0, values.prompt - values.cached), values.cached, values.output];
  const cacheRatio = values.prompt ? Math.round(values.cached / values.prompt * 100) : 0;
  const cost = view?.cost.available ? view.cost.estimatedUsd : null;
  const costText = cost === null ? "—" : new Intl.NumberFormat(getAppLocale(), { style: "currency", currency: "USD" }).format(cost);
  if (!view) return <Stack gap="sm"><SkeletonRows rows={2} label={copy.loading} />{children}</Stack>;
  return <Stack gap="sm" data-test-class="usage-readout">
    <Inline justify="between" gap="sm" wrap>
      <Typo.Caption><RollingSwap itemKey={label}>{label}</RollingSwap></Typo.Caption>
      <Typo.Caption numeric="tabular">{copy.requests(new Intl.NumberFormat(getAppLocale()).format(values.requests))}{unit ? ` · ${unit}` : ""}</Typo.Caption>
    </Inline>
    <Inline justify="between" cross="baseline" gap="sm" wrap>
      <Inline cross="baseline" gap="xs">
        <Typo.MetricValue numeric="tabular"><AnimatedNumber value={values.total} format={usageTokens} /></Typo.MetricValue>
        <Typo.Caption>{copy.tokens}</Typo.Caption>
      </Inline>
      {showCost && !selected && !panel ? <Typo.Caption>{costText} · {copy.estimate}</Typo.Caption> : null}
      {!selected && delta ? <Typo.Caption>{delta}</Typo.Caption> : null}
    </Inline>
    {children}
    <Stack align={panel ? "row" : "column"} gap={panel ? "lg" : "none"} wrap={panel}>
      {series.map((item, i) => <KeyValueRow key={item.id} valueTextSize="caption"
        swatchColor={`var(--context-${item.color})`} label={item.label}
        value={`${usageTokens(tokens[i]!)}${item.id === "cache" ? ` · ${cacheRatio}%` : ""}`} />)}
      {showCost && !selected && panel ? <KeyValueRow label={copy.estimatedCost} value={costText} valueTextSize="caption" /> : null}
      {!selected && share ? <KeyValueRow label={copy.share} value={share} valueTextSize="caption" /> : null}
    </Stack>
  </Stack>;
}
