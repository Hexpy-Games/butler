import type { ShowcaseMeta, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Stack } from "../../components/Stack";
import { UsageBars } from "./UsageBars";
import { EmptyDemo, LoadingDemo, MotionDemo, PanelDemo, PopoverDemo, SingleBucketDemo } from "./UsageBars.showcaseParts";
import { chatChart, sampleChart, sampleSlots, tickFormat, usageCopy, usageSeries } from "./UsageBars.showcaseData";

export const meta: ShowcaseMeta = {
  title: "UsageBars",
  category: "Dashboard & Metrics",
  tags: ["usage", "tokens", "chart", "bars", "stacked", "timeline", "context"],
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
  variants: ["popover", "panel"],
  render: ({ locale, state, variant }) => {
    const size = variant === "panel" ? "panel" : "popover";
    const chart = size === "panel" ? sampleChart(locale, 24 * 7, 31) : chatChart(locale, sampleSlots(7, 2));
    const text = usageCopy(locale);
    return (
      <UsageBars size={size} state={state === "loading" ? "loading" : "ready"} buckets={chart.buckets}
        series={usageSeries(locale)} axisLabels={chart.axisLabels} selectedIndex={state === "selected" ? 3 : null}
        yTicks={size === "panel" ? { format: tickFormat(locale) } : undefined} loadingLabel={text.loading}
        ariaLabel={size === "panel" ? text.period : text.chat} />
    );
  },
};
