import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { FileText } from "../../components/Icons";
import { DocumentTile } from "../DocumentTile";
import { EmptyLine } from "../EmptyLine";
import { KanbanBoard, KanbanLane } from "./KanbanBoard";

export const meta: ShowcaseMeta = {
  title: "KanbanBoard",
  category: "Documents & Artifacts",
  tags: ["kanban", "board", "lanes", "plans"],
  status: "beta",
};

const labels = {
  "en-US": { lanes: ["Draft", "In progress", "Review", "Done"], open: "Open", empty: "No plans", plans: ["Ship composer Plan mode", "Settings hierarchy", "DS Viewer states"] },
  "ko-KR": { lanes: ["초안", "진행 중", "검토", "완료"], open: "열기", empty: "계획 없음", plans: ["작성기 계획 모드", "설정 구조", "DS 뷰어 상태"] },
} as const;

function Board({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  return (
    <KanbanBoard>
      {copy.lanes.map((lane, index) => (
        <KanbanLane key={lane} title={lane}>
          {index < copy.plans.length
            ? <DocumentTile icon={<FileText size="md" />} title={copy.plans[index]!} meta="plan" actionLabel={copy.open} onOpen={() => undefined} />
            : <EmptyLine message={copy.empty} />}
        </KanbanLane>
      ))}
    </KanbanBoard>
  );
}

export const stories: ShowcaseStory[] = [{ name: "Plan board", widths: ["app", "wide"], render: (context) => <Board context={context} /> }];
