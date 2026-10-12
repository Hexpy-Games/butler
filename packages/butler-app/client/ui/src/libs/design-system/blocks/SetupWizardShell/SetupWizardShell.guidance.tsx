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
      <SetupWizardContent width="wide" surface="solid">
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
    { name: "Focus screen", description: "variant=\"focus\": no title or stepper, one opaque card with a shared inset (420px, wide 520px).", render: () => <FocusScreen /> },
  ],
  doDont: [
    {
      do: { caption: "One decision per step with the progress visible.", render: () => <FirstRunStep /> },
      dont: { caption: "Every setting on one screen overwhelms a first run.", render: () => <Typo.Body>Language, safety, model, keys and theme on one page</Typo.Body> },
    },
  ],
  content: [
    "Titles are questions or instructions; buttons are the answers.",
    "A multi-screen focus flow uses anchor=\"top\" so every card shares one top edge (20% of the window, clamped), and one stepKey per step so every step change, forward or back, morphs the card (420 and 520px, or steps of different heights).",
    "A status that appears later (a download, a check) lives inside one row that is there from the first render, so it enters with the card and then updates in place.",
    "First install passes intro=\"full\" and puts SetupWizardMark in the welcome card: the backdrop writes the mark, which lands in that slot; the mark then stays still while Butler prepares.",
    "\"설정 다시 실행\" passes intro=\"rerun\": the dried print shows still and only the card appears (220ms fade and 4px rise).",
  ],
  accessibility: [
    "The step progress is labelled (progressLabel) and announces the current step.",
    "After a card morph the new card owns focus: the step title going forward, the previous control going back. Clicks during the morph are ignored.",
    "Reduced motion swaps the cards and shows the re-run card at once; the ink intro becomes one still print and a 160ms card fade.",
    "The ink intro can be skipped with any click or key; the card takes no input while the reveal runs.",
  ],
  tokens: ["--titlebar-height", "--motion-deliberate", "--motion-ease-emphasized", "--motion-morph-rows", "--motion-stagger-row", "--motion-slow", "--motion-base", "--motion-exit-base", "--motion-exit-fast", "--motion-distance-sm", "--motion-stagger-intro", "--motion-intro-draw", "--motion-intro-print", "--butler-mark-ink", "--riso-paper", "--typo-new-chat-title-size-md", "--page-max-width-narrow", "--space-2xl", "--space-lg", "--color-surface-raised-opaque"],
};
