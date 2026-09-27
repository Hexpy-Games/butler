import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../Button";
import { Inline } from "../Inline";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { AnimatedNumber } from "./AnimatedNumber";

export const meta: ShowcaseMeta = {
  title: "AnimatedNumber",
  category: "Data display",
  tags: ["number", "metric", "count", "motion", "tabular"],
  status: "beta",
};

const labels = {
  "en-US": { replay: "Replay", tokens: "Input tokens", requests: "Requests" },
  "ko-KR": { replay: "다시 재생", tokens: "입력 토큰", requests: "요청" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

const sequence = [128, 36460, 1284, 1284000];

function CountingStory({ context }: { context: ShowcaseRenderContext }) {
  const [step, setStep] = useState(0);
  const format = (value: number) => value.toLocaleString(context.locale);
  const compact = (value: number) => new Intl.NumberFormat(context.locale, { notation: "compact" }).format(value);
  return (
    <Stack gap="md">
      <Inline gap="xl">
        <Stack gap="xs">
          <Typo.MetricValue><AnimatedNumber value={sequence[step]!} format={format} live /></Typo.MetricValue>
          <Typo.Caption tone="secondary">{text(context).tokens}</Typo.Caption>
        </Stack>
        <Stack gap="xs">
          <Typo.MetricValue><AnimatedNumber value={sequence[(step + 2) % sequence.length]!} format={compact} /></Typo.MetricValue>
          <Typo.Caption tone="secondary">{text(context).requests}</Typo.Caption>
        </Stack>
      </Inline>
      <Inline>
        <Button size="sm" variant="outline" data-ds-motion="replay" onClick={() => setStep((value) => (value + 1) % sequence.length)}>
          {text(context).replay}
        </Button>
      </Inline>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Count to a new value",
    states: ["changing", "reduced-motion"],
    render: (context) => <CountingStory context={context} />,
  },
  {
    name: "Inline in text",
    render: (context) => (
      <Typo.Body>
        {text(context).tokens} <AnimatedNumber value={36460} format={(value) => value.toLocaleString(context.locale)} />
      </Typo.Body>
    ),
  },
];
