import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { ListRow } from "../ListRow";
import { AutomationRow } from "./AutomationRow";

// #region recipe: Scheduled automation with a run action
function MorningBrief() {
  return (
    <AutomationRow title="Morning brief" description="Summarize active work" schedule="Weekdays 08:00"
      automationTone="active" automationLabel="Active" actions={<Button size="xs" variant="borderless" text="Run" />} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "An automation row with schedule, a status tone and actions.",
  whenToUse: ["List automations with their state and a quick action"],
  whenNotToUse: [
    { when: "Past runs of one automation", use: "AutomationRunList" },
    { when: "A plain selectable list (the automations page uses ListRow today)", use: "ListRow" },
  ],
  recipes: [{ name: "Scheduled automation with a run action", description: "automationTone colors the status; automationLabel says it in words.", render: () => <MorningBrief /> }],
  doDont: [
    {
      do: { caption: "Status in words and tone.", render: () => <MorningBrief /> },
      dont: { caption: "Packing state into meta text hides the status.", render: () => <ListRow title="Morning brief" meta="active / Weekdays 08:00" /> },
    },
  ],
  content: ["Schedules read naturally (Weekdays 08:00 / 평일 08:00)."],
  accessibility: ["Status is text, not only the colored dot."],
  tokens: ["--color-success", "--color-warning", "--color-danger", "--space-sm"],
};
