import type { ShowcaseGuidance } from "../../showcase";
import { DisclosureRow } from "../DisclosureRow";
import { TaskGraphPanel, TaskGraphSection } from "./TaskGraphSection";
import { Typo } from "../../components/Typo";

// #region recipe: Tasks tab with two graphs
function TwoGraphs() {
  return (
    <TaskGraphPanel title="Task graph" headerMeta="2 graphs · 1 running" emptyLabel="No tasks yet">
      <TaskGraphSection graphId="notes" title="Compare three note apps" status="running" meta="2/6 done" open onToggle={() => undefined}>
        <Typo.Caption>TaskGraphCanvas and TaskGraphDetail go here.</Typo.Caption>
      </TaskGraphSection>
      <TaskGraphSection graphId="downloads" title="Tidy the Downloads folder" status="done" meta="3/3 done" open={false} onToggle={() => undefined}>
        <Typo.Caption>Folded.</Typo.Caption>
      </TaskGraphSection>
    </TaskGraphPanel>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The Tasks tab body: TaskGraphPanel (header, summary, empty state) and one collapsible TaskGraphSection per plan graph.",
  whenToUse: ["A conversation with one or more task graphs at once (one per plan)"],
  whenNotToUse: [
    { when: "Any other expandable row", use: "DisclosureRow" },
    { when: "A titled group of facts", use: "InspectorPanel" },
  ],
  recipes: [{ name: "Tasks tab with two graphs", description: "Order running, failed, waiting, done, cancelled; open running and failed graphs.", render: () => <TwoGraphs /> }],
  doDont: [
    {
      do: { caption: "Put the graph in the section's children; it sits below the row on the inspector inset.", render: () => <TwoGraphs /> },
      dont: { caption: "Do not pass the graph as DisclosureRow children; it indents the cards to the title column.", render: () => <DisclosureRow title="Compare three note apps" open onToggle={() => undefined}><Typo.Caption>Indented graph</Typo.Caption></DisclosureRow> },
    },
  ],
  content: [
    "Row: the plan goal, a rolled-up status glyph (rollupTaskGraphStatus) and counts (\"7/16 done · 1 failed\").",
    "Header summary: one graph's counts, or \"6 graphs · 2 running\". With one graph pass collapsible={false} and the goal as description.",
  ],
  accessibility: ["Rows are buttons with aria-expanded and aria-controls pointing at the graph region.", "Open/fold state is the caller's, in memory only."],
  tokens: ["--selection", "--space-xs", "--space-sm", "--space-lg"],
};
