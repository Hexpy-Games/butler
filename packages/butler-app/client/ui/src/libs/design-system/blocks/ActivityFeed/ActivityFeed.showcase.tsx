import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { CheckIcon, Circle, CircleAlert } from "../../components/Icons";
import { Spinner } from "../../components/Spinner";
import { ActivityFeed } from "./ActivityFeed";

export const meta: ShowcaseMeta = {
  title: "ActivityFeed",
  category: "Conversation & Activity",
  tags: ["activity", "progress", "inspector", "timeline"],
  status: "stable",
};

const labels = {
  "en-US": {
    progress: "Progress", empty: "No progress yet.", worker: "Worker activity",
    rows: ["Read the settings pages", "Compared header spacing at 375 and 1440", "Waiting for the S7 branch", "Write the report"],
    plan: "Plan updated", planMeta: "now", design: "Design-system expansion", validation: "Validation passed", validationMeta: "2m",
  },
  "ko-KR": {
    progress: "진행", empty: "아직 진행 상황이 없습니다.", worker: "Worker 활동",
    rows: ["설정 페이지 읽기", "375와 1440에서 헤더 간격 비교", "S7 브랜치 기다리는 중", "보고서 작성"],
    plan: "계획 갱신", planMeta: "방금", design: "디자인 시스템 확장", validation: "검증 통과", validationMeta: "2분",
  },
} as const;

function text({ locale }: ShowcaseRenderContext) {
  return labels[locale];
}

export const stories: ShowcaseStory[] = [
  {
    // SummaryPanel progress: the state icon sits on the title line.
    name: "Summary progress",
    render: (context) => {
      const [done, compared, waiting, next] = text(context).rows;
      return (
        <ActivityFeed title={text(context).progress} items={[
          { id: "1", icon: <CheckIcon size="md" />, title: done },
          { id: "2", icon: <CheckIcon size="md" />, title: compared },
          { id: "3", icon: <Spinner size={16} />, title: waiting },
          { id: "4", icon: <Circle size="md" />, title: next },
        ]} />
      );
    },
  },
  {
    name: "Description and meta",
    render: (context) => (
      <ActivityFeed title={text(context).worker} items={[
        { id: "1", icon: <CircleAlert size="md" />, title: text(context).plan, description: text(context).design, meta: text(context).planMeta },
        { id: "2", icon: <CheckIcon size="md" />, title: text(context).validation, meta: text(context).validationMeta },
      ]} />
    ),
  },
  { name: "Empty", render: (context) => <ActivityFeed title={text(context).progress} emptyLabel={text(context).empty} items={[]} /> },
  {
    name: "Composer surface",
    render: (context) => (
      <ActivityFeed surface="composer" title={text(context).worker}
        items={[{ id: "1", icon: <Spinner size={16} />, title: text(context).rows[2], meta: text(context).planMeta }]} />
    ),
  },
];
