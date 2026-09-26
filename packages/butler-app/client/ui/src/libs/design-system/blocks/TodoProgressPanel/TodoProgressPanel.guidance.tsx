import type { ShowcaseGuidance } from "../../showcase";
import { Typo } from "../../components/Typo";
import { TodoProgressPanel } from "./TodoProgressPanel";

// #region recipe: Plan steps above the composer
function PlanSteps() {
  return (
    <TodoProgressPanel heading="Steps" ariaLabel="Plan steps" items={[
      { id: "1", title: "Understand the request", state: "completed", statusLabel: "Done" },
      { id: "2", title: "Inspect the settings pages", state: "running", statusLabel: "Running" },
      { id: "3", title: "Prepare the final answer", state: "pending", statusLabel: "Pending" },
    ]} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The composer-attached plan checklist with a state and label per step.",
  whenToUse: ["A turn follows a plan with several steps"],
  whenNotToUse: [
    { when: "Workers", use: "WorkerActivityPanel" },
    { when: "A setup wizard", use: "SetupWizardShell" },
  ],
  recipes: [{ name: "Plan steps above the composer", description: "Every state has a label; do not rely on the icon alone.", render: () => <PlanSteps /> }],
  doDont: [
    {
      do: { caption: "Each step shows its state and label.", render: () => <PlanSteps /> },
      dont: { caption: "A paragraph of progress cannot be scanned.", render: () => <Typo.Body>Understood the request, inspecting the settings pages, answer pending.</Typo.Body> },
    },
  ],
  content: ["Step titles are short imperatives; long ones pass fullTitle for the tooltip."],
  accessibility: ["ariaLabel names the region; states include blocked, skipped and stopped with their own labels."],
  tokens: ["--color-success", "--color-warning", "--text-tertiary", "--composer-glass-bg"],
};
