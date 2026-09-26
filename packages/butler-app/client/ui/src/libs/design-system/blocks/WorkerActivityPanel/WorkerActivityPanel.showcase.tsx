import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { AttachedComposer } from "../../showcase/support/AttachedComposer";
import { WorkerActivityPanel } from "./WorkerActivityPanel";

export const meta: ShowcaseMeta = {
  title: "WorkerActivityPanel",
  category: "Conversation & Activity",
  tags: ["composer", "workers", "adjunct", "activity"],
  status: "stable",
};

const labels = {
  "en-US": {
    heading: "Workers", summary: "Worker 1 Executing: Reading project files and 1 more", rail: "Worker phase",
    workers: [
      { title: "Worker 1", description: "Reading project files and extracting implementation notes.", meta: "Executing", phase: "executing" },
      { title: "Worker 2", description: "Reviewing the gathered evidence.", meta: "Verifying", phase: "verifying", depth: 1 },
      { title: "Worker 3", description: "Wrote the migration plan.", meta: "Complete", phase: "complete" },
    ],
  },
  "ko-KR": {
    heading: "Worker", summary: "Worker 1 실행 중: 프로젝트 파일 읽는 중 외 1개", rail: "Worker 단계",
    workers: [
      { title: "Worker 1", description: "프로젝트 파일을 읽고 구현 메모를 뽑는 중입니다.", meta: "실행 중", phase: "executing" },
      { title: "Worker 2", description: "모은 근거를 검토하는 중입니다.", meta: "검증 중", phase: "verifying", depth: 1 },
      { title: "Worker 3", description: "마이그레이션 계획을 작성했습니다.", meta: "완료", phase: "complete" },
    ],
  },
} as const;

function items(context: ShowcaseRenderContext, count = 3) {
  const copy = labels[context.locale];
  return copy.workers.slice(0, count).map((worker, index) => ({
    id: `worker-${index + 1}`,
    title: worker.title,
    description: worker.description,
    meta: worker.meta,
    phase: worker.phase,
    phaseRailLabel: copy.rail,
    depth: "depth" in worker ? worker.depth : undefined,
  }));
}

export const stories: ShowcaseStory[] = [
  {
    // WorkerComposerPanel: attached above the composer with a collapsed one-line summary.
    name: "Attached to the composer",
    widths: ["375", "app"],
    render: (context) => (
      <AttachedComposer context={context} adjunct={(
        <WorkerActivityPanel heading={labels[context.locale].heading} collapsedSummary={labels[context.locale].summary} items={items(context, 2)} />
      )} />
    ),
  },
  {
    name: "Standalone with a finished worker",
    render: (context) => (
      <WorkerActivityPanel heading={labels[context.locale].heading} collapsedSummary={labels[context.locale].summary} items={items(context)} />
    ),
  },
];
