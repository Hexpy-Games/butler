import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { FileText } from "../../components/Icons";
import { DocumentTile } from "../DocumentTile";
import { EmptyLine } from "../EmptyLine";
import { Box } from "../../components/Box";
import { Section } from "../../components/Section";
import { KanbanBoard, KanbanLane } from "./KanbanBoard";
import { DraggableBoards } from "./KanbanBoard.demo";

export const meta: ShowcaseMeta = {
  title: "KanbanBoard",
  category: "Documents & Artifacts",
  tags: ["kanban", "board", "lanes", "plans", "drag", "reorder", "dnd-kit", "motion"],
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

// ProjectWorkBoard: eight status lanes stay in one row and overflow at every width; hover the
// board (or Tab into it) to show the horizontal scrollbar under the lanes.
function ScrollingBoard({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  return (
    <KanbanBoard scroll>
      {[...copy.lanes, ...copy.lanes].map((lane, index) => (
        <Box key={`${lane}-${index}`} surface="base" border="hairline" radius="control" padding="md" alignSelf="start">
          <Section title={lane}>
            <DocumentTile icon={<FileText size="md" />} title={copy.plans[index % copy.plans.length]!} meta="plan" actionLabel={copy.open} onOpen={() => undefined} />
          </Section>
        </Box>
      ))}
    </KanbanBoard>
  );
}

export const stories: ShowcaseStory[] = [
  { name: "Plan board", widths: ["app", "wide"], render: (context) => <Board context={context} /> },
  { name: "Scrolling lanes (scrollbar on hover)", widths: ["375", "app", "wide"], render: (context) => <ScrollingBoard context={context} /> },
  // KanbanDragScope: one wide grid lane and two boards of five lanes; a card lifts, a slot opens with
  // the drop line, the target lane tints, and the cards glide into place on drop.
  { name: "Drag between lanes and boards", states: ["drag"], widths: ["375", "app", "wide"], render: (context) => <DraggableBoards context={context} /> },
];
