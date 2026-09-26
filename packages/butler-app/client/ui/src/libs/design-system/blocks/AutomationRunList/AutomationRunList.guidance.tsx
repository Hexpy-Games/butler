import type { ShowcaseGuidance } from "../../showcase";
import { CheckIcon, CircleX } from "../../components/Icons";
import { ActivityFeed } from "../ActivityFeed";
import { AutomationRunList } from "./AutomationRunList";

// #region recipe: Recent runs
function RecentRuns() {
  return (
    <AutomationRunList title="Runs" emptyLabel="No runs yet." runs={[
      { id: "2", icon: <CheckIcon size="md" />, title: "Completed", description: "Brief generated", meta: "today" },
      { id: "1", icon: <CircleX size="md" />, title: "Failed", description: "Model provider timed out", meta: "yesterday" },
    ]} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The run history of an automation, newest first, with state icons aligned to titles.",
  whenToUse: ["Show recent runs on an automation detail page"],
  whenNotToUse: [
    { when: "General activity", use: "ActivityFeed" },
    { when: "The automation itself", use: "AutomationRow" },
  ],
  recipes: [{ name: "Recent runs", description: "Pass state icons so success and failure scan at a glance.", render: () => <RecentRuns /> }],
  doDont: [
    {
      do: { caption: "State icon, state word, result and time.", render: () => <RecentRuns /> },
      dont: { caption: "A generic feed loses the run semantics and empty label.", render: () => <ActivityFeed items={[{ id: "1", title: "Something happened" }]} /> },
    },
  ],
  content: ["Titles are states (Completed, Failed); descriptions say the result or the error."],
  accessibility: ["A list with a heading; icons are decorative."],
  tokens: ["--color-success", "--color-danger", "--icon-size-md"],
};
