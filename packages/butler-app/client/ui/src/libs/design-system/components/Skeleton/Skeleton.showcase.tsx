import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Stack } from "../Stack";
import { Skeleton, SkeletonRows } from "./index";

export const meta: ShowcaseMeta = {
  title: "Skeleton",
  category: "Feedback",
  tags: ["loading", "placeholder", "shimmer", "motion"],
  status: "stable",
};

const labels = {
  "en-US": { settings: "Loading settings", turn: "Preparing the response", automations: "Loading automations" },
  "ko-KR": { settings: "설정을 불러오는 중", turn: "응답을 준비하는 중", automations: "자동화를 불러오는 중" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

// Skeleton has no size props yet: callers size it with a style (as the
// settings list and the pending turn do). Heights follow the text they stand in for.
const TURN_LINES = ["62%", "88%", "74%"] as const;

export const stories: ShowcaseStory[] = [
  {
    name: "Pending turn lines",
    render: (context) => (
      <Stack gap="md">
        {TURN_LINES.map((width, index) => (
          <Skeleton key={width} label={index === 0 ? text(context).turn : undefined} style={{ height: index === 0 ? 18 : 12, width }} />
        ))}
      </Stack>
    ),
  },
  {
    name: "Settings list rows",
    widths: ["375", "app"],
    render: (context) => (
      <Stack gap="sm">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} label={index === 0 ? text(context).settings : undefined} style={{ height: 44, width: "100%" }} />
        ))}
      </Stack>
    ),
  },
  {
    name: "SkeletonRows: list and field shapes",
    widths: ["375", "app"],
    render: (context) => (
      <Stack gap="lg">
        <SkeletonRows rows={3} shape="list" label={text(context).automations} />
        <SkeletonRows rows={2} shape="field" label={text(context).settings} />
      </Stack>
    ),
  },
];
