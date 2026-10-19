import type { ReactNode } from "react";
import { appCopy, getAppLocale } from "@/app/copy";
import { AnimatedNumber, Collapsible, Inline, KeyValueRow, Stack, Typo, Skeleton } from "@/butler-ds";
import type { UsageMonitorView } from "@/app/types";
import { usageClock, usageReadout, usageSeries, usageTokens } from "./usageTimeline";

export function UsageReadout({ view, values, label, selected, showCost, delta, share, parts, children, panel = false, unit, stale = false }: {
  view: UsageMonitorView | null; values: ReturnType<typeof usageReadout>; label: string;
  selected: boolean; showCost: boolean; delta?: string; share?: string; children?: ReactNode; panel?: boolean; unit?: string; stale?: boolean;
  /** The total's split by who made the calls; shown only when work was delegated. */
  parts?: { id: string; label: string; value: string }[] | null;
}) {
  const copy = appCopy.composer.usage;
  const series = usageSeries();
  const tokens = [Math.max(0, values.prompt - values.cached), values.cached, values.output];
  const cacheRatio = values.prompt ? Math.round(values.cached / values.prompt * 100) : 0;
  const cost = view?.cost.available ? view.cost.estimatedUsd : null;
  const costText = !cost ? "—" : cost < 0.01 ? copy.tinyCost : new Intl.NumberFormat(getAppLocale(), { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol" }).format(cost);
  if (view && !panel && !selected && values.total === 0 && values.requests === 0) {
    return <Stack gap="sm"><Typo.Caption>{label}</Typo.Caption>{children}</Stack>;
  }
  return <Stack gap="sm" data-test-class="usage-readout" aria-busy={!view}>
    <Inline justify="between" gap="sm" wrap={panel}>
      {view ? <Typo.Caption grow basis="0" minWidth="0" truncate title={label}>{label}</Typo.Caption> : <Skeleton width="1/3" label={copy.loading} />}
      <Typo.Caption numeric="tabular">{view ? copy.requests(new Intl.NumberFormat(getAppLocale()).format(values.requests)) : "—"}{unit ? ` · ${unit}` : ""}</Typo.Caption>
    </Inline>
    <Inline justify="between" cross="baseline" gap="sm" wrap>
      <Inline cross="baseline" gap="xs">
        <Typo.MetricValue numeric="tabular">{view ? <AnimatedNumber value={values.total} format={usageTokens} /> : "—"}</Typo.MetricValue>
        <Typo.Caption>{copy.tokens}</Typo.Caption>
        {!selected && delta ? <Typo.Caption>{delta}</Typo.Caption> : null}
      </Inline>
      {showCost && !selected && !panel ? <Typo.Caption>{costText} · {copy.estimate}</Typo.Caption> : null}
    </Inline>
    {stale && view ? <Typo.Caption>{copy.updated(usageClock(Date.parse(view.generated_at)))}</Typo.Caption> : null}
    {children}
    <Stack align={panel ? "row" : "column"} gap={panel ? "lg" : "none"} wrap={panel} rowGap="xs">
      {series.map((item, i) => <KeyValueRow key={item.id} valueTextSize="caption"
        swatchColor={`var(--context-${item.color})`} label={item.label}
        value={view ? `${usageTokens(tokens[i]!)}${item.id === "cache" ? ` · ${cacheRatio}%` : ""}` : <Skeleton width={8} height="line" />} />)}
      {showCost && !selected && panel ? <KeyValueRow label={copy.estimatedCost} value={costText} valueTextSize="caption" /> : null}
      {!selected && share ? <KeyValueRow label={copy.share} value={share} valueTextSize="caption" /> : null}
    </Stack>
    <Collapsible open={Boolean(parts?.length)}>
      <Stack align={panel ? "row" : "column"} gap={panel ? "lg" : "none"} wrap={panel} rowGap={panel ? "xs" : undefined} data-test-class="usage-parts">
        {parts?.map((part) => <KeyValueRow key={part.id} label={part.label} value={part.value} valueTextSize="caption" />)}
      </Stack>
    </Collapsible>
  </Stack>;
}
