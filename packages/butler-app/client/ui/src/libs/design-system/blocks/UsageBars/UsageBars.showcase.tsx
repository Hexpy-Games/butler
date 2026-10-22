import type { ShowcaseMeta, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Stack } from "../../components/Stack";
import { UsageBars } from "./UsageBars";
import { EmptyDemo, LoadingDemo, MotionDemo, PanelDemo, PopoverDemo, SingleBucketDemo } from "./UsageBars.showcaseParts";
import { SplitMotionDemo, SplitPanelDemo, SplitPopoverDemo } from "./UsageBars.showcaseSplit";
import {
  chatChart, sampleChart, sampleSlots, sampleSplitSlots, splitChart, tickFormat, usageCopy, usageSeries,
} from "./UsageBars.showcaseData";

export const meta: ShowcaseMeta = {
  title: "UsageBars",
  category: "Dashboard & Metrics",
  tags: ["usage", "tokens", "chart", "bars", "stacked", "timeline", "context", "subtask", "hatch"],
  status: "beta",
};

export const stories: ShowcaseStory[] = [
  {
    // ContextDonutButton popover: hourly buckets since the chat started; hover or arrow keys drive the readout above.
    name: "Popover",
    states: ["hover", "selected"],
    widths: ["320", "375", "430"],
    render: (context) => <PopoverDemo context={context} />,
  },
  {
    // Usage tab, 7 days: 6-hour buckets (maxBars 31), y ticks in the left gutter.
    name: "Panel with y ticks",
    states: ["hover", "selected"],
    render: (context) => <PanelDemo context={context} hours={24 * 7} />,
  },
  {
    // Settings › Usage, all chats: no split; type by color only, no gaps in a column.
    name: "Gapless all chats",
    render: (context) => <PanelDemo context={context} hours={24} />,
  },
  {
    // Popover of a delegating chat: each type's subtask part is hatched on top; hover or focus a legend row to emphasize.
    name: "Split popover",
    states: ["hover", "selected"],
    widths: ["320", "375", "430"],
    render: (context) => <SplitPopoverDemo context={context} />,
  },
  {
    // Settings › Usage with one delegating chat picked.
    name: "Split panel",
    states: ["hover", "selected"],
    render: (context) => <SplitPanelDemo context={context} hours={24 * 7} />,
  },
  {
    // A selected bar keeps its hatched parts; the legend reads that bar's split.
    name: "Split selected",
    states: ["selected"],
    render: (context) => (
      <Stack gap="xl">
        <SplitPopoverDemo context={context} initialSelected={2} />
        <SplitPanelDemo context={context} hours={24 * 7} initialSelected={20} />
      </Stack>
    ),
  },
  {
    // New hatched parts fade in and grow from their boundary; columns ease to their new heights.
    name: "Split live update",
    states: ["changing"],
    render: (context) => <SplitMotionDemo context={context} />,
  },
  {
    // Usage tab, 30 days: one bucket per day.
    name: "Panel, many buckets",
    render: (context) => <PanelDemo context={context} hours={24 * 30} />,
  },
  {
    name: "Selected",
    states: ["selected"],
    render: (context) => (
      <Stack gap="xl">
        <PopoverDemo context={context} initialSelected={2} />
        <PanelDemo context={context} hours={24 * 7} initialSelected={20} />
      </Stack>
    ),
  },
  {
    name: "Single bucket",
    render: (context) => (
      <Stack gap="xl">
        <SingleBucketDemo context={context} size="popover" />
        <SingleBucketDemo context={context} size="panel" />
      </Stack>
    ),
  },
  {
    name: "Loading",
    states: ["loading"],
    render: (context) => (
      <Stack gap="xl">
        <LoadingDemo context={context} size="popover" />
        <LoadingDemo context={context} size="panel" />
      </Stack>
    ),
  },
  {
    name: "Empty",
    render: (context) => (
      <Stack gap="xl">
        <EmptyDemo context={context} size="popover" />
        <EmptyDemo context={context} size="panel" />
      </Stack>
    ),
  },
  {
    // Add a response: same bucket count, columns ease to new heights. Switch range: new count, columns grow again.
    name: "Live update",
    states: ["changing"],
    render: (context) => <MotionDemo context={context} />,
  },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "focus-visible", "selected", "loading"],
  variants: ["popover", "panel", "split popover", "split panel"],
  render: ({ locale, state, variant }) => {
    const size = variant.endsWith("panel") ? "panel" : "popover";
    const split = variant.startsWith("split");
    const chart = size === "panel"
      ? (split ? splitChart : sampleChart)(locale, 24 * 7, 31)
      : chatChart(locale, (split ? sampleSplitSlots : sampleSlots)(7, 2));
    const text = usageCopy(locale);
    return (
      <UsageBars size={size} state={state === "loading" ? "loading" : "ready"} buckets={chart.buckets}
        series={usageSeries(locale)} axisLabels={chart.axisLabels} selectedIndex={state === "selected" ? 3 : null}
        yTicks={size === "panel" ? { format: tickFormat(locale) } : undefined} loadingLabel={text.loading}
        ariaLabel={size === "panel" ? text.period : text.chat} />
    );
  },
};
