import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { Inline } from "../../components/Inline";
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
  "en-US": { replay: "Replay", context: "Context window", full: "42% full", downloading: "Downloading", received: "44 MB downloaded", tasks: "Tasks", changes: "Changes", done: "Done", blocked: "Blocked", failed: "Failed", loading: "Loading page" },
  "ko-KR": { replay: "다시 재생", context: "컨텍스트 창", full: "42% 사용", downloading: "다운로드 중", received: "44MB 받음", tasks: "Task", changes: "변경", done: "완료", blocked: "막힘", failed: "실패", loading: "페이지 로딩 중" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

function FillChange({ context }: { context: ShowcaseRenderContext }) {
  const [round, setRound] = useState(0);
  const value = [18, 64, 92, 35][round % 4]!;
  return (
    <Stack gap="md">
      <ProgressMeter label={text(context).context} meta={`${value}%`} value={value} />
      <ProgressMeter bare ariaLabel={text(context).changes} value={100 - value} tone="success" />
      <Inline>
        <Button size="sm" variant="outline" data-ds-motion="replay" onClick={() => setRound((current) => current + 1)}>{text(context).replay}</Button>
      </Inline>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Indeterminate", states: ["unknown total"],
    render: (context) => <ProgressMeter indeterminate label={text(context).downloading} meta={text(context).received} ariaLabel={text(context).downloading} />,
  },
  {
    name: "Fill change",
    states: ["changing"],
    render: (context) => <FillChange context={context} />,
  },
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
  {
    // PageCard: the page's load line on the card's top edge.
    name: "Thin (page load line)",
    render: (context) => (
      <Stack gap="sm">
        {[72, 30].map((value) => (
          <Stack key={value} gap="xs">
            <Typo.Caption numeric="tabular">{`${text(context).loading} ${value}%`}</Typo.Caption>
            <ProgressMeter thin ariaLabel={text(context).loading} value={value} />
          </Stack>
        ))}
      </Stack>
    ),
  },
];
