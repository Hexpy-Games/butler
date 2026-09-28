import type { ShowcaseGuidance } from "../../showcase";
import { Button } from "../../components/Button";
import { Typo } from "../../components/Typo";
import { SetupWizardContent, SetupWizardList, SetupWizardShell } from "./index";

const STEPS = [{ id: "language", label: "Language" }, { id: "safety", label: "Safety" }, { id: "model", label: "Model" }];

// #region recipe: First-run step
function FirstRunStep() {
  return (
    <SetupWizardShell embedded activeIndex={1} steps={STEPS} title="Choose how Butler asks before acting" progressLabel="Setup steps">
      <SetupWizardContent>
        <SetupWizardList>
          <Button variant="outline" text="Ask first" />
          <Button variant="outline" text="Full access" />
        </SetupWizardList>
      </SetupWizardContent>
    </SetupWizardShell>
  );
}
// #endregion

// #region recipe: Focus screen
function FocusScreen() {
  return (
    <SetupWizardShell embedded title="Butler" variant="focus">
      <SetupWizardContent width="wide">
        <Typo.H3 as="h1">Which AI should Butler use?</Typo.H3>
        <Button variant="outline" text="ChatGPT" />
      </SetupWizardContent>
    </SetupWizardShell>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "The first-run setup frame: step progress, a large title and centered content, or one focused column (variant focus).",
  whenToUse: ["A multi-step setup or onboarding flow outside the app shell", "A short onboarding of one or two screens with no stepper"],
  whenNotToUse: [
    { when: "A settings page", use: "SettingsShell" },
    { when: "A short task in the app", use: "DialogForm" },
  ],
  recipes: [
    { name: "First-run step", description: "embedded renders it inside a page; the app shows it full-window.", render: () => <FirstRunStep /> },
    { name: "Focus screen", description: "variant=\"focus\": no title or stepper, one centered column (420px, wide 520px).", render: () => <FocusScreen /> },
  ],
  doDont: [
    {
      do: { caption: "One decision per step with the progress visible.", render: () => <FirstRunStep /> },
      dont: { caption: "Every setting on one screen overwhelms a first run.", render: () => <Typo.Body>Language, safety, model, keys and theme on one page</Typo.Body> },
    },
  ],
  content: ["Titles are questions or instructions; buttons are the answers."],
  accessibility: ["The step progress is labelled (progressLabel) and announces the current step."],
  tokens: ["--typo-new-chat-title-size-md", "--page-max-width-narrow", "--space-2xl"],
};
