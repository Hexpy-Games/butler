import type { ShowcaseGuidance } from "../../showcase";
import { TaskGraphCard } from "../TaskGraphCard";
import { TaskGraphCanvas } from "./TaskGraphCanvas";

const NODES = [{ id: "a", status: "done" as const }, { id: "b", status: "running" as const }, { id: "c", status: "pending" as const }];
const EDGES = [{ from: "a", to: "b" }, { from: "b", to: "c" }];
const TITLES: Record<string, string> = { a: "Scan the folder", b: "Sort the files", c: "Report back" };
const STATUS: Record<string, string> = { a: "Done", b: "Running", c: "Waiting" };

// #region recipe: Graph with cards
function GraphWithCards() {
  return (
    <TaskGraphCanvas
      nodes={NODES}
      edges={EDGES}
      label="Task graph"
      orientation="horizontal"
      renderNode={(id) => (
        <TaskGraphCard taskId={id} title={TITLES[id]!} status={NODES.find((node) => node.id === id)!.status} statusLabel={STATUS[id]!} />
      )}
    />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A read-only task DAG: ranked columns left to right on desktop and lanes top to bottom on phones, with prerequisite edges.",
  whenToUse: ["The Tasks tab: one plan's tasks and their prerequisites", "Any read-only dependency view of a few to a few hundred tasks"],
  whenNotToUse: [
    { when: "A flat list of steps for one turn", use: "TodoProgressPanel" },
    { when: "Items grouped by status", use: "KanbanBoard" },
    { when: "Reordering by drag", use: "SortableCardList" },
  ],
  recipes: [{ name: "Graph with cards", description: "Pass node ids with statuses and edges; renderNode returns a TaskGraphCard.", render: () => <GraphWithCards /> }],
  doDont: [
    {
      do: { caption: "Render TaskGraphCards and let the canvas lay them out.", render: () => <GraphWithCards /> },
      dont: { caption: "Do not position cards yourself or make the graph editable; it is read-only.", render: () => <TaskGraphCard taskId="x" title="Dragged card" status="pending" statusLabel="Waiting" /> },
    },
  ],
  content: [
    "Copy comes from the caller: card titles, status words and the group label. No internal names.",
    "Edges: solid when the prerequisite is done, dashed while waiting, red dashed from a failed or cancelled task, green into a running task.",
  ],
  accessibility: [
    "The graph is a labelled group; each card is a focusable button.",
    "Arrow keys move focus and selection: right/left follow edges, up/down stay in the column (phones: up/down by row).",
    "Edges are decorative (aria-hidden); relations are spelled out in TaskGraphDetail.",
  ],
  tokens: ["--line-strong", "--danger", "--worker-active", "--space-4xl", "--space-md", "--scroll-fade-size"],
};
