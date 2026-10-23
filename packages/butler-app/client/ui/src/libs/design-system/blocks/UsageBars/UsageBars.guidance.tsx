import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { KeyValueRow } from "../KeyValueRow";
import { UsageBars, type UsageBarsBucket, type UsageBarsEmphasis, type UsageBarsSeries } from "./UsageBars";
import { bucketUsageSlots, type UsageSlot } from "./usageBuckets";

const SERIES: UsageBarsSeries[] = [
  { id: "new", color: "chart-1", label: "New input" },
  { id: "cached", color: "chart-5", label: "Cached" },
  { id: "output", color: "chart-2", label: "Output" },
];
const NOW = new Date(2026, 9, 15, 15, 32).getTime();
const HOUR = 3_600_000;
const SLOTS: UsageSlot[] = [[NOW - 5 * HOUR, 20_000, 92_000, 9_600], [NOW - 4 * HOUR, 72_000, 540_000, 21_000],
  [NOW - 3 * HOUR, 90_000, 1_120_000, 34_000], [NOW - HOUR, 140_000, 262_000, 6_000], [NOW, 34_000, 690_000, 15_000]];
const hour = new Intl.DateTimeFormat("en-US", { hour: "numeric" });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

// #region recipe: Hourly usage with a readout
function ChatUsage() {
  const [selected, setSelected] = useState<number | null>(null);
  const { buckets } = bucketUsageSlots(SLOTS, { toMs: NOW, maxBars: 24 });
  const bars: UsageBarsBucket[] = buckets.map((bucket) => {
    const [fresh = 0, cached = 0, output = 0] = bucket.values;
    return { key: `${bucket.startMs}`, label: hour.format(bucket.startMs), valueText: `${compact.format(fresh + cached + output)} tokens`,
      segments: [{ id: "new", value: fresh }, { id: "cached", value: cached }, { id: "output", value: output }] };
  });
  const readout = selected === null ? "This chat" : `${bars[selected]!.label} · ${bars[selected]!.valueText}`;
  return (
    <Stack gap="sm">
      <Typo.Caption tone="tertiary">{readout}</Typo.Caption>
      <UsageBars buckets={bars} series={SERIES} selectedIndex={selected} onSelect={setSelected} ariaLabel="Usage in this chat"
        axisLabels={[{ index: 0, text: bars[0]!.label }, { index: bars.length - 1, text: bars.at(-1)!.label }]} />
    </Stack>
  );
}
// #endregion

// #region recipe: Panel with y ticks
function PeriodUsage() {
  const { buckets } = bucketUsageSlots(SLOTS, { fromMs: NOW - 24 * HOUR, toMs: NOW, maxBars: 31 });
  const bars = buckets.map((bucket) => ({ key: `${bucket.startMs}`, label: hour.format(bucket.startMs),
    valueText: compact.format(bucket.values.reduce((sum, value) => sum + value, 0)),
    segments: SERIES.map((series, index) => ({ id: series.id, value: bucket.values[index] ?? 0 })) }));
  return <UsageBars size="panel" buckets={bars} series={SERIES} yTicks={{ format: (value) => compact.format(value) }}
    ariaLabel="Usage by hour" emptyLabel="No usage in this period" />;
}
// #endregion

// #region recipe: One chat split into conversation and subtasks
function DelegatingChatUsage() {
  const [emphasis, setEmphasis] = useState<UsageBarsEmphasis | null>(null);
  const { buckets } = bucketUsageSlots(SLOTS, { toMs: NOW, maxBars: 24 });
  // Each segment carries the part of its value that came from subtasks; here a third of every type.
  const bars: UsageBarsBucket[] = buckets.map((bucket) => {
    const [fresh = 0, cached = 0, output = 0] = bucket.values;
    return { key: `${bucket.startMs}`, label: hour.format(bucket.startMs), valueText: `${compact.format(fresh + cached + output)} tokens`,
      segments: [{ id: "new", value: fresh, subtask: fresh / 3 }, { id: "cached", value: cached, subtask: cached / 3 },
        { id: "output", value: output, subtask: output / 3 }] };
  });
  return (
    <Stack gap="sm">
      <UsageBars buckets={bars} series={SERIES} emphasis={emphasis} ariaLabel="Usage in this chat" />
      <KeyValueRow label="Conversation" value="67%" valueTextSize="caption" swatchColor="var(--context-chart-5)"
        onHighlightChange={(on) => setEmphasis(on ? "conversation" : null)} />
      <KeyValueRow label="Subtask" value="33%" valueTextSize="caption" swatchColor="var(--context-chart-5)" swatchPattern="hatched"
        onHighlightChange={(on) => setEmphasis(on ? "subtask" : null)} />
    </Stack>
  );
}
// #endregion

