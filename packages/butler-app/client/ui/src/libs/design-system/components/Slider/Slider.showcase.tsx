import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStateMatrix, ShowcaseStory } from "../../showcase";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { Slider } from "./Slider";

export const meta: ShowcaseMeta = {
  title: "Slider",
  category: "Input",
  tags: ["form", "range", "settings", "tokens"],
  status: "stable",
};

const labels = {
  "en-US": { context: "Context limit", compaction: "Compact at", tokens: "tokens", locked: "Set by the provider" },
  "ko-KR": { context: "컨텍스트 한도", compaction: "압축 시점", tokens: "토큰", locked: "제공자가 정합니다" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

/** A controlled slider over a token budget (TokenInputControl adds the exact input). */
function TokenSlider({ context, disabled }: { context: ShowcaseRenderContext; disabled?: boolean }) {
  const [value, setValue] = useState(285000);
  const format = new Intl.NumberFormat(context.locale);
  return (
    <Stack gap="xs">
      <Stack align="row" justify="between">
        <Typo.Label>{text(context).context}</Typo.Label>
        <Typo.Caption tone="secondary">{`${format.format(value)} ${text(context).tokens}`}</Typo.Caption>
      </Stack>
      <Slider aria-label={text(context).context} disabled={disabled} max={1000000} min={1000} onValueChange={setValue} step={1000} value={value} />
      {disabled ? <Typo.Caption tone="tertiary">{text(context).locked}</Typo.Caption> : null}
    </Stack>
  );
}

/** 0-100 with a percent readout (PercentInputControl adds the exact input). */
function PercentSlider({ context }: { context: ShowcaseRenderContext }) {
  const [value, setValue] = useState(80);
  return (
    <Stack gap="xs">
      <Stack align="row" justify="between">
        <Typo.Label>{text(context).compaction}</Typo.Label>
        <Typo.Caption tone="secondary">{`${value}%`}</Typo.Caption>
      </Stack>
      <Slider aria-label={`${text(context).compaction} percent slider`} max={100} min={0} onValueChange={setValue} value={value} />
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Token budget", render: (context) => <TokenSlider context={context} /> },
  { name: "Percent", render: (context) => <PercentSlider context={context} /> },
  { name: "Disabled", states: ["disabled"], render: (context) => <TokenSlider context={context} disabled /> },
];

export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "active", "disabled"],
  render: (context) => (
    <Slider aria-label={text(context).compaction} disabled={context.state === "disabled"} max={100} min={0} value={60} readOnly />
  ),
};
