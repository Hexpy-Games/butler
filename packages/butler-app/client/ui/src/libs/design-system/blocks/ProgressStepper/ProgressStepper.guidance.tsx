import type { ShowcaseGuidance } from "../../showcase";
import { Typo } from "../../components/Typo";
import { ProgressStepper } from "./ProgressStepper";

// #region recipe: Setup steps
function SetupSteps() {
  return (
    <ProgressStepper ariaLabel="Setup steps" activeIndex={1} steps={[
      { id: "language", label: "Language" }, { id: "safety", label: "Safety" }, { id: "install", label: "Install" }, { id: "model", label: "Model" },
    ]} />
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A horizontal step indicator for linear flows: done, current and upcoming steps.",
  whenToUse: ["A setup or wizard with a fixed number of steps"],
  whenNotToUse: [
    { when: "A plan checklist during a turn", use: "TodoProgressPanel" },
    { when: "Page sections", use: "Tabs" },
  ],
  recipes: [{ name: "Setup steps", description: "activeIndex marks the current step; earlier ones read as done.", render: () => <SetupSteps /> }],
  doDont: [
    {
      do: { caption: "Short step names people can scan.", render: () => <SetupSteps /> },
      dont: { caption: "Step 2 of 4 alone hides what is left.", render: () => <Typo.Caption>Step 2 of 4</Typo.Caption> },
    },
  ],
  content: ["One word per step (Language, Safety, Install, Model)."],
  accessibility: ["ariaLabel names the list; the current step has aria-current=\"step\"."],
  tokens: ["--accent", "--line", "--space-sm"],
};
