import type { ShowcaseGuidance } from "../../showcase";
import { Card } from "../../components/Card";
import { Typo } from "../../components/Typo";
import { TaskGraphCard } from "./TaskGraphCard";

// #region recipe: Running task
function RunningTask() {
  return (
    <TaskGraphCard taskId="r2" title="Research Notion" status="running" statusLabel="Running"
      meta="Worker 3 · GPT-6 Luna" time="9m 01s" step="Reading the pricing page" opensDialog onActivate={() => undefined} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "One task in a task graph: status glyph, title, assignee and model, status tag with time, and the live step while running.",
  whenToUse: ["Every node of TaskGraphCanvas or TaskGraphLanes"],
  whenNotToUse: [
    { when: "A generic clickable item in a grid", use: "Card" },
    { when: "A plan step in a turn", use: "TodoProgressPanel" },
  ],
  recipes: [{ name: "Running task", description: "status=\"running\" draws Card activity, the spinner and the step line.", render: () => <RunningTask /> }],
  doDont: [
    {
      do: { caption: "Pass the status and its localized word; the card picks glyph, tag tone and activity.", render: () => <RunningTask /> },
      dont: { caption: "Do not rebuild the card from Card and Tag in product code.", render: () => <Card><Typo.Body>Research Notion</Typo.Body></Card> },
    },
  ],
  content: [
    "Title: the task, at most two lines. Meta: \"Worker 3 · GPT-6 Luna\" or \"Not assigned\". Time: elapsed while running, total when finished.",
    "Status words come from i18n (Waiting, Running, In review, Done, Failed, Blocked, Cancelled, Paused). Never internal names or codes.",
  ],
  accessibility: [
    "The card is a button (aria-pressed for selection, aria-haspopup when it opens the conversation dialog).",
    "The default accessible name joins title, status, meta and time; pass ariaLabel when meta is not text.",
    "The step line is polite live text; the glyph is decorative.",
  ],
  tokens: ["--worker-active", "--pulse-duration", "--motion-loop-count", "--selection", "--focus-ring"],
};
