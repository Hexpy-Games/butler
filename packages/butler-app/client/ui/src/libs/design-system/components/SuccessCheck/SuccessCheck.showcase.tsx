import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../Button";
import { ICON_SIZE } from "../Icons";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { SuccessCheck } from "./SuccessCheck";

export const meta: ShowcaseMeta = {
  title: "SuccessCheck",
  category: "Feedback",
  tags: ["check", "success", "done", "complete", "motion"],
  status: "beta",
};

const labels = {
  "en-US": { replay: "Replay", plain: "Plain (CopyButton)", ring: "Ring (LoadingIndicator)", still: "Static (mounted done)" },
  "ko-KR": { replay: "다시 재생", plain: "기본 (CopyButton)", ring: "링 (LoadingIndicator)", still: "정적 (완료 상태로 표시)" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

function Draw({ context }: { context: ShowcaseRenderContext }) {
  const [run, setRun] = useState(0);
  const copy = text(context);
  return (
    <Stack gap="md">
      <Stack align="row" gap="xl" cross="center" wrap key={run}>
        {([[copy.plain, false], [copy.ring, true]] as const).map(([title, ring]) => (
          <Stack gap="sm" cross="center" key={title}>
            <Stack align="row" gap="md" cross="center">
              {(["sm", "md", "lg", "xl"] as const).map((size) => <SuccessCheck key={size} ring={ring} size={ICON_SIZE[size]} />)}
            </Stack>
            <Typo.Caption>{title}</Typo.Caption>
          </Stack>
        ))}
      </Stack>
      <Stack align="row"><Button size="sm" variant="outline" data-ds-motion="replay" text={copy.replay} onClick={() => setRun(run + 1)} /></Stack>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Draw", states: ["enter"], render: (context) => <Draw context={context} /> },
  {
    name: "Static",
    render: (context) => (
      <Stack align="row" gap="md" cross="center">
        <SuccessCheck animate={false} size={ICON_SIZE.lg} />
        <SuccessCheck animate={false} ring size={ICON_SIZE.lg} />
        <Typo.Caption>{text(context).still}</Typo.Caption>
      </Stack>
    ),
  },
];
