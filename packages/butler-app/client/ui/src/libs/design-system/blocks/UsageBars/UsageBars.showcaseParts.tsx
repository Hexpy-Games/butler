import { useMemo, useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { UsageBars, type UsageBarsBucket, type UsageBarsSize } from "./UsageBars";
import {
  chatChart, compactTokens, SAMPLE_NOW, sampleChart, sampleSlots, tickFormat, usageCopy, usageSeries, windowChart,
} from "./UsageBars.showcaseData";
import { USAGE_SLOT_MS, type UsageSlot } from "./usageBuckets";

function totalText(context: ShowcaseRenderContext, buckets: UsageBarsBucket[]): string {
  const total = buckets.reduce((sum, bucket) => sum + bucket.segments.reduce((part, segment) => part + segment.value, 0), 0);
  return usageCopy(context.locale).tokens(compactTokens(context.locale, total));
}

/** The caller's readout: the selected bucket, or the total. The block itself draws no tooltip. */
function Readout({ context, buckets, selected }: { context: ShowcaseRenderContext; buckets: UsageBarsBucket[]; selected: number | null }) {
  const bucket = selected === null ? undefined : buckets[selected];
  return (
    <Stack align="row" justify="between" gap="sm">
      <Typo.Caption tone="tertiary">{bucket ? bucket.label : usageCopy(context.locale).total}</Typo.Caption>
      <Typo.Caption numeric="tabular">{bucket ? bucket.valueText : totalText(context, buckets)}</Typo.Caption>
    </Stack>
  );
}

/** The context-ring popover: hourly buckets since the chat started. */
export function PopoverDemo({ context, initialSelected = null }: { context: ShowcaseRenderContext; initialSelected?: number | null }) {
  const [selected, setSelected] = useState<number | null>(initialSelected);
  const chart = useMemo(() => chatChart(context.locale, sampleSlots(7, 2)), [context.locale]);
  const text = usageCopy(context.locale);
  return (
    <Stack gap="sm">
      <Readout context={context} buckets={chart.buckets} selected={selected} />
      <UsageBars buckets={chart.buckets} series={usageSeries(context.locale)} axisLabels={chart.axisLabels}
        selectedIndex={selected} onSelect={setSelected} ariaLabel={text.chat} emptyLabel={text.noUsage} />
    </Stack>
  );
}

/** The usage tab: a fixed window ending now, with y ticks. */
export function PanelDemo({ context, hours, maxBars = 31, initialSelected = null }: {
  context: ShowcaseRenderContext; hours: number; maxBars?: number; initialSelected?: number | null;
}) {
  const [selected, setSelected] = useState<number | null>(initialSelected);
  const chart = useMemo(() => sampleChart(context.locale, hours, maxBars), [context.locale, hours, maxBars]);
  const text = usageCopy(context.locale);
  return (
    <Stack gap="sm">
      <Readout context={context} buckets={chart.buckets} selected={selected} />
      <UsageBars size="panel" buckets={chart.buckets} series={usageSeries(context.locale)} axisLabels={chart.axisLabels}
        yTicks={{ format: tickFormat(context.locale) }} selectedIndex={selected} onSelect={setSelected}
        ariaLabel={text.period} emptyLabel={text.noUsagePeriod} />
    </Stack>
  );
}

/** A chat whose only usage is the current hour. */
export function SingleBucketDemo({ context, size }: { context: ShowcaseRenderContext; size: UsageBarsSize }) {
  const now = new Date(2026, 9, 15, 15, 30).getTime();
  const chart = chatChart(context.locale, [[now, 4_800, 31_900, 3_420]]);
  const text = usageCopy(context.locale);
  return (
    <UsageBars size={size} buckets={chart.buckets} series={usageSeries(context.locale)} axisLabels={chart.axisLabels}
      note={text.justStarted} ariaLabel={text.chat} yTicks={size === "panel" ? { format: tickFormat(context.locale) } : undefined} />
  );
}

/** Empty: the popover has no buckets yet; the panel keeps its zero buckets so the time axis stays. */
export function EmptyDemo({ context, size }: { context: ShowcaseRenderContext; size: UsageBarsSize }) {
  const text = usageCopy(context.locale);
  const chart = useMemo(() => sampleChart(context.locale, 24 * 7, 31, 0), [context.locale]);
  const zero = chart.buckets.map((bucket) => ({ ...bucket, segments: [] }));
  return size === "panel"
    ? <UsageBars size="panel" state="empty" buckets={zero} series={usageSeries(context.locale)} axisLabels={chart.axisLabels}
      emptyLabel={text.noUsagePeriod} ariaLabel={text.period} yTicks={{ format: tickFormat(context.locale) }} />
    : <UsageBars state="empty" buckets={[]} series={usageSeries(context.locale)} emptyLabel={text.noUsage} ariaLabel={text.chat} />;
}

export function LoadingDemo({ context, size }: { context: ShowcaseRenderContext; size: UsageBarsSize }) {
  const text = usageCopy(context.locale);
  return <UsageBars size={size} state="loading" buckets={[]} series={usageSeries(context.locale)}
    minSlots={size === "panel" ? 28 : 10} loadingLabel={text.loading} ariaLabel={size === "panel" ? text.period : text.chat}
    yTicks={size === "panel" ? { format: tickFormat(context.locale) } : undefined} />;
}

/** Live update (same bucket count: FLIP), a range switch (new count: grow) and a replay (remount). */
export function MotionDemo({ context }: { context: ShowcaseRenderContext }) {
  const [responses, setResponses] = useState(0);
  const [hours, setHours] = useState(24);
  const [round, setRound] = useState(0);
  const text = usageCopy(context.locale);
  const chart = useMemo(() => {
    const added = Array.from({ length: responses }, (): UsageSlot => [SAMPLE_NOW - USAGE_SLOT_MS, 30_000, 210_000, 9_000]);
    return windowChart(context.locale, [...sampleSlots(hours), ...added], hours, 31);
  }, [context.locale, hours, responses]);
  return (
    <Stack gap="md">
      <UsageBars key={round} size="panel" buckets={chart.buckets} series={usageSeries(context.locale)}
        axisLabels={chart.axisLabels} yTicks={{ format: tickFormat(context.locale) }} ariaLabel={text.period} />
      <ButtonContainer size="sm">
        <Button size="sm" variant="outline" onClick={() => setResponses((value) => value + 1)}>{text.add}</Button>
        <Button size="sm" variant="outline" onClick={() => setHours((value) => (value === 24 ? 24 * 7 : 24))}>{text.range}</Button>
        <Button size="sm" variant="outline" data-ds-motion="replay" onClick={() => setRound((value) => value + 1)}>{text.replay}</Button>
      </ButtonContainer>
    </Stack>
  );
}
