import type { ShowcaseGuidance } from "../../showcase";
import { TaskGraphCard } from "../TaskGraphCard";
import { TaskGraphLanes } from "./TaskGraphLanes";

const NODES = [
  { id: "s", status: "done" as const }, { id: "x", status: "running" as const },
  { id: "y", status: "done" as const }, { id: "j", status: "pending" as const },
];
const EDGES = [{ from: "s", to: "x" }, { from: "s", to: "y" }, { from: "x", to: "j" }, { from: "y", to: "j" }];

// #region recipe: Fan-out on a phone
function FanOut() {
  return (
    <TaskGraphLanes nodes={NODES} edges={EDGES} label="Task graph"
      renderNode={(id) => <TaskGraphCard taskId={id} title={`Task ${id.toUpperCase()}`} status={NODES.find((node) => node.id === id)!.status} statusLabel="Status" />} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The phone layout of a task graph: full-width cards top to bottom with a lane gutter for fan-out and join.",
  whenToUse: ["Compact widths; TaskGraphCanvas renders it for you with orientation=\"auto\""],
  whenNotToUse: [
    { when: "Desktop and tablet widths", use: "TaskGraphCanvas" },
    { when: "A plain list of steps", use: "ActivityFeed" },
  ],
  recipes: [{ name: "Fan-out on a phone", description: "Same props as TaskGraphCanvas; lanes open per branch and close at the join.", render: () => <FanOut /> }],
  doDont: [
    {
      do: { caption: "Use TaskGraphCanvas (auto) so desktop and phone stay one component.", render: () => <FanOut /> },
      dont: { caption: "Do not squeeze the left-to-right canvas into a phone.", render: () => <FanOut /> },
    },
  ],
  content: ["Rows are in rank order; parallel tasks follow their shared predecessor. Copy comes from the cards."],
  accessibility: ["Up/Down move focus and selection row by row.", "The gutter is decorative; relations are spelled out in TaskGraphDetail."],
  tokens: ["--line-strong", "--worker-active", "--danger", "--color-warning", "--space-sm"],
};
