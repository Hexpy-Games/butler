import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Button } from "../../components/Button";
import { Activity } from "../../components/Icons";
import { Inline } from "../../components/Inline";
import { Stack } from "../../components/Stack";
import { MetricGrid } from "../MetricGrid";
import { MetricCard } from "./MetricCard";

export const meta: ShowcaseMeta = {
  title: "MetricCard",
  category: "Dashboard & Metrics",
  tags: ["metric", "number", "dashboard", "motion"],
  status: "stable",
};

const labels = {
  "en-US": { requests: "Model requests", tokens: "Input tokens", sessions: "Active sessions", replay: "Replay", change: "+12%" },
  "ko-KR": { requests: "모델 요청", tokens: "입력 토큰", sessions: "활성 세션", replay: "다시 재생", change: "+12%" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

function Counting({ context }: { context: ShowcaseRenderContext }) {
  const [round, setRound] = useState(0);
  const compact = (value: number) => new Intl.NumberFormat(context.locale, { notation: "compact" }).format(value);
  return (
    <Stack gap="md">
      <MetricGrid>
        <MetricCard value={[42, 128, 1290][round % 3]!} format={compact} label={text(context).requests} />
        <MetricCard value={[36460, 184200, 912000][round % 3]!} format={compact} label={text(context).tokens} />
        <MetricCard value={[3, 7, 12][round % 3]!} label={text(context).sessions} trend="up" change={text(context).change} icon={<Activity size="md" />} />
      </MetricGrid>
      <Inline>
        <Button size="sm" variant="outline" data-ds-motion="replay" onClick={() => setRound((value) => value + 1)}>{text(context).replay}</Button>
      </Inline>
    </Stack>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Counting values", states: ["changing"], widths: ["375", "app", "wide"], render: (context) => <Counting context={context} /> },
  {
    name: "Static value",
    render: (context) => <MetricCard value="1.2K" label={text(context).requests} />,
  },
];
