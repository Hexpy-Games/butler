import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { CheckIcon, CircleX } from "../../components/Icons";
import { Spinner } from "../../components/Spinner";
import { AutomationRunList } from "./AutomationRunList";

export const meta: ShowcaseMeta = {
  title: "AutomationRunList",
  category: "Dashboard & Metrics",
  tags: ["automation", "runs", "history", "activity"],
  status: "stable",
};

const labels = {
  "en-US": {
    runs: "Runs", empty: "No runs yet.", completed: "Completed", running: "Running", failed: "Failed",
    brief: "Brief generated", error: "Model provider timed out", today: "today", now: "now", yesterday: "yesterday",
  },
  "ko-KR": {
    runs: "실행 기록", empty: "아직 실행 기록이 없습니다.", completed: "완료", running: "실행 중", failed: "실패",
    brief: "브리핑 생성됨", error: "모델 제공자 응답 시간 초과", today: "오늘", now: "방금", yesterday: "어제",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    name: "Runs with state icons",
    render: (context) => {
      const copy = text(context);
      return (
        <AutomationRunList title={copy.runs} runs={[
          { id: "run-3", icon: <Spinner size={16} />, title: copy.running, meta: copy.now },
          { id: "run-2", icon: <CheckIcon size="md" />, title: copy.completed, description: copy.brief, meta: copy.today },
          { id: "run-1", icon: <CircleX size="md" />, title: copy.failed, description: copy.error, meta: copy.yesterday },
        ]} />
      );
    },
  },
  {
    // AutomationRuns today: state label and relative age only.
    name: "Product rows (labels only)",
    render: (context) => (
      <AutomationRunList title={text(context).runs} emptyLabel={text(context).empty} runs={[
        { id: "run-2", title: text(context).completed, meta: text(context).today },
        { id: "run-1", title: text(context).failed, meta: text(context).yesterday },
      ]} />
    ),
  },
  { name: "Empty", render: (context) => <AutomationRunList title={text(context).runs} emptyLabel={text(context).empty} runs={[]} /> },
];
