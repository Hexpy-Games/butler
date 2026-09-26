import type { ShowcaseGuidance } from "../../showcase";
import { FileText } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { DocumentTile } from "../DocumentTile";
import { KanbanBoard, KanbanLane } from "./KanbanBoard";

// #region recipe: Plan lanes
function PlanLanes() {
  return (
    <KanbanBoard>
      {["Draft", "In progress", "Review", "Done"].map((lane) => (
        <KanbanLane key={lane} title={lane}>
          <DocumentTile icon={<FileText size="md" />} title={`${lane} plan`} meta="plan" actionLabel="Open" onOpen={() => undefined} />
        </KanbanLane>
      ))}
    </KanbanBoard>
  );
}
// #endregion

// #region recipe: Scrolling status lanes
function ScrollingLanes() {
  return (
    <KanbanBoard scroll>
      {["Planned", "Active", "Review", "Blocked", "Done", "Other"].map((lane) => (
        <KanbanLane key={lane} title={lane}>
          <DocumentTile icon={<FileText size="md" />} title={`${lane} work`} meta="work" actionLabel="Open" onOpen={() => undefined} />
        </KanbanLane>
      ))}
    </KanbanBoard>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Lanes of documents side by side; each lane scrolls at a fixed height under its title.",
  whenToUse: ["Plans or tasks grouped by status"],
  whenNotToUse: [
    { when: "One list of documents", use: "CardList" },
    { when: "Categories with a detail list", use: "SplitBrowser" },
  ],
  recipes: [
    { name: "Plan lanes", description: "One KanbanLane per status; lanes keep one height so the board stays level.", render: () => <PlanLanes /> },
    { name: "Scrolling status lanes", description: "`scroll`: more lanes than fit stay in one row at --kanban-lane-min-width and scroll sideways with an edge fade.", render: () => <ScrollingLanes /> },
  ],
  doDont: [
    {
      do: { caption: "Lanes share one height and scroll inside.", render: () => <PlanLanes /> },
      dont: { caption: "Stacked sections lose the side-by-side status view.", render: () => <Stack gap="md"><DocumentTile icon={<FileText size="md" />} title="Draft plan" meta="plan" actionLabel="Open" onOpen={() => undefined} /></Stack> },
    },
    {
      do: { caption: "Six lanes: `scroll` keeps them in one row that scrolls sideways.", render: () => <ScrollingLanes /> },
      dont: { caption: "A hand-built grid with its own overflow and fade drifts from the board.", render: () => <PlanLanes /> },
    },
  ],
  content: ["Lane titles are statuses (Draft, In progress)."],
  accessibility: ["Each lane title precedes its cards in reading order."],
  tokens: ["--kanban-lane-height", "--kanban-lane-min-width", "--space-md", "--line"],
};
