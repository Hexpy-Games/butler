import { useState } from "react";
import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { Stack } from "../Stack";
import { Typo } from "../Typo";
import { SegmentedControl } from "./SegmentedControl";

export const meta: ShowcaseMeta = {
  title: "SegmentedControl",
  category: "Input",
  tags: ["input", "choice", "radiogroup", "filter", "period"],
  status: "beta",
};

const labels = {
  "en-US": { period: "Period", days: (days: number) => `Last ${days} days`, kind: "Board kind", work: "Work", plan: "Plan", task: "Task" },
  "ko-KR": { period: "기간", days: (days: number) => `최근 ${days}일`, kind: "보드 종류", work: "작업", plan: "계획", task: "할 일" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

function PeriodStory({ context, size }: { context: ShowcaseRenderContext; size: "sm" | "default" }) {
  const [value, setValue] = useState("30");
  return (
    <Stack gap="sm">
      <SegmentedControl ariaLabel={text(context).period} size={size} value={value} onValueChange={setValue}
        options={[7, 30, 90].map((days) => ({ value: String(days), label: text(context).days(days) }))} />
      <Typo.Caption tone="secondary">{text(context).days(Number(value))}</Typo.Caption>
    </Stack>
  );
}

function KindStory({ context }: { context: ShowcaseRenderContext }) {
  const [value, setValue] = useState("work");
  return <SegmentedControl ariaLabel={text(context).kind} value={value} onValueChange={setValue}
    options={[{ value: "work", label: text(context).work }, { value: "plan", label: text(context).plan }, { value: "task", label: text(context).task, disabled: true }]} />;
}

export const stories: ShowcaseStory[] = [
  { name: "Period", states: ["selected", "focus"], render: (context) => <PeriodStory context={context} size="default" /> },
  { name: "Small", render: (context) => <PeriodStory context={context} size="sm" /> },
  { name: "Disabled option", states: ["disabled"], render: (context) => <KindStory context={context} /> },
];
