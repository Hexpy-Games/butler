import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { AttachedComposer } from "../../showcase/support/AttachedComposer";
import { TodoProgressPanel, type TodoProgressPanelItemState } from "./TodoProgressPanel";

export const meta: ShowcaseMeta = {
  title: "TodoProgressPanel",
  category: "Conversation & Activity",
  tags: ["composer", "progress", "plan", "steps", "adjunct"],
  status: "stable",
};

const labels = {
  "en-US": {
    heading: "Steps", region: "Plan steps",
    steps: [
      ["Understand the request", "completed", "Done"],
      ["Inspect the settings pages", "running", "Running"],
      ["Review the section header spacing", "reviewing", "Reviewing"],
      ["Fix the drifted card inset", "correction-required", "Needs correction"],
      ["Wait for the S7 branch", "blocked", "Blocked"],
      ["Skip the superseded screenshot pass", "skipped", "Skipped"],
      ["Prepare the final answer", "pending", "Pending"],
    ],
    stopped: "Stopped by the user",
  },
  "ko-KR": {
    heading: "진행 단계", region: "계획 단계",
    steps: [
      ["요청 이해하기", "completed", "완료"],
      ["설정 페이지 살펴보기", "running", "진행 중"],
      ["섹션 헤더 간격 검토", "reviewing", "검토 중"],
      ["어긋난 카드 여백 고치기", "correction-required", "수정 필요"],
      ["S7 브랜치 기다리기", "blocked", "막힘"],
      ["대체된 스크린샷 작업 건너뛰기", "skipped", "건너뜀"],
      ["최종 답변 준비", "pending", "대기"],
    ],
    stopped: "사용자가 중지함",
  },
} as const;

function items(context: ShowcaseRenderContext, count = 7) {
  return labels[context.locale].steps.slice(0, count).map(([title, state, statusLabel], index) => ({
    id: `step-${index}`,
    title,
    state: state as TodoProgressPanelItemState,
    statusLabel,
  }));
}

export const stories: ShowcaseStory[] = [
  {
    name: "Attached to the composer",
    widths: ["375", "app"],
    render: (context) => (
      <AttachedComposer context={context} adjunct={(
        <TodoProgressPanel heading={labels[context.locale].heading} ariaLabel={labels[context.locale].region} items={items(context, 3)} />
      )} />
    ),
  },
  {
    name: "Every state",
    render: (context) => (
      <TodoProgressPanel heading={labels[context.locale].heading} ariaLabel={labels[context.locale].region}
        items={[...items(context), { id: "stopped", title: labels[context.locale].stopped, state: "stopped", statusLabel: labels[context.locale].stopped }]} />
    ),
  },
];
