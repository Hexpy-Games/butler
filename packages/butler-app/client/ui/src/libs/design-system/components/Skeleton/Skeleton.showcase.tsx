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
  "en-US": { settings: "Loading settings", turn: "Preparing the response", automations: "Loading schedules" },
  "ko-KR": { settings: "설정을 불러오는 중", turn: "응답을 준비하는 중", automations: "예약 작업을 불러오는 중" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Pending turn lines",
    render: (context) => (
      <Skeleton lines={3} height="line" label={text(context).turn} />
    ),
  },
  {
    name: "Settings list rows",
    widths: ["375", "app"],
    render: (context) => (
      <Stack gap="sm">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} label={index === 0 ? text(context).settings : undefined} height="row" width="full" />
        ))}
      </Stack>
    ),
  },
  {
    name: "Widths, heights and shapes",
    widths: ["375", "app"],
    render: () => (
      <Stack gap="sm">
        <Skeleton height="title" width="1/2" />
        <Skeleton height="line" width="3/4" />
        <Skeleton height="line" width={24} />
        <Skeleton height="control" width="1/3" shape="pill" />
        <Skeleton height="control" shape="circle" />
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
