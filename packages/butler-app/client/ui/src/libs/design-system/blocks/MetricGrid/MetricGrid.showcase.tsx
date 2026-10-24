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
  "en-US": { completed: "Completed", open: "Open work", blocked: "Blocked", registered: "Registered work",
    lifetime: "Lifetime tokens", busiest: "Busiest day", busiestDate: "Sep 14", longest: "Longest task", longestTitle: "Rewrite the release notes for preview 14",
    streak: "Longest streak", streakValue: "41 days", streakRange: "Aug 2 – Sep 11", current: "Current streak", currentValue: "23 days" },
  "ko-KR": { completed: "완료", open: "열린 작업", blocked: "막힌 작업", registered: "등록된 작업",
    lifetime: "누적 토큰", busiest: "가장 많이 쓴 날", busiestDate: "9월 14일", longest: "가장 긴 작업", longestTitle: "프리뷰 14 릴리스 노트 다시 쓰기",
    streak: "최장 연속 사용", streakValue: "41일", streakRange: "8월 2일 – 9월 11일", current: "연속 사용 중", currentValue: "23일" },
} as const;

function Joined({ context }: { context: ShowcaseRenderContext }) {
  const copy = text(context);
  return (
    <MetricGrid variant="joined">
      <MetricCard value={context.locale === "ko-KR" ? "44.1억" : "4.41B"} label={copy.lifetime} />
      <MetricCard value={context.locale === "ko-KR" ? "3억" : "300M"} label={copy.busiest} change={copy.busiestDate} trend="neutral" />
      <MetricCard value={context.locale === "ko-KR" ? "6시간 41분" : "6h 41m"} label={copy.longest} change={copy.longestTitle} trend="neutral" />
      <MetricCard value={copy.streakValue} label={copy.streak} change={copy.streakRange} trend="neutral" />
      <MetricCard value={copy.currentValue} label={copy.current} />
    </MetricGrid>
  );
}

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
  {
    // Usage activity stats: one card, rows always fill (5 · 3+2 · 2+2+1 · 1).
    name: "Joined stat row",
    widths: ["320", "375", "app", "wide"],
    render: (context) => <Joined context={context} />,
  },
];