function AllChatsUsage() {
  const { buckets } = bucketUsageSlots(SLOTS, { toMs: NOW, maxBars: 24 });
  const bars = buckets.map((bucket) => ({ key: `${bucket.startMs}`, label: hour.format(bucket.startMs), valueText: "",
    segments: SERIES.map((series, index) => ({ id: series.id, value: bucket.values[index] ?? 0 })) }));
  return <UsageBars buckets={bars} series={SERIES} ariaLabel="Usage in all chats" />;
}

export const guidance: ShowcaseGuidance = {
  purpose: "Stacked usage columns over time (tokens per hour or day) with a keyboard- and pointer-driven selection the caller reads out.",
  whenToUse: [
    "Token or request usage over time in the context popover (size popover) or a usage page (size panel)",
    "Usage split into stacked parts (new input, cached, output) per time bucket",
    "One chat's usage with its subtask share: pass each segment's subtask value; it is drawn hatched on top of the segment",
  ],
  whenNotToUse: [
    { when: "A single share of a budget", use: "ProgressMeter" },
    { when: "Totals as rows without a time axis", use: "UsageSummaryRows" },
    { when: "Activity per calendar day over weeks", use: "ActivityHeatmap" },
    { when: "Generic multi-series charts with legends and tooltips", use: "Chart" },
  ],
  recipes: [
    { name: "Hourly usage with a readout", description: "bucketUsageSlots turns 15-minute slots into at most 24 buckets; onSelect drives the caption above.", render: () => <ChatUsage /> },
    { name: "Panel with y ticks", description: "size panel with yTicks and maxBars 31; empty hours stay as gaps.", render: () => <PeriodUsage /> },
    { name: "One chat split into conversation and subtasks", description: "segment.subtask draws a hatched part; KeyValueRow onHighlightChange drives emphasis.", render: () => <DelegatingChatUsage /> },
  ],
  doDont: [
    {
      do: { caption: "Read the selected bucket out in the surrounding UI.", render: () => <ChatUsage /> },
      dont: { caption: "A detached list of hourly numbers hides the shape of the day.", render: () => <Typo.Caption>10 AM 113K · 11 AM 633K · 12 PM 1.2M</Typo.Caption> },
    },
    {
      do: { caption: "Split one chat's bars, with the hatched legend row beside them.", render: () => <DelegatingChatUsage /> },
      dont: { caption: "Never pass subtask values for all chats: their bars stay solid, type by color only.", render: () => <AllChatsUsage /> },
    },
  ],
  content: [
    "Bucket label and valueText are short and localized (\"3 PM\", \"12.4K tokens\"); they fill the screen-reader table and the selection announcement.",
    "Axis labels: a few anchors only (first and last hour, midnights, or every 7th day).",
    "note is one muted caption (\"Just started\") beside a lone bucket; emptyLabel is one line.",
    "Name the split parts in the legend (\"Conversation\" / \"Subtask\"; 대화 / 하위 작업); the chart draws no tooltip or legend.",
  ],
  accessibility: [
    "One tab stop (role group named by ariaLabel); ←/→ move, Home/End jump, Esc clears (and passes through when nothing is selected).",
    "An sr-only table lists every bucket's label and valueText; a polite live region speaks the selection.",
    "The focus ring keeps --focus-ring-room clear of the axis labels and reaches 5px outside the chart; clipping parents must leave that room.",
    "The hatch is decorative; legend rows carry the conversation and subtask numbers as text.",
  ],
  tokens: [
    "--context-chart-1", "--context-chart-2", "--context-chart-5", "--chart-height-panel", "--line", "--text-tertiary",
    "--focus-ring-room", "--focus-ring-width", "--hatch-alpha", "--motion-deliberate", "--motion-slow", "--motion-base", "--motion-fast",
  ],
};
