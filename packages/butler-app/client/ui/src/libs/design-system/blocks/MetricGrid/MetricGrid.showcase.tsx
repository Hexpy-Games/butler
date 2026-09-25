import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { MetricCard } from "../MetricCard";
import { MetricGrid } from "./MetricGrid";

export const meta: ShowcaseMeta = {
  title: "MetricGrid",
  category: "Dashboard & Metrics",
  tags: ["metric", "grid", "dashboard"],
  status: "stable",
};

const labels = {
  "en-US": { completed: "Completed", open: "Open work", blocked: "Blocked", registered: "Registered work" },
  "ko-KR": { completed: "완료", open: "열린 작업", blocked: "막힌 작업", registered: "등록된 작업" },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Dashboard metrics",
    widths: ["375", "app", "wide"],
    render: (context) => (
      <MetricGrid>
        <MetricCard value={3} label={text(context).completed} />
        <MetricCard value={7} label={text(context).open} />
        <MetricCard value={1} label={text(context).blocked} />
        <MetricCard value={11} label={text(context).registered} />
      </MetricGrid>
    ),
  },
];
