import type { ShowcaseMeta, ShowcaseRenderContext, ShowcaseStory } from "../../showcase";
import { FileText } from "../../components/Icons";
import { DocumentTile } from "../DocumentTile";
import { EmptyLine } from "../EmptyLine";
import { Box } from "../../components/Box";
import { Section } from "../../components/Section";
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

// ProjectWorkBoard: six status lanes stay in one row and scroll sideways at narrow widths.
function ScrollingBoard({ context }: { context: ShowcaseRenderContext }) {
  const copy = labels[context.locale];
  return (
    <KanbanBoard scroll>
      {[...copy.lanes, ...copy.lanes.slice(0, 2)].map((lane, index) => (
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
  { name: "Scrolling lanes", widths: ["375", "app"], render: (context) => <ScrollingBoard context={context} /> },
];
