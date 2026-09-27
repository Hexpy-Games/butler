import { useState, type ReactNode } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { Inline } from "../../components/Inline";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ProgressMeter } from "../ProgressMeter";
import { UsageSummaryRows, type UsageSummaryRowsProps } from "./UsageSummaryRows";

export const meta: ShowcaseMeta = {
  title: "UsageSummaryRows",
  category: "Inspector",
  tags: ["usage", "quota", "tokens", "cost", "subscription", "api", "popover"],
  status: "beta",
};

const labels = {
  "en-US": {
    context: "Context window", full: "7% full", fiveHour: "5-hour", weekly: "Weekly", resets: "Resets 14:00",
    resetsWeek: "Resets Oct 2", left: (p: string) => `${p} left`, input: "Input", cached: "Cached", output: "Output",
    reasoning: "Reasoning", cost: "Cost", est: "est.", unavailable: "Usage unavailable", loading: "Loading usage",
    updated: "Updated 14:05", details: "Details", replay: "Replay",
  },
  "ko-KR": {
    context: "컨텍스트 창", full: "7% 사용", fiveHour: "5시간", weekly: "주간", resets: "14:00 초기화",
    resetsWeek: "10월 2일 초기화", left: (p: string) => `${p} 남음`, input: "입력", cached: "캐시", output: "출력",
    reasoning: "추론", cost: "비용", est: "추정", unavailable: "사용량 확인 불가", loading: "사용량 불러오는 중",
    updated: "14:05 기준", details: "자세히", replay: "다시 재생",
  },
} as const;

type Copy = (typeof labels)[keyof typeof labels];

function text({ locale }: ShowcaseRenderContext): Copy {
  return labels[locale];
}

/** The composer popover body: context meter, usage section, Details. */
function PopoverBody({ copy, children }: { copy: Copy; children?: ReactNode }) {
  return (
    <Stack gap="lg" UNSAFE_style={{ maxWidth: "280px" }}>
      <Stack gap="xs">
        <ProgressMeter label={copy.context} meta={copy.full} value={7} />
        <Typo.Caption tone="secondary" numeric="tabular">18k / 258k</Typo.Caption>
      </Stack>
      {children}
      <Inline justify="end">
        <Button variant="inline" size="sm" text={copy.details} />
      </Inline>
    </Stack>
  );
}

function base(copy: Copy, locale: string): UsageSummaryRowsProps {
  return { unavailableLabel: copy.unavailable, loadingLabel: copy.loading, remainingLabel: copy.left, estimateLabel: copy.est, locale };
}

function subscription(copy: Copy, fiveHour = 82): UsageSummaryRowsProps["quotaWindows"] {
  return [
    { id: "5h", label: copy.fiveHour, remainingPercent: fiveHour, caption: copy.resets },
    { id: "week", label: copy.weekly, remainingPercent: 64, caption: copy.resetsWeek },
  ];
}

function api(copy: Copy, scale = 1, withReasoning = true): Pick<UsageSummaryRowsProps, "tokens" | "cost"> {
  return {
    tokens: [
      { id: "input", label: copy.input, value: 48_200 * scale },
      { id: "cached", label: copy.cached, value: 31_900 * scale },
      { id: "output", label: copy.output, value: 3_420 * scale },
      ...(withReasoning ? [{ id: "reasoning", label: copy.reasoning, value: 1_280 * scale }] : []),
    ],
    cost: { label: copy.cost, usd: 0.0842 * scale, estimated: true },
  };
}

function Replay({ context }: { context: ShowcaseRenderContext }) {
  const [round, setRound] = useState(0);
  const copy = text(context);
  const scale = [1, 1.6, 2.4][round % 3]!;
  return (
    <Stack gap="md">
      <UsageSummaryRows {...base(copy, context.locale)} {...api(copy, scale)} quotaWindows={subscription(copy, [82, 61, 37][round % 3])} />
      <Inline>
        <Button size="sm" variant="outline" data-ds-motion="replay" onClick={() => setRound((value) => value + 1)} text={copy.replay} />
      </Inline>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  {
    name: "Subscription",
    render: (context) => {
      const copy = text(context);
      return <PopoverBody copy={copy}><UsageSummaryRows {...base(copy, context.locale)} quotaWindows={subscription(copy)} /></PopoverBody>;
    },
  },
  {
    name: "API key",
    render: (context) => {
      const copy = text(context);
      return <PopoverBody copy={copy}><UsageSummaryRows {...base(copy, context.locale)} {...api(copy, 1, false)} /></PopoverBody>;
    },
  },
  {
    name: "API key, unpriced with reasoning",
    render: (context) => {
      const copy = text(context);
      const rows = api(copy);
      return <PopoverBody copy={copy}><UsageSummaryRows {...base(copy, context.locale)} tokens={rows.tokens} cost={{ label: copy.cost, usd: null }} /></PopoverBody>;
    },
  },
  {
    name: "Local model",
    render: (context) => <PopoverBody copy={text(context)} />,
  },
  {
    name: "Loading",
    states: ["loading"],
    render: (context) => {
      const copy = text(context);
      return <PopoverBody copy={copy}><UsageSummaryRows {...base(copy, context.locale)} state="loading" /></PopoverBody>;
    },
  },
  {
    name: "Unavailable",
    render: (context) => {
      const copy = text(context);
      return <PopoverBody copy={copy}><UsageSummaryRows {...base(copy, context.locale)} state="unavailable" /></PopoverBody>;
    },
  },
  {
    name: "Stale",
    render: (context) => {
      const copy = text(context);
      return (
        <PopoverBody copy={copy}>
          <UsageSummaryRows {...base(copy, context.locale)} quotaWindows={subscription(copy)} updatedLabel={copy.updated} />
        </PopoverBody>
      );
    },
  },
  {
    name: "Value change",
    states: ["changing"],
    render: (context) => <Replay context={context} />,
  },
];
