import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ProgressMeter } from "./ProgressMeter";

export const meta: ShowcaseMeta = {
  title: "ProgressMeter",
  category: "Inspector",
  tags: ["progress", "meter", "bar", "bare"],
  status: "stable",
};

const labels = {
  "en-US": { context: "Context window", full: "42% full", tasks: "Tasks", changes: "Changes", done: "Done", blocked: "Blocked", failed: "Failed" },
  "ko-KR": { context: "컨텍스트 창", full: "42% 사용", tasks: "Task", changes: "변경", done: "완료", blocked: "막힘", failed: "실패" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Default",
    render: (context) => <ProgressMeter label={text(context).context} meta={text(context).full} value={42} />,
  },
  {
    name: "Tones",
    render: (context) => (
      <Stack gap="sm">
        <ProgressMeter label={text(context).done} tone="success" value={80} />
        <ProgressMeter label={text(context).blocked} tone="warning" value={35} />
        <ProgressMeter label={text(context).failed} tone="danger" value={12} />
      </Stack>
    ),
  },
  {
    name: "Bare",
    render: (context) => (
      <Stack gap="sm">
        {[100, 64, 30, 8].map((value) => (
          <Stack key={value} gap="xs">
            <Typo.Caption numeric="tabular">{`${text(context).changes} ${value}`}</Typo.Caption>
            <ProgressMeter bare ariaLabel={`${text(context).changes} ${value}`} value={value} />
          </Stack>
        ))}
      </Stack>
    ),
  },
];
