import type { ShowcaseGuidance } from "../../showcase";
import { InspectorPanel } from "../InspectorPanel";
import { KeyValueRow } from "../KeyValueRow";
import { TaskGraphDetail } from "./TaskGraphDetail";

// #region recipe: Selected task
function SelectedTask() {
  return (
    <TaskGraphDetail
      title="Research Notion" status="running" statusLabel="Running"
      facts={[{ id: "assignee", label: "Assignee", value: "Worker 3" }, { id: "time", label: "Time", value: "9m 01s" }]}
      relations={[{ id: "after", label: "After", emptyLabel: "None", tasks: [{ id: "brief", title: "Set comparison criteria" }] }]}
      onSelectTask={() => undefined}
      document={{ title: "Task document", meta: "TASK-R2 · Running", actionLabel: "Open", onOpen: () => undefined }}
      conversation={{ label: "View conversation", onOpen: () => undefined }}
    />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The selected task under its graph: status, facts, prerequisite links, the task document tile and the conversation action.",
  whenToUse: ["Under the TaskGraphSection that owns the selected task"],
  whenNotToUse: [
    { when: "Generic inspector facts", use: "InspectorPanel" },
    { when: "Reading the document itself", use: "DocumentReader" },
  ],
  recipes: [{ name: "Selected task", description: "Facts in order; links only move the selection; document and conversation open the caller's dialogs.", render: () => <SelectedTask /> }],
  doDont: [
    {
      do: { caption: "Pass facts, links, the document and the action; the block owns the layout.", render: () => <SelectedTask /> },
      dont: { caption: "Do not hand-build the panel from rows.", render: () => <InspectorPanel title="Research Notion"><KeyValueRow label="Assignee" value="Worker 3" /></InspectorPanel> },
    },
  ],
  content: [
    "Facts: Assignee, Model, Time, Now (TaskGraphStepLine while running). Notice: a short failure reason or \"An earlier task failed\"; no codes.",
    "Document meta: the task id and status. Conversation label: \"View conversation\" / \"대화 보기\".",
  ],
  accessibility: ["The conversation button has aria-haspopup=\"dialog\".", "Relation links are text buttons that change the selection in the graph; nothing is edited."],
  tokens: ["--surface-raised", "--radius-panel", "--space-md"],
};
