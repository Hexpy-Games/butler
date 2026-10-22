import { useMemo, useState } from "react";
import type { ShowcaseRenderContext } from "../../showcase";
import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Stack } from "../../components/Stack";
import { KeyValueRow } from "../KeyValueRow";
import { UsageBars, type UsageBarsBucket, type UsageBarsEmphasis } from "./UsageBars";
import { chatChart, compactTokens, SAMPLE_NOW, sampleSplitSlots, splitChart, tickFormat, usageCopy, usageSeries, windowChart } from "./UsageBars.showcaseData";
import { Readout } from "./UsageBars.showcaseParts";
import { USAGE_SLOT_MS, type UsageSlot } from "./usageBuckets";

/** Conversation and subtask totals of the selected bucket, or of every bucket. */
function splitTotals(buckets: UsageBarsBucket[], selected: number | null): [number, number] {
  const shown = selected === null ? buckets : buckets.slice(selected, selected + 1);
  const segments = shown.flatMap((bucket) => bucket.segments);
  const subtask = segments.reduce((sum, segment) => sum + (segment.subtask ?? 0), 0);
  return [segments.reduce((sum, segment) => sum + segment.value, 0) - subtask, subtask];
}

/** The caller's legend: solid 대화 and hatched 하위 작업 rows, each linked to the chart's emphasis. */
function SplitLegend({ context, buckets, selected, onEmphasis }: {
  context: ShowcaseRenderContext; buckets: UsageBarsBucket[]; selected: number | null; onEmphasis: (emphasis: UsageBarsEmphasis | null) => void;
}) {
  const text = usageCopy(context.locale);
  const [conversation, subtask] = splitTotals(buckets, selected);
  const percent = (value: number) => `${Math.round((value / Math.max(conversation + subtask, 1)) * 100)}%`;
  const rows = [
    { key: "conversation" as const, label: text.conversation, value: conversation, pattern: "solid" as const },
    { key: "subtask" as const, label: text.subtask, value: subtask, pattern: "hatched" as const },
  ];
  return (
    <Stack gap="xs">
      {rows.map((row) => (
        <KeyValueRow key={row.key} label={row.label} value={`${compactTokens(context.locale, row.value)} · ${percent(row.value)}`}
          valueTextSize="caption" swatchColor="var(--context-chart-5)" swatchPattern={row.pattern}
          onHighlightChange={(highlighted) => onEmphasis(highlighted ? row.key : null)} />
      ))}
    </Stack>
  );
}

/** The context popover of a delegating chat: hatched subtask parts and the linked legend. */
export function SplitPopoverDemo({ context, initialSelected = null }: { context: ShowcaseRenderContext; initialSelected?: number | null }) {
  const [selected, setSelected] = useState<number | null>(initialSelected);
  const [emphasis, setEmphasis] = useState<UsageBarsEmphasis | null>(null);
  const chart = useMemo(() => chatChart(context.locale, sampleSplitSlots(7, 2)), [context.locale]);
  const text = usageCopy(context.locale);
  return (
    <Stack gap="sm">
      <Readout context={context} buckets={chart.buckets} selected={selected} />
      <UsageBars buckets={chart.buckets} series={usageSeries(context.locale)} axisLabels={chart.axisLabels} emphasis={emphasis}
        selectedIndex={selected} onSelect={setSelected} ariaLabel={text.chat} emptyLabel={text.noUsage} />
      <SplitLegend context={context} buckets={chart.buckets} selected={selected} onEmphasis={setEmphasis} />
    </Stack>
  );
}

/** Settings › Usage with one delegating chat picked: a fixed window with y ticks. */
export function SplitPanelDemo({ context, hours, initialSelected = null }: {
  context: ShowcaseRenderContext; hours: number; initialSelected?: number | null;
}) {
  const [selected, setSelected] = useState<number | null>(initialSelected);
  const [emphasis, setEmphasis] = useState<UsageBarsEmphasis | null>(null);
  const chart = useMemo(() => splitChart(context.locale, hours, 31), [context.locale, hours]);
  const text = usageCopy(context.locale);
  return (
    <Stack gap="sm">
      <Readout context={context} buckets={chart.buckets} selected={selected} />
      <UsageBars size="panel" buckets={chart.buckets} series={usageSeries(context.locale)} axisLabels={chart.axisLabels}
        yTicks={{ format: tickFormat(context.locale) }} selectedIndex={selected} onSelect={setSelected} emphasis={emphasis}
        ariaLabel={text.period} emptyLabel={text.noUsagePeriod} />
      <SplitLegend context={context} buckets={chart.buckets} selected={selected} onEmphasis={setEmphasis} />
    </Stack>
  );
}

/** Responses arrive: a subtask response adds new hatched parts (fade and grow), and every column eases to its new height. */
export function SplitMotionDemo({ context }: { context: ShowcaseRenderContext }) {
  const [added, setAdded] = useState<UsageSlot[]>([]);
  const [round, setRound] = useState(0);
  const text = usageCopy(context.locale);
  const chart = useMemo(() => windowChart(context.locale, [...sampleSplitSlots(24).filter((slot) => slot[0] < SAMPLE_NOW - 6 * 3_600_000),
    ...added], 24, 31), [added, context.locale]);
  const add = (subtask: boolean) => setAdded((slots) => [...slots,
    [SAMPLE_NOW - USAGE_SLOT_MS * (1 + slots.length * 4), 30_000, 210_000, 9_000, subtask ? 20_000 : 0, subtask ? 150_000 : 0, subtask ? 7_000 : 0]]);
  return (
    <Stack gap="md">
      <UsageBars key={round} size="panel" buckets={chart.buckets} series={usageSeries(context.locale)}
        axisLabels={chart.axisLabels} yTicks={{ format: tickFormat(context.locale) }} ariaLabel={text.period} />
      <ButtonContainer size="sm">
        <Button size="sm" variant="outline" onClick={() => add(false)}>{text.add}</Button>
        <Button size="sm" variant="outline" onClick={() => add(true)}>{text.addSubtask}</Button>
        <Button size="sm" variant="outline" data-ds-motion="replay" onClick={() => { setAdded([]); setRound((value) => value + 1); }}>{text.replay}</Button>
      </ButtonContainer>
    </Stack>
  );
}
