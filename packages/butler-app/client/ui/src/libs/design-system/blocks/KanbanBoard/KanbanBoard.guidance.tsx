import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { FileText } from "../../components/Icons";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { DocumentTile } from "../DocumentTile";
import { KanbanBoard, KanbanLane } from "./KanbanBoard";
import { KanbanCard } from "./KanbanCard";
import { KanbanDragScope } from "./KanbanDragScope";
import { applyKanbanMove } from "./kanbanDragModel";

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

// #region recipe: Drag between lanes
function DragLanes() {
  const [lanes, setLanes] = useState<Record<string, string[]>>({ todo: ["Login form", "Search"], doing: ["Settings"], done: [] });
  return (
    <KanbanDragScope onMove={(move) => setLanes((current) => applyKanbanMove(current, move))}>
      <KanbanBoard scroll>
        {Object.entries(lanes).map(([laneId, items]) => (
          <KanbanLane key={laneId} laneId={laneId} height="content" title={`${laneId} · ${items.length}`}>
            {items.map((title) => (
              <KanbanCard key={title} itemId={title} label={title} onOpen={() => undefined}>
                <Typo.Body>{title}</Typo.Body>
              </KanbanCard>
            ))}
          </KanbanLane>
        ))}
      </KanbanBoard>
    </KanbanDragScope>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "Lanes of cards side by side; inside a KanbanDragScope cards move within a lane, between lanes and between boards.",
  whenToUse: ["Plans or tasks grouped by status", "Items people move between statuses or groups by dragging (several boards on one page share one KanbanDragScope)"],
  whenNotToUse: [
    { when: "One list of documents", use: "CardList" },
    { when: "One ordered list people reorder", use: "SortableCardList" },
    { when: "Categories with a detail list", use: "SplitBrowser" },
  ],
  recipes: [
    { name: "Plan lanes", description: "One KanbanLane per status; lanes keep one height so the board stays level.", render: () => <PlanLanes /> },
    { name: "Scrolling status lanes", description: "`scroll`: more lanes than fit stay in one row at --kanban-lane-min-width and scroll sideways with an edge fade.", render: () => <ScrollingLanes /> },
    {
      name: "Drag between lanes",
      description: "KanbanDragScope around the boards, `laneId` on each KanbanLane, KanbanCard per item. `onMove` gets { itemId, fromLaneId, toLaneId, beforeItemId } (null = lane end): same lane = reorder, other lane = status change, other board = move to that group. applyKanbanMove applies it to lanes of ids.",
      render: () => <DragLanes />,
    },
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
    {
      do: { caption: "One KanbanDragScope around every board on the page; apply the move at once, persist it, and restore the order if saving fails (the card glides back).", render: () => <DragLanes /> },
      dont: { caption: "A scope per board: cards cannot cross to another section, and each board announces on its own.", render: () => <ScrollingLanes /> },
    },
  ],
  content: [
    "Lane titles are statuses (Draft, In progress); a count after a middle dot is fine (Review · 2).",
    "Pass `label` to KanbanCard (its title) and, for lanes with a non-text title, to KanbanLane; announcements use them.",
    "The product passes localized `labels` (KanbanDragLabels); English is the default.",
  ],
  accessibility: [
    "Each lane title precedes its cards in reading order.",
    "Cards are buttons: Enter or click opens, Space lifts; arrows move within the lane and to the lane beside, above or below (another board); Space drops, Escape cancels. Focus stays on the card after the drop.",
    "Pick-up, every keyboard step, the drop and a cancel are announced in a polite live region.",
    "Touch drags start with a long press, so swiping still scrolls the page and the boards.",
    "`canDrop` hides lanes that cannot take a card; keyboard moves skip them.",
  ],
  tokens: ["--kanban-lane-height", "--kanban-lane-min-width", "--kanban-lane-min-height", "--kanban-card-min-width", "--kanban-drop-line",
    "--shadow-drag-lift", "--motion-scale-lift", "--motion-base", "--motion-ease-emphasized", "--space-md", "--line", "--accent"],
};
